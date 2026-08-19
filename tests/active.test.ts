import { describe, expect, it, vi } from 'vitest';
import {
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
        analysisCandleCount: 19,
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
  });

  it('parses Tonghuashun intraday timestamps', () => {
    const rows = parseTonghuashunResponse('callback({"data":"202608191430,10,12,9,11,100,1"})');
    expect((rows[0] as unknown[])[0]).toBe(Date.UTC(2026, 7, 19, 6, 30));
  });
});
