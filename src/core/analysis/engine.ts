import type {
  EvidenceItem,
  MarketData,
  TradeAction,
  UserConfig,
  WyckoffAnalysisResult,
  WyckoffStage,
} from '../model/types';
import { MIN_ANALYSIS_CANDLES, STRATEGY_DEFAULTS } from '../model/types';
import { assessQuality } from '../adapter/normalize';
import { getAnalysisConfigError } from '../config';
import { dedupeMessages, message, type LocalizedMessage } from '../../shared/i18n-types';

const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const pct = (a: number, b: number) => (b === 0 ? 0 : (a - b) / b);

export class AnalysisInputError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: LocalizedMessage,
  ) {
    super(code);
    this.name = 'AnalysisInputError';
  }
}

export function prepareMarketDataForAnalysis(data: MarketData, config: UserConfig): MarketData {
  const configError = getAnalysisConfigError(config);
  if (configError) throw new AnalysisInputError('E_ANALYSIS_CONFIG_INVALID', configError);
  if (!data.candles.length)
    throw new AnalysisInputError('E_MARKET_DATA_INVALID', message('error_market_data_invalid'));
  if (data.candles.length < config.analysisCandleCount)
    throw new AnalysisInputError(
      'E_ANALYSIS_CANDLES_INSUFFICIENT',
      message('error_analysis_candles_insufficient', [
        data.candles.length,
        config.analysisCandleCount,
      ]),
    );
  const candles = data.candles.slice(-config.analysisCandleCount);
  const quality = assessQuality(candles, MIN_ANALYSIS_CANDLES);
  quality.warnings = dedupeMessages([...data.quality.warnings, ...quality.warnings]);
  return { ...data, candles, quality };
}

export function runMarketAnalysis(data: MarketData, config: UserConfig) {
  const marketData = prepareMarketDataForAnalysis(data, config);
  return { marketData, result: analyzePreparedMarketData(marketData) };
}

// 保留面向调用方的单结果 API；后台使用 runMarketAnalysis 同时取得同一份图表快照。
export function analyzeMarket(data: MarketData, config: UserConfig): WyckoffAnalysisResult {
  return runMarketAnalysis(data, config).result;
}

// 基于已经校验和裁剪的统一 OHLCV 计算可解释的维科夫阶段、信号和证据。
function analyzePreparedMarketData(prepared: MarketData): WyckoffAnalysisResult {
  const candles = prepared.candles;
  const warnings = [...prepared.quality.warnings];
  // 用户选择的分析数量就是完整的支撑、阻力和趋势观察窗口。
  const window = candles;
  const recent = window.slice(-Math.min(10, window.length));
  const prior = window.slice(0, -Math.min(10, window.length));
  const support = Math.min(...window.map((c) => c.low));
  const resistance = Math.max(...window.map((c) => c.high));
  const latest = candles.at(-1)!;
  const volumeAverage = average(
    candles.slice(-STRATEGY_DEFAULTS.volumeMaPeriod).map((c) => c.volume),
  );
  const volumeRatio = volumeAverage ? latest.volume / volumeAverage : 0;
  const trend = pct(latest.close, window[0].close);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const priorHigh = prior.length ? Math.max(...prior.map((c) => c.high)) : recentHigh;
  const priorLow = prior.length ? Math.min(...prior.map((c) => c.low)) : support;
  const spread = (resistance - support) / Math.max(support, Number.EPSILON);
  const evidence: EvidenceItem[] = [];
  let stage: WyckoffStage = 'UNKNOWN';
  let action: TradeAction = 'HOLD';
  let score = Math.round(prepared.quality.score * 0.2);
  const hasUsableVolume = volumeAverage > 0;

  const breakout =
    latest.close > priorHigh * (1 + STRATEGY_DEFAULTS.breakoutThreshold) &&
    volumeRatio >= STRATEGY_DEFAULTS.volumeSpikeRatio;
  const breakdown =
    latest.close < priorLow * (1 - STRATEGY_DEFAULTS.breakoutThreshold) &&
    volumeRatio >= STRATEGY_DEFAULTS.volumeSpikeRatio;
  const spring =
    latest.low < priorLow &&
    latest.close > priorLow &&
    volumeRatio < STRATEGY_DEFAULTS.volumeSpikeRatio;
  const divergence =
    recentHigh > priorHigh &&
    average(recent.map((c) => c.volume)) < average(prior.map((c) => c.volume));

  // 规则按确认强度排序，避免同一窗口同时命中多个互斥阶段。
  if (!hasUsableVolume) {
    score = Math.min(score, 20);
    evidence.push({
      code: 'PRICE_ONLY',
      score: 0,
    });
  } else if (breakout) {
    stage = 'MARKUP';
    action = 'BUY';
    score += 50;
    evidence.push({ code: 'B003', score: 20 });
  } else if (breakdown) {
    stage = 'MARKDOWN';
    action = 'SELL';
    score += 55;
    evidence.push({ code: 'S003', score: 25 });
  } else if (spring) {
    stage = 'SPRING_TEST';
    action = 'BUY';
    score += 45;
    evidence.push({ code: 'B001', score: 20 });
  } else if (divergence && trend > 0) {
    stage = 'DISTRIBUTION';
    action = 'SELL';
    score += 35;
    evidence.push({
      code: 'S002',
      score: 15,
    });
  } else if (spread < 0.12 && trend <= 0.05) {
    stage = 'ACCUMULATION';
    action = 'HOLD';
    score += 25;
    evidence.push({
      code: 'B004',
      score: 10,
    });
  } else if (trend > 0.08) {
    stage = 'MARKUP';
    action = 'HOLD';
    score += 30;
    evidence.push({
      code: 'TREND_UP',
      score: 10,
    });
  } else if (trend < -0.08) {
    stage = 'MARKDOWN';
    action = 'RISK';
    score += 30;
    evidence.push({
      code: 'TREND_DOWN',
      score: 10,
    });
  }

  // 数据质量不足时保留形态识别结果，但禁止输出买卖动作。
  if (candles.length < MIN_ANALYSIS_CANDLES) {
    action = 'HOLD';
    score -= 25;
  }
  if (evidence.length === 0) warnings.push(message('warning_unclear_structure'));
  return {
    id: crypto.randomUUID(),
    stage,
    signal: {
      action,
      confidence: clamp(score),
      price: latest.close,
      reasonCodes: evidence.map((e) => e.code),
      riskWarnings: warnings,
    },
    volumeSummary: {
      average: volumeAverage,
      latest: latest.volume,
      ratio: volumeRatio,
      label: !hasUsableVolume
        ? 'NORMAL'
        : volumeRatio >= STRATEGY_DEFAULTS.volumeSpikeRatio
          ? 'SPIKE'
          : volumeRatio <= STRATEGY_DEFAULTS.lowVolumeRatio
            ? 'LOW'
            : 'NORMAL',
    },
    keyLevels: { support, resistance },
    evidence,
    warnings,
    createdAt: Date.now(),
  };
}
