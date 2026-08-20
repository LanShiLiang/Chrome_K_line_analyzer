import { describe, expect, it } from 'vitest';
import {
  detectCandleColors,
  interpretSelectionRange,
  matchCandleSequence,
} from '../src/core/selection/image';
import {
  extractAnalysisPeriods,
  normalizeMarketPeriod,
  resolveSelectionPeriod,
} from '../src/core/selection/period';
import type { Candle, MarketData, SelectionRange } from '../src/core/model/types';
import { assessQuality } from '../src/core/adapter/normalize';

const makeCandles = (count: number): Candle[] => {
  let price = 100;
  let state = 0x12345678;
  return Array.from({ length: count }, (_, index) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const rising = state / 0x1_0000_0000 >= 0.5;
    const open = price;
    const close = open + (rising ? 2 : -2);
    price = close;
    return {
      timestamp: Date.UTC(2026, 0, 1) + index * 30 * 60_000,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 100 + index,
    };
  });
};

const renderColors = (colors: Array<'green' | 'red'>) => {
  const width = colors.length * 8;
  const height = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  colors.forEach((color, index) => {
    const rgb = color === 'green' ? [14, 203, 129] : [246, 70, 93];
    const x = index * 8 + 3;
    const top = 8 + (index % 17);
    for (let y = top; y < top + 28; y += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const pixel = (y * width + x + dx) * 4;
        data[pixel] = rgb[0];
        data[pixel + 1] = rgb[1];
        data[pixel + 2] = rgb[2];
        data[pixel + 3] = 255;
      }
    }
  });
  return { width, height, data };
};

describe('selection image recognition', () => {
  it('detects candle colors and matches the image sequence to market dates', () => {
    const candles = makeCandles(120);
    const selected = candles.slice(37, 77);
    const colors = selected.map((candle) => (candle.close > candle.open ? 'green' : 'red'));
    const detected = detectCandleColors(renderColors(colors));
    expect(detected.detectedCandles).toBe(40);
    expect(detected.candleColors).toEqual(colors);
    expect(matchCandleSequence(detected.candleColors, candles, 'binance')).toMatchObject({
      startIndex: 37,
      endIndex: 76,
    });
  });

  it('reverses red/green market semantics for Tonghuashun', () => {
    const candles = makeCandles(90);
    const selected = candles.slice(20, 50);
    const colors = selected.map((candle) => (candle.close > candle.open ? 'red' : 'green'));
    expect(matchCandleSequence(colors, candles, 'tonghuashun')).toMatchObject({
      startIndex: 20,
      endIndex: 49,
    });
  });

  it('reconstructs a missing candle slot instead of shifting every later candle', () => {
    const candles = makeCandles(120);
    const selected = candles.slice(37, 77);
    const colors = selected.map((candle) => (candle.close > candle.open ? 'green' : 'red'));
    const pixels = renderColors(colors);
    const missingIndex = 13;
    for (let y = 0; y < pixels.height; y += 1) {
      for (let x = missingIndex * 8; x < missingIndex * 8 + 8; x += 1) {
        const pixel = (y * pixels.width + x) * 4;
        pixels.data.fill(0, pixel, pixel + 4);
      }
    }
    const detected = detectCandleColors(pixels);
    expect(detected.detectedCandles).toBe(40);
    expect(detected.candleColors[missingIndex]).toBe('unknown');
    expect(matchCandleSequence(detected.candleColors, candles, 'binance')).toMatchObject({
      startIndex: 37,
      endIndex: 76,
    });
  });

  it('rejects ambiguous short direction sequences instead of silently choosing the first date', () => {
    const candles = makeCandles(1000);
    const colors = candles
      .slice(0, 5)
      .map((candle) => (candle.close > candle.open ? ('green' as const) : ('red' as const)));
    expect(matchCandleSequence(colors, candles, 'binance')).toBeUndefined();
  });

  it('does not guess dates from chart geometry without a visible time anchor', () => {
    const candles = makeCandles(100);
    const data: MarketData = {
      id: 'market',
      siteId: 'tradingview',
      period: '30m',
      candles,
      quality: assessQuality(candles),
      source: {
        url: 'wss://example.test',
        adapterId: 'passive-tradingview-websocket',
        capturedAt: 0,
      },
    };
    const selection = {
      pageUrl: 'https://www.tradingview.com/chart/',
      tabId: 1,
      viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      rect: { left: 300, top: 100, width: 200, height: 300 },
      chartRect: { left: 100, top: 50, width: 800, height: 500 },
      capturedAt: 0,
    } satisfies SelectionRange;
    expect(interpretSelectionRange(selection, data, 'tradingview', false)).toBeUndefined();
    expect(interpretSelectionRange(selection, data, 'tradingview', true)).toBeUndefined();
  });
});

describe('selection period recognition', () => {
  it('normalizes supported chart resolutions without confusing month and minute', () => {
    expect(normalizeMarketPeriod('30')).toBe('30m');
    expect(normalizeMarketPeriod('60')).toBe('1h');
    expect(normalizeMarketPeriod('240')).toBe('4h');
    expect(normalizeMarketPeriod('M')).toBe('1M');
    expect(normalizeMarketPeriod('15m')).toBeUndefined();
    expect(extractAnalysisPeriods('当前 30分钟 / 4 hours')).toEqual(['30m', '4h']);
  });

  it('prefers a high-confidence selected chart control over stale market streams', () => {
    const selection = {
      periodHints: [{ period: '4h', confidence: 95, source: 'selected-control' }],
    } as SelectionRange;
    expect(
      resolveSelectionPeriod(
        selection,
        [
          { period: '1h', responseAt: 10 },
          { period: '30m', responseAt: 20 },
        ] as never,
        '1d',
      ),
    ).toEqual({ period: '4h', raw: '4h', source: 'page' });
  });
});
