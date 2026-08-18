import { createMarketData } from './normalize';
import { detectMarketSiteFromHost } from './sites';
import { getAnalysisConfigError } from '../config';
import { MIN_ANALYSIS_CANDLES } from '../model/types';
import type { AnalysisPeriod, MarketData, UserConfig } from '../model/types';
import { message, type LocalizedMessage } from '../../shared/i18n-types';

export type ActiveMarketRequest = {
  siteId: 'binance' | 'tonghuashun';
  symbol: string;
  period: AnalysisPeriod;
  url: string;
  adapterId: string;
};

const THS_PERIOD_CODES: Record<AnalysisPeriod, string> = {
  '1d': '01',
  '1w': '11',
  '1M': '21',
};
const ACTIVE_MARKET_TIMEOUT_MS = 10_000;

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
type RequestBuilder = (pageUrl: URL, config: UserConfig) => ActiveMarketRequest;

export function createActiveMarketRequest(
  pageUrl: string,
  config: UserConfig,
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
    ? ACTIVE_REQUEST_BUILDERS[site](url, config)
    : undefined;
}

const ACTIVE_REQUEST_BUILDERS: Record<ActiveSite, RequestBuilder> = {
  binance: (pageUrl, config) => {
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
): Promise<MarketData | undefined> {
  const request = createActiveMarketRequest(pageUrl, config);
  if (!request) return undefined;

  let response: Response;
  try {
    response = await fetcher(request.url, {
      method: 'GET',
      credentials: 'omit',
      signal: AbortSignal.timeout(ACTIVE_MARKET_TIMEOUT_MS),
    });
  } catch (error) {
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
  if (!response.ok)
    throw new ActiveMarketDataError(
      'E_ACTIVE_MARKET_HTTP_ERROR',
      message('error_market_http', [response.status]),
    );

  const raw = await ACTIVE_RESPONSE_PARSERS[request.siteId](response);

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
  if (!/^\d{8}$/.test(value)) return Number.NaN;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const result = Date.UTC(year, month - 1, day);
  const parsed = new Date(result);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? result
    : Number.NaN;
}
