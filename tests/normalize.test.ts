import { describe, expect, it } from 'vitest';
import { assessQuality, createMarketData, normalizeCandles } from '../src/core/adapter/normalize';

// 适配器测试锁定排序、去重、字段兼容和数据质量判定契约。
describe('normalizeCandles', () => {
  it('normalizes arrays and objects, sorts, and keeps the last duplicate', () => {
    const result = normalizeCandles([
      { t: 2, o: '10', h: '12', l: '9', c: '11', v: '30' },
      [1, 8, 11, 7, 10, 20],
      [1, 8, 11, 7, 9, 21],
    ]);
    expect(result).toEqual([
      { timestamp: 1000, open: 8, high: 11, low: 7, close: 9, volume: 21 },
      { timestamp: 2000, open: 10, high: 12, low: 9, close: 11, volume: 30 },
    ]);
  });

  it('filters invalid numbers, timestamps, OHLC relations, and volume', () => {
    expect(
      normalizeCandles([
        [0, 10, 11, 9, 10, 1],
        [1, 10, 9, 8, 10, 1],
        [2, 10, 11, 9, 10, -1],
        [3, 'x', 11, 9, 10, 1],
      ]),
    ).toEqual([]);
  });

  it('creates market data with identity and quality metadata', () => {
    const raw = { rows: Array.from({ length: 80 }, (_, index) => [index + 1, 10, 12, 9, 11, 100]) };
    const data = createMarketData(raw, 'wss://example.test/stream', 'binance', 'BTCUSDT', '1m');
    expect(data).toMatchObject({
      siteId: 'binance',
      symbol: 'BTCUSDT',
      period: '1m',
      quality: { valid: true, candleCount: 80, score: 100 },
    });
  });
});

describe('assessQuality', () => {
  it('reports insufficient data and missing volume', () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      timestamp: i + 1,
      open: 1,
      high: 2,
      low: 0,
      close: 1,
      volume: 0,
    }));
    const quality = assessQuality(candles);
    expect(quality.valid).toBe(false);
    expect(quality.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('数据不足'),
        expect.stringContaining('成交量缺失'),
      ]),
    );
  });

  it('caps quality at 100', () => {
    const candles = Array.from({ length: 200 }, (_, i) => ({
      timestamp: i + 1,
      open: 1,
      high: 2,
      low: 0,
      close: 1,
      volume: 1,
    }));
    expect(assessQuality(candles).score).toBe(100);
  });
});
