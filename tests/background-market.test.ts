import { describe, expect, it } from 'vitest';
import { selectBestPassiveMarketData } from '../src/background/market';
import type { Candle, RawMarketPayload } from '../src/core/model/types';

const candles = (count: number, volume: number): Candle[] =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: (index + 1) * 60_000,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    volume,
  }));

const candidate = (
  id: string,
  siteId: RawMarketPayload['siteId'],
  raw: Candle[],
  responseAt: number,
  pageUrl?: string,
): RawMarketPayload => ({
  id,
  siteId,
  pageUrl,
  url: `wss://${siteId}.example/socket`,
  method: 'WS',
  status: 101,
  requestAt: responseAt - 1,
  responseAt,
  source: 'websocket',
  raw,
  confidence: 1,
});

describe('passive market candidate selection', () => {
  it('isolates candidates by site and prefers a TradingView series with usable volume', () => {
    const selected = selectBestPassiveMarketData(
      [
        candidate('binance', 'binance', candles(300, 500), 3),
        candidate('tv-zero-volume', 'tradingview', candles(200, 0), 2),
        candidate('tv-main', 'tradingview', candles(128, 100), 1),
      ],
      'tradingview',
    );
    expect(selected).toMatchObject({
      siteId: 'tradingview',
      candles: expect.arrayContaining([expect.objectContaining({ volume: 100 })]),
      source: { adapterId: 'passive-tradingview-websocket' },
    });
    expect(selected?.candles).toHaveLength(128);
  });

  it('does not fall back to another site when the current tab has no matching candidate', () => {
    expect(
      selectBestPassiveMarketData(
        [candidate('binance', 'binance', candles(200, 100), 1)],
        'tradingview',
      ),
    ).toBeUndefined();
  });

  it('does not reuse a TradingView series captured before an in-tab chart navigation', () => {
    const currentPage = 'https://www.tradingview.com/chart/?symbol=NASDAQ%3ATSLA';
    const selected = selectBestPassiveMarketData(
      [
        candidate(
          'old-symbol',
          'tradingview',
          candles(300, 100),
          2,
          'https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL',
        ),
        candidate('current-symbol', 'tradingview', candles(80, 100), 1, currentPage),
      ],
      'tradingview',
      currentPage,
    );
    expect(selected?.candles).toHaveLength(80);
  });
});
