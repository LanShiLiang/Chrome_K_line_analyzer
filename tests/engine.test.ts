import { describe, expect, it } from 'vitest';
import {
  AnalysisInputError,
  analyzeMarket,
  prepareMarketDataForAnalysis,
  runMarketAnalysis,
} from '../src/core/analysis/engine';
import { assessQuality } from '../src/core/adapter/normalize';
import {
  getAnalysisConfigError,
  loadStoredUserConfig,
  mergeUserConfig,
  resolveAnalysisConfigForMarket,
  resolveUserConfigForSite,
} from '../src/core/config';
import {
  DEFAULT_CONFIG,
  MIN_ANALYSIS_CANDLES,
  STRATEGY_DEFAULTS,
  type Candle,
  type MarketData,
} from '../src/core/model/types';

// 构造稳定的 OHLCV 序列，覆盖策略阈值、信号降级和证据输出。
const market = (candles: Candle[]): MarketData => ({
  id: 'm',
  siteId: 'test',
  candles,
  source: { url: 'wss://test/kline', adapterId: 'test', capturedAt: 0 },
  quality: assessQuality(candles),
});
const base = Array.from(
  { length: 200 },
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
        { timestamp: 201 * 60000, open: 102, high: 110, low: 101, close: 109, volume: 300 },
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
        { timestamp: 201 * 60000, open: 98, high: 99, low: 88, close: 89, volume: 300 },
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
        { timestamp: 201 * 60000, open: 99, high: 101, low: 95, close: 99, volume: 100 },
      ]),
      DEFAULT_CONFIG,
    );
    expect(result.stage).toBe('SPRING_TEST');
    expect(result.signal.action).toBe('BUY');
    expect(result.signal.reasonCodes).toContain('B001');
  });

  it('reports how many candles are missing instead of calculating with a partial window', () => {
    const short = base.slice(0, 20);
    expect(() => analyzeMarket(market(short), DEFAULT_CONFIG)).toThrowError(
      expect.objectContaining({
        code: 'E_ANALYSIS_CANDLES_INSUFFICIENT',
        message: expect.stringContaining('当前仅获取 20 根'),
      }),
    );
  });

  it('reports invalid market data when no valid candle exists', () => {
    expect(() => analyzeMarket(market([]), DEFAULT_CONFIG)).toThrowError(
      expect.objectContaining({ code: 'E_MARKET_DATA_INVALID' }),
    );
  });

  it('uses exactly the configured latest candles for analysis and rendering', () => {
    const candles = Array.from({ length: 200 }, (_, index) => ({
      ...base[index % base.length],
      timestamp: (index + 1) * 60000,
    }));
    const prepared = prepareMarketDataForAnalysis(market(candles), {
      ...DEFAULT_CONFIG,
      analysisCandleCount: 64,
    });
    expect(prepared.candles).toHaveLength(64);
    expect(prepared.candles[0].timestamp).toBe(137 * 60000);
    expect(prepared.candles.at(-1)?.timestamp).toBe(200 * 60000);
    const analysis = runMarketAnalysis(market(candles), {
      ...DEFAULT_CONFIG,
      analysisCandleCount: 64,
    });
    expect(analysis.marketData.candles).toHaveLength(64);
    expect(analysis.result.keyLevels.support).toBe(98);
  });

  it('keeps only meaningful user settings and validates the analysis window', () => {
    expect(DEFAULT_CONFIG).toEqual({
      analysisPeriod: '1d',
      analysisCandleCount: 200,
    });
    expect(MIN_ANALYSIS_CANDLES).toBe(20);
    expect(STRATEGY_DEFAULTS).toEqual({
      volumeMaPeriod: 20,
      breakoutThreshold: 0.01,
      volumeSpikeRatio: 1.5,
      lowVolumeRatio: 0.7,
    });
    expect(
      getAnalysisConfigError({
        ...DEFAULT_CONFIG,
        analysisCandleCount: 19,
      }),
    ).toBe('分析 K 线数量不能少于 20 根');
    expect(
      getAnalysisConfigError({
        ...DEFAULT_CONFIG,
        analysisCandleCount: 1001,
      }),
    ).toContain('不能超过');
    expect(new AnalysisInputError('E_TEST', 'test')).toMatchObject({ code: 'E_TEST' });
  });

  it('migrates old stored settings without retaining removed strategy fields', () => {
    expect(
      loadStoredUserConfig({
        analysisPeriod: '1w',
        analysisCandleCount: 128,
        rangeLookback: 60,
        debugMode: true,
      }),
    ).toEqual({ analysisPeriod: '1w', analysisCandleCount: 128 });
    expect(mergeUserConfig({ analysisPeriod: '1M', analysisCandleCount: 256 })).toEqual({
      analysisPeriod: '1M',
      analysisCandleCount: 256,
    });
  });

  it('forces TradingView to default settings without changing other site settings', () => {
    const custom = { analysisPeriod: '1w' as const, analysisCandleCount: 128 };
    expect(resolveUserConfigForSite('tradingview', custom)).toEqual(DEFAULT_CONFIG);
    expect(resolveUserConfigForSite('binance', custom)).toEqual(custom);
    expect(resolveUserConfigForSite('tonghuashun', custom)).toEqual(custom);
  });

  it('uses the current TradingView chart size instead of a fixed strategy window', () => {
    const custom = { analysisPeriod: '1w' as const, analysisCandleCount: 512 };
    expect(resolveAnalysisConfigForMarket('tradingview', custom, 128)).toEqual({
      ...DEFAULT_CONFIG,
      analysisCandleCount: 128,
    });
    expect(resolveAnalysisConfigForMarket('tradingview', custom, 1500).analysisCandleCount).toBe(
      1000,
    );
    expect(resolveAnalysisConfigForMarket('binance', custom, 80)).toEqual(custom);
  });

  it('does not present a Wyckoff stage or trading signal without usable volume', () => {
    const result = analyzeMarket(
      market(base.map((candle) => ({ ...candle, volume: 0 }))),
      DEFAULT_CONFIG,
    );
    expect(result.stage).toBe('UNKNOWN');
    expect(result.signal.action).toBe('HOLD');
    expect(result.signal.reasonCodes).toEqual(['PRICE_ONLY']);
    expect(result.warnings).toContain('成交量缺失，无法可靠执行量价分析');
  });
});
