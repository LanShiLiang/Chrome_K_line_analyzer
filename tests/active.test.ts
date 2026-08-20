import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_MARKET_MAX_RETRIES,
  ACTIVE_MARKET_RETRY_DELAY_MS,
  createActiveMarketRequest,
  fetchActiveMarketData,
  parseTonghuashunResponse,
} from '../src/core/adapter/active';
import { detectMarketSite } from '../src/core/adapter/sites';
import { DEFAULT_CONFIG } from '../src/core/model/types';

describe('active market adapters', () => {
  it('detects only the three supported page families', () => {
    expect(detectMarketSite('https://www.binance.com/en/trade/BTC_USDT?type=spot')).toBe('binance');
    expect(detectMarketSite('https://stockpage.10jqka.com.cn/600487/')).toBe('tonghuashun');
    expect(detectMarketSite('https://www.tradingview.com/chart/?symbol=NVDA')).toBe('tradingview');
    expect(detectMarketSite('https://example.com/chart')).toBe('unsupported');
  });

  it('returns a domain error for malformed page URLs and strategy settings', () => {
    expect(() => createActiveMarketRequest('not a url', DEFAULT_CONFIG)).toThrowError(
      expect.objectContaining({ code: 'E_PAGE_URL_INVALID' }),
    );
    expect(() =>
      createActiveMarketRequest('https://www.binance.com/en/trade/BTC_USDT', {
        ...DEFAULT_CONFIG,
        analysisCandleCount: 4,
      }),
    ).toThrowError(expect.objectContaining({ code: 'E_ANALYSIS_CONFIG_INVALID' }));
  });

  it('builds an anonymous Binance REST request from the trade page', () => {
    const request = createActiveMarketRequest(
      'https://www.binance.com/en/trade/BTC_USDT?type=spot',
      DEFAULT_CONFIG,
    );
    expect(request).toMatchObject({
      siteId: 'binance',
      symbol: 'BTCUSDT',
      period: '1d',
      adapterId: 'binance-rest-klines',
    });
    const url = new URL(request!.url);
    expect(url.origin + url.pathname).toBe('https://data-api.binance.vision/api/v3/klines');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT',
      interval: '1d',
      limit: '200',
    });
  });

  it('supports intraday periods and an exact Binance selection range', () => {
    const request = createActiveMarketRequest(
      'https://www.binance.com/en/trade/BTC_USDT?type=spot',
      { ...DEFAULT_CONFIG, analysisPeriod: '30m', analysisCandleCount: 40 },
      { startTime: 1_700_000_000_000, endTime: 1_700_070_200_000 },
    );
    expect(Object.fromEntries(new URL(request!.url).searchParams)).toEqual({
      symbol: 'BTCUSDT',
      interval: '30m',
      limit: '40',
      startTime: '1700000000000',
      endTime: '1700070200000',
    });
    expect(
      createActiveMarketRequest('https://stockpage.10jqka.com.cn/600487/', {
        ...DEFAULT_CONFIG,
        analysisPeriod: '1h',
        analysisCandleCount: 40,
      })?.url,
    ).toContain('/51/last40.js');
  });

  it.each([
    ['30m', '41'],
    ['1h', '51'],
    ['4h', '71'],
  ] as const)('maps %s for both active site adapters', (period, tonghuashunCode) => {
    const config = { ...DEFAULT_CONFIG, analysisPeriod: period, analysisCandleCount: 40 };
    expect(
      new URL(
        createActiveMarketRequest(
          'https://www.binance.com/en/trade/BTC_USDT?type=spot',
          config,
        )!.url,
      ).searchParams.get('interval'),
    ).toBe(period);
    expect(
      createActiveMarketRequest('https://stockpage.10jqka.com.cn/600487/', config)?.url,
    ).toContain(`/${tonghuashunCode}/last40.js`);
  });

  it('builds the matching Tonghuashun line request and never builds one for TradingView', () => {
    const request = createActiveMarketRequest('https://stockpage.10jqka.com.cn/600487/', {
      ...DEFAULT_CONFIG,
      analysisPeriod: '1w',
      analysisCandleCount: 64,
    });
    expect(request).toEqual({
      siteId: 'tonghuashun',
      symbol: '600487',
      period: '1w',
      url: 'https://d.10jqka.com.cn/v6/line/hs_600487/11/last64.js',
      adapterId: 'tonghuashun-line-jsonp',
    });
    expect(
      createActiveMarketRequest('https://www.tradingview.com/chart/?symbol=NVDA', DEFAULT_CONFIG),
    ).toBeUndefined();
  });

  it('normalizes Binance klines into the shared market model', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      1_700_000_000_000 + index * 86_400_000,
      '10',
      '12',
      '9',
      index === 19 ? '12' : '11',
      index === 19 ? '120' : '100',
    ]);
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(rows), { status: 200 }),
    ) as unknown as typeof fetch;
    const data = await fetchActiveMarketData(
      'https://www.binance.com/en/trade/BTC_USDT?type=spot',
      {
        ...DEFAULT_CONFIG,
        analysisCandleCount: 20,
      },
      fetcher,
    );
    expect(data).toMatchObject({
      siteId: 'binance',
      symbol: 'BTCUSDT',
      period: '1d',
      source: { adapterId: 'binance-rest-klines' },
      quality: { valid: true, candleCount: 20 },
    });
    expect(data?.candles.at(-1)).toMatchObject({ close: 12, volume: 120 });
  });

  it('unwraps Tonghuashun JSONP and normalizes its comma-separated rows', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0');
      return `202607${day},10,12,9,${index === 19 ? 12 : 11},${index === 19 ? 120 : 100},1`;
    });
    const body = `quotebridge_v6_line_hs_600487_01_last20({"data":"${lines.join(';')}"})`;
    expect(parseTonghuashunResponse(body)).toHaveLength(20);
    const fetcher = vi.fn(
      async () => new Response(body, { status: 200 }),
    ) as unknown as typeof fetch;
    const data = await fetchActiveMarketData(
      'https://stockpage.10jqka.com.cn/600487/',
      {
        ...DEFAULT_CONFIG,
        analysisCandleCount: 20,
      },
      fetcher,
    );
    expect(data).toMatchObject({
      siteId: 'tonghuashun',
      symbol: '600487',
      period: '1d',
      source: { adapterId: 'tonghuashun-line-jsonp' },
      quality: { valid: true, candleCount: 20 },
    });
    expect(data?.candles[0].timestamp).toBe(Date.UTC(2026, 6, 1));
  });

  it('rejects invalid calendar dates and malformed Binance JSON', async () => {
    const invalidDate = 'callback({"data":"20260231,10,12,9,11,100,1"})';
    const rows = parseTonghuashunResponse(invalidDate);
    expect((rows[0] as unknown[])[0]).toBeNaN();

    const fetcher = vi.fn(
      async () => new Response('{', { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchActiveMarketData(
        'https://www.binance.com/en/trade/BTC_USDT?type=spot',
        DEFAULT_CONFIG,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: 'E_ACTIVE_MARKET_RESPONSE_INVALID' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('parses Tonghuashun intraday timestamps', () => {
    const rows = parseTonghuashunResponse('callback({"data":"202608191430,10,12,9,11,100,1"})');
    expect((rows[0] as unknown[])[0]).toBe(Date.UTC(2026, 7, 19, 6, 30));
  });

  it('retries retryable HTTP failures serially after 200ms and stops after success', async () => {
    vi.useFakeTimers();
    try {
      const rows = Array.from({ length: 20 }, (_, index) => [
        1_700_000_000_000 + index * 86_400_000,
        '10',
        '12',
        '9',
        '11',
        '100',
      ]);
      const startedAt: number[] = [];
      const requestDurationMs = 50;
      let activeRequests = 0;
      let maximumConcurrentRequests = 0;
      const fetcher = vi.fn(async () => {
        startedAt.push(Date.now());
        activeRequests += 1;
        maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, requestDurationMs));
        const response =
          startedAt.length < 3
            ? new Response('', { status: 502 })
            : new Response(JSON.stringify(rows), { status: 200 });
        activeRequests -= 1;
        return response;
      }) as unknown as typeof fetch;

      const pending = fetchActiveMarketData(
        'https://www.binance.com/en/trade/BTC_USDT?type=spot',
        { ...DEFAULT_CONFIG, analysisCandleCount: 20 },
        fetcher,
      );
      await vi.advanceTimersByTimeAsync(ACTIVE_MARKET_RETRY_DELAY_MS * 2 + requestDurationMs * 3);
      const data = await pending;

      expect(data?.candles).toHaveLength(20);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(maximumConcurrentRequests).toBe(1);
      expect(startedAt.map((time) => time - startedAt[0])).toEqual([
        0,
        ACTIVE_MARKET_RETRY_DELAY_MS + requestDurationMs,
        (ACTIVE_MARKET_RETRY_DELAY_MS + requestDurationMs) * 2,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after five retries and does not retry non-retryable HTTP errors', async () => {
    vi.useFakeTimers();
    try {
      const retryableFetcher = vi.fn(
        async () => new Response('', { status: 502 }),
      ) as unknown as typeof fetch;
      const retryableFailure = fetchActiveMarketData(
        'https://stockpage.10jqka.com.cn/600487/',
        DEFAULT_CONFIG,
        retryableFetcher,
      );
      const retryableAssertion = expect(retryableFailure).rejects.toMatchObject({
        code: 'E_ACTIVE_MARKET_HTTP_ERROR',
      });
      await vi.advanceTimersByTimeAsync(ACTIVE_MARKET_RETRY_DELAY_MS * ACTIVE_MARKET_MAX_RETRIES);
      await retryableAssertion;
      expect(retryableFetcher).toHaveBeenCalledTimes(ACTIVE_MARKET_MAX_RETRIES + 1);

      const invalidRequestFetcher = vi.fn(
        async () => new Response('', { status: 400 }),
      ) as unknown as typeof fetch;
      await expect(
        fetchActiveMarketData(
          'https://stockpage.10jqka.com.cn/600487/',
          DEFAULT_CONFIG,
          invalidRequestFetcher,
        ),
      ).rejects.toMatchObject({ code: 'E_ACTIVE_MARKET_HTTP_ERROR' });
      expect(invalidRequestFetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries rejected network requests only after each request settles', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => {
        throw new TypeError('network unavailable');
      }) as unknown as typeof fetch;
      const pending = fetchActiveMarketData(
        'https://stockpage.10jqka.com.cn/600487/',
        DEFAULT_CONFIG,
        fetcher,
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'E_ACTIVE_MARKET_REQUEST_FAILED',
      });
      await vi.advanceTimersByTimeAsync(ACTIVE_MARKET_RETRY_DELAY_MS * ACTIVE_MARKET_MAX_RETRIES);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(ACTIVE_MARKET_MAX_RETRIES + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an active request and never schedules a retry after cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;

    const pending = fetchActiveMarketData(
      'https://www.binance.com/en/trade/BTC_USDT?type=spot',
      DEFAULT_CONFIG,
      fetcher,
      undefined,
      controller.signal,
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels during the 200ms retry wait without sending the next request', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetcher = vi.fn(
        async () => new Response('', { status: 502 }),
      ) as unknown as typeof fetch;
      const pending = fetchActiveMarketData(
        'https://stockpage.10jqka.com.cn/600487/',
        DEFAULT_CONFIG,
        fetcher,
        undefined,
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(ACTIVE_MARKET_RETRY_DELAY_MS / 2);
      controller.abort(new DOMException('cancelled', 'AbortError'));

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.runAllTimersAsync();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
