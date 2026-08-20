import { createMarketData } from './normalize';
import { detectMarketSiteFromHost } from './sites';
import { getAnalysisConfigError } from '../config';
import { MIN_ANALYSIS_CANDLES } from '../model/types';
import type { AnalysisPeriod, MarketData, UserConfig } from '../model/types';
import { message, type LocalizedMessage } from '../../shared/i18n-types';
import { abortReason, delayWithSignal, throwIfAborted } from '../../shared/cancellation';

export type ActiveMarketRequest = {
  siteId: 'binance' | 'tonghuashun';
  symbol: string;
  period: AnalysisPeriod;
  url: string;
  adapterId: string;
};

export type MarketTimeRange = { startTime: number; endTime: number };

const THS_PERIOD_CODES: Record<AnalysisPeriod, string> = {
  '30m': '41',
  '1h': '51',
  // A 股连续竞价每天四小时；同花顺日聚合与 4h OHLCV 边界一致。
  '4h': '71',
  '1d': '01',
  '1w': '11',
  '1M': '21',
};
const ACTIVE_MARKET_TIMEOUT_MS = 10_000;
export const ACTIVE_MARKET_MAX_RETRIES = 5;
export const ACTIVE_MARKET_RETRY_DELAY_MS = 200;

const waitForRetry = (signal?: AbortSignal) =>
  delayWithSignal(ACTIVE_MARKET_RETRY_DELAY_MS, signal);

const isRetryableHttpStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

export class ActiveMarketDataError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: LocalizedMessage,
  ) {
    super(code);
    this.name = 'ActiveMarketDataError';
  }
}

type ActiveSite = ActiveMarketRequest['siteId'];
type RequestBuilder = (
  pageUrl: URL,
  config: UserConfig,
  range?: MarketTimeRange,
) => ActiveMarketRequest;

export function createActiveMarketRequest(
  pageUrl: string,
  config: UserConfig,
  range?: MarketTimeRange,
): ActiveMarketRequest | undefined {
  const configError = getAnalysisConfigError(config);
  if (configError) throw new ActiveMarketDataError('E_ANALYSIS_CONFIG_INVALID', configError);
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new ActiveMarketDataError('E_PAGE_URL_INVALID', message('error_page_url_invalid'));
  }
  const site = detectMarketSiteFromHost(url.hostname);
  return site === 'binance' || site === 'tonghuashun'
    ? ACTIVE_REQUEST_BUILDERS[site](url, config, range)
    : undefined;
}

const ACTIVE_REQUEST_BUILDERS: Record<ActiveSite, RequestBuilder> = {
  binance: (pageUrl, config, range) => {
    const tradeSegment = pageUrl.pathname.match(
      /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?trade\/([^/]+)/i,
    )?.[1];
    const symbol = tradeSegment?.replace(/[_-]/g, '').toUpperCase();
    if (!symbol || !/^[A-Z0-9]+$/.test(symbol))
      throw new ActiveMarketDataError(
        'E_SYMBOL_UNRECOGNIZED',
        message('error_binance_symbol_unrecognized'),
      );
    const requestUrl = new URL('https://data-api.binance.vision/api/v3/klines');
    requestUrl.searchParams.set('symbol', symbol);
    requestUrl.searchParams.set('interval', config.analysisPeriod);
    requestUrl.searchParams.set('limit', String(config.analysisCandleCount));
    if (range) {
      requestUrl.searchParams.set('startTime', String(Math.trunc(range.startTime)));
      requestUrl.searchParams.set('endTime', String(Math.trunc(range.endTime)));
    }
    return {
      siteId: 'binance',
      symbol,
      period: config.analysisPeriod,
      url: requestUrl.toString(),
      adapterId: 'binance-rest-klines',
    };
  },
  tonghuashun: (pageUrl, config) => {
    const symbol = pageUrl.pathname.match(/^\/(\d{6})(?:\/|$)/)?.[1];
    if (!symbol)
      throw new ActiveMarketDataError(
        'E_SYMBOL_UNRECOGNIZED',
        message('error_tonghuashun_symbol_unrecognized'),
      );
    const periodCode = THS_PERIOD_CODES[config.analysisPeriod];
    return {
      siteId: 'tonghuashun',
      symbol,
      period: config.analysisPeriod,
      url: `https://d.10jqka.com.cn/v6/line/hs_${symbol}/${periodCode}/last${config.analysisCandleCount}.js`,
      adapterId: 'tonghuashun-line-jsonp',
    };
  },
};

export async function fetchActiveMarketData(
  pageUrl: string,
  config: UserConfig,
  fetcher: typeof fetch = fetch,
  range?: MarketTimeRange,
  signal?: AbortSignal,
): Promise<MarketData | undefined> {
  throwIfAborted(signal);
  const request = createActiveMarketRequest(pageUrl, config, range);
  if (!request) return undefined;

  const response = await fetchActiveResponse(request, fetcher, signal);

  let raw: unknown[];
  try {
    raw = await ACTIVE_RESPONSE_PARSERS[request.siteId](response);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
  throwIfAborted(signal);

  return createMarketData(
    raw,
    request.url,
    request.siteId,
    request.symbol,
    request.period,
    MIN_ANALYSIS_CANDLES,
    request.adapterId,
  );
}

async function fetchActiveResponse(
  request: ActiveMarketRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  for (let retryCount = 0; retryCount <= ACTIVE_MARKET_MAX_RETRIES; retryCount += 1) {
    throwIfAborted(signal);
    let response: Response;
    try {
      // 严格等待当前请求结束后再判断结果，避免超时、重试定时器和后续请求并发堆积。
      const timeoutSignal = AbortSignal.timeout(ACTIVE_MARKET_TIMEOUT_MS);
      response = await fetcher(request.url, {
        method: 'GET',
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (retryCount < ACTIVE_MARKET_MAX_RETRIES) {
        await waitForRetry(signal);
        continue;
      }
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new ActiveMarketDataError(
        'E_ACTIVE_MARKET_REQUEST_FAILED',
        timedOut
          ? message('error_market_request_timeout')
          : message(
              request.siteId === 'binance'
                ? 'error_binance_market_request_failed'
                : 'error_tonghuashun_market_request_failed',
            ),
      );
    }

    if (response.ok) return response;
    try {
      await response.body?.cancel();
    } catch {
      // HTTP 状态已足以决定重试；关闭失败响应体本身的异常不覆盖原始状态。
    }
    if (!isRetryableHttpStatus(response.status) || retryCount === ACTIVE_MARKET_MAX_RETRIES)
      throw new ActiveMarketDataError(
        'E_ACTIVE_MARKET_HTTP_ERROR',
        message('error_market_http', [response.status]),
      );
    await waitForRetry(signal);
  }

  throw new ActiveMarketDataError(
    'E_ACTIVE_MARKET_REQUEST_FAILED',
    message(
      request.siteId === 'binance'
        ? 'error_binance_market_request_failed'
        : 'error_tonghuashun_market_request_failed',
    ),
  );
}

const ACTIVE_RESPONSE_PARSERS: Record<ActiveSite, (response: Response) => Promise<unknown[]>> = {
  binance: parseBinanceResponse,
  tonghuashun: async (response) => parseTonghuashunResponse(await response.text()),
};

async function parseBinanceResponse(response: Response): Promise<unknown[]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ActiveMarketDataError(
      'E_ACTIVE_MARKET_RESPONSE_INVALID',
      message('error_binance_response_parse'),
    );
  }
  if (!Array.isArray(payload))
    throw new ActiveMarketDataError(
      'E_ACTIVE_MARKET_RESPONSE_INVALID',
      message('error_binance_response_format'),
    );
  return payload;
}

export function parseTonghuashunResponse(text: string): unknown[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new ActiveMarketDataError(
      'E_ACTIVE_MARKET_RESPONSE_INVALID',
      message('error_tonghuashun_response_format'),
    );

  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ActiveMarketDataError(
      'E_ACTIVE_MARKET_RESPONSE_INVALID',
      message('error_tonghuashun_response_parse'),
    );
  }
  const data = (payload as { data?: unknown })?.data;
  if (typeof data !== 'string')
    throw new ActiveMarketDataError(
      'E_ACTIVE_MARKET_RESPONSE_INVALID',
      message('error_tonghuashun_response_missing_candles'),
    );

  return data
    .split(';')
    .filter(Boolean)
    .map((line) => {
      const [date, open, high, low, close, volume] = line.split(',');
      return [parseTonghuashunDate(date), open, high, low, close, volume];
    });
}

function parseTonghuashunDate(value: string): number {
  if (!/^\d{8}(?:\d{4})?$/.test(value)) return Number.NaN;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = value.length === 12 ? Number(value.slice(8, 10)) : 0;
  const minute = value.length === 12 ? Number(value.slice(10, 12)) : 0;
  const chinaOffset = value.length === 12 ? 8 * 60 * 60 * 1000 : 0;
  const result = Date.UTC(year, month - 1, day, hour, minute) - chinaOffset;
  const parsed = new Date(result + chinaOffset);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute
    ? result
    : Number.NaN;
}
