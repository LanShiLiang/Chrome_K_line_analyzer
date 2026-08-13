import type {
  Candle,
  EvidenceItem,
  MarketData,
  UserConfig,
  WyckoffAnalysisResult,
  WyckoffStage,
} from '../model/types';

const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const pct = (a: number, b: number) => (b === 0 ? 0 : (a - b) / b);

// 基于统一 OHLCV 计算可解释的维科夫阶段、信号和证据。
export function analyzeMarket(data: MarketData, config: UserConfig): WyckoffAnalysisResult {
  const candles = data.candles;
  const warnings = [...data.quality.warnings];
  if (!candles.length) return emptyResult(warnings.length ? warnings : ['没有可分析的 K 线数据']);
  const window = candles.slice(-Math.max(config.rangeLookback, config.volumeMaPeriod));
  const recent = window.slice(-Math.min(10, window.length));
  const prior = window.slice(0, -Math.min(10, window.length));
  const support = Math.min(...window.map((c) => c.low));
  const resistance = Math.max(...window.map((c) => c.high));
  const latest = candles.at(-1)!;
  const volumeAverage = average(candles.slice(-config.volumeMaPeriod).map((c) => c.volume));
  const volumeRatio = volumeAverage ? latest.volume / volumeAverage : 0;
  const trend = pct(latest.close, window[0].close);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const priorHigh = prior.length ? Math.max(...prior.map((c) => c.high)) : recentHigh;
  const priorLow = prior.length ? Math.min(...prior.map((c) => c.low)) : support;
  const spread = (resistance - support) / Math.max(support, Number.EPSILON);
  const evidence: EvidenceItem[] = [];
  let stage: WyckoffStage = 'UNKNOWN';
  let action: 'BUY' | 'SELL' | 'HOLD' | 'RISK' = 'HOLD';
  let score = Math.round(data.quality.score * 0.2);

  const breakout =
    latest.close > priorHigh * (1 + config.breakoutThreshold) &&
    volumeRatio >= config.volumeSpikeRatio;
  const breakdown =
    latest.close < priorLow * (1 - config.breakoutThreshold) &&
    volumeRatio >= config.volumeSpikeRatio;
  const spring =
    latest.low < priorLow && latest.close > priorLow && volumeRatio < config.volumeSpikeRatio;
  const divergence =
    recentHigh > priorHigh &&
    average(recent.map((c) => c.volume)) < average(prior.map((c) => c.volume));

  // 规则按确认强度排序，避免同一窗口同时命中多个互斥阶段。
  if (breakout) {
    stage = 'MARKUP';
    action = 'BUY';
    score += 50;
    evidence.push({ code: 'B003', label: '放量突破', detail: '价格放量突破前区间阻力', score: 20 });
  } else if (breakdown) {
    stage = 'MARKDOWN';
    action = 'SELL';
    score += 55;
    evidence.push({ code: 'S003', label: '放量跌破', detail: '价格放量跌破前区间支撑', score: 25 });
  } else if (spring) {
    stage = 'SPRING_TEST';
    action = 'BUY';
    score += 45;
    evidence.push({ code: 'B001', label: 'Spring 测试', detail: '跌破支撑后快速收回', score: 20 });
  } else if (divergence && trend > 0) {
    stage = 'DISTRIBUTION';
    action = 'SELL';
    score += 35;
    evidence.push({
      code: 'S002',
      label: '价量背离',
      detail: '价格创新高但平均成交量下降',
      score: 15,
    });
  } else if (spread < 0.12 && trend <= 0.05) {
    stage = 'ACCUMULATION';
    action = 'HOLD';
    score += 25;
    evidence.push({
      code: 'B004',
      label: '区间吸筹候选',
      detail: '价格处于窄幅区间，等待突破确认',
      score: 10,
    });
  } else if (trend > 0.08) {
    stage = 'MARKUP';
    action = 'HOLD';
    score += 30;
    evidence.push({
      code: 'TREND_UP',
      label: '上涨趋势',
      detail: '分析窗口内价格保持上行',
      score: 10,
    });
  } else if (trend < -0.08) {
    stage = 'MARKDOWN';
    action = 'RISK';
    score += 30;
    evidence.push({
      code: 'TREND_DOWN',
      label: '下跌趋势',
      detail: '分析窗口内价格持续下行',
      score: 10,
    });
  }

  // 数据质量不足时保留形态识别结果，但禁止输出买卖动作。
  if (candles.length < config.minCandles || volumeAverage === 0) {
    action = 'HOLD';
    score -= 25;
  }
  if (evidence.length === 0) warnings.push('当前量价结构不明确，建议等待确认');
  return {
    id: crypto.randomUUID(),
    stage,
    signal: {
      action,
      confidence: clamp(score),
      price: latest.close,
      reasonCodes: evidence.map((e) => e.code),
      explanations: evidence.map((e) => e.detail),
      riskWarnings: warnings,
    },
    volumeSummary: {
      average: volumeAverage,
      latest: latest.volume,
      ratio: volumeRatio,
      label:
        volumeRatio >= config.volumeSpikeRatio
          ? 'SPIKE'
          : volumeRatio <= config.lowVolumeRatio
            ? 'LOW'
            : 'NORMAL',
    },
    keyLevels: { support, resistance },
    evidence,
    warnings,
    createdAt: Date.now(),
  };
}

function emptyResult(warnings: string[]): WyckoffAnalysisResult {
  return {
    id: crypto.randomUUID(),
    stage: 'UNKNOWN',
    signal: {
      action: 'HOLD',
      confidence: 0,
      reasonCodes: [],
      explanations: [],
      riskWarnings: warnings,
    },
    volumeSummary: { average: 0, latest: 0, ratio: 0, label: 'NORMAL' },
    keyLevels: { support: 0, resistance: 0 },
    evidence: [],
    warnings,
    createdAt: Date.now(),
  };
}

export function simpleMovingAverage(candles: Candle[], period: number) {
  return candles.map((_, i) =>
    i < period - 1 ? null : average(candles.slice(i - period + 1, i + 1).map((c) => c.volume)),
  );
}
