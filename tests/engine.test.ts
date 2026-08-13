import { describe, expect, it } from 'vitest';
import { analyzeMarket, simpleMovingAverage } from '../src/core/analysis/engine';
import { assessQuality } from '../src/core/adapter/normalize';
import { DEFAULT_CONFIG, type Candle, type MarketData } from '../src/core/model/types';

// 构造稳定的 OHLCV 序列，覆盖策略阈值、信号降级和证据输出。
const market = (candles: Candle[]): MarketData => ({
  id: 'm',
  siteId: 'test',
  candles,
  source: { url: 'wss://test/kline', adapterId: 'test', capturedAt: 0 },
  quality: assessQuality(candles),
});
const base = Array.from(
  { length: 90 },
  (_, i): Candle => ({
    timestamp: (i + 1) * 60000,
    open: 100,
    high: 102,
    low: 98,
    close: 100 + (i % 3),
    volume: 100,
  }),
);

describe('analyzeMarket', () => {
  it('detects a volume-confirmed breakout', () => {
    const result = analyzeMarket(
      market([
        ...base,
        { timestamp: 91 * 60000, open: 102, high: 110, low: 101, close: 109, volume: 300 },
      ]),
      DEFAULT_CONFIG,
    );
    expect(result).toMatchObject({
      stage: 'MARKUP',
      signal: { action: 'BUY', price: 109 },
      volumeSummary: { label: 'SPIKE' },
    });
    expect(result.signal.reasonCodes).toContain('B003');
  });

  it('detects a volume-confirmed breakdown', () => {
    const result = analyzeMarket(
      market([
        ...base,
        { timestamp: 91 * 60000, open: 98, high: 99, low: 88, close: 89, volume: 300 },
      ]),
      DEFAULT_CONFIG,
    );
    expect(result.stage).toBe('MARKDOWN');
    expect(result.signal.action).toBe('SELL');
    expect(result.signal.reasonCodes).toContain('S003');
  });

  it('detects a spring that recovers above prior support', () => {
    const result = analyzeMarket(
      market([
        ...base,
        { timestamp: 91 * 60000, open: 99, high: 101, low: 95, close: 99, volume: 100 },
      ]),
      DEFAULT_CONFIG,
    );
    expect(result.stage).toBe('SPRING_TEST');
    expect(result.signal.action).toBe('BUY');
    expect(result.signal.reasonCodes).toContain('B001');
  });

  it('forces HOLD when data is insufficient even if the shape is a breakout', () => {
    const short = base.slice(0, 20);
    const result = analyzeMarket(
      market([
        ...short,
        { timestamp: 21 * 60000, open: 102, high: 110, low: 101, close: 109, volume: 300 },
      ]),
      DEFAULT_CONFIG,
    );
    expect(result.stage).toBe('MARKUP');
    expect(result.signal.action).toBe('HOLD');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('数据不足')]));
  });

  it('degrades safely when no data exists', () => {
    const result = analyzeMarket(market([]), DEFAULT_CONFIG);
    expect(result).toMatchObject({
      stage: 'UNKNOWN',
      signal: { action: 'HOLD', confidence: 0 },
      keyLevels: { support: 0, resistance: 0 },
    });
  });
});

describe('simpleMovingAverage', () => {
  it('returns null until the volume window is complete', () => {
    const candles = base.slice(0, 4).map((item, index) => ({ ...item, volume: index + 1 }));
    expect(simpleMovingAverage(candles, 3)).toEqual([null, null, 2, 3]);
  });
});
