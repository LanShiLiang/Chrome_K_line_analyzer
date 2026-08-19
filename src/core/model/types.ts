import type { LocalizedMessage } from '../../shared/i18n-types';

// 核心领域模型统一约束跨站点行情、分析结果和用户配置。
export type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type DataQuality = {
  valid: boolean;
  candleCount: number;
  missingFields: string[];
  warnings: LocalizedMessage[];
  score: number;
};
export type MarketData = {
  id: string;
  siteId: string;
  symbol?: string;
  period?: string;
  timezone?: string;
  candles: Candle[];
  source: { url: string; adapterId: string; capturedAt: number };
  quality: DataQuality;
};
export type SelectionRange = {
  pageUrl: string;
  tabId: number;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  rect: { left: number; top: number; width: number; height: number };
  chartRect?: { left: number; top: number; width: number; height: number };
  periodHints?: Array<{
    period: AnalysisPeriod;
    confidence: number;
    source: 'selected-control' | 'chart-nearby' | 'page';
  }>;
  capturedAt: number;
  image?: SelectionImageEvidence;
  interpretation?: SelectionInterpretation;
  recognitionStatus?: 'capturing' | 'ready' | 'failed';
};
export type SelectionImageEvidence = {
  dataUrl: string;
  width: number;
  height: number;
  candleColors: Array<'green' | 'red' | 'unknown'>;
  detectedCandles: number;
  confidence: number;
};
export type SelectionInterpretation = {
  period: AnalysisPeriod;
  startTime: number;
  endTime: number;
  candleCount: number;
  confidence: number;
  method: 'image-sequence' | 'chart-geometry';
};
export type AnalysisPeriod = '30m' | '1h' | '4h' | '1d' | '1w' | '1M';
export type UserConfig = {
  analysisPeriod: AnalysisPeriod;
  analysisCandleCount: number;
};
export const DEFAULT_CONFIG: UserConfig = {
  analysisPeriod: '1d',
  analysisCandleCount: 200,
};
export const MIN_ANALYSIS_CANDLES = 20;
export const MIN_CANDLE_COUNT_INPUT = 1;
export const MAX_ANALYSIS_CANDLES = 1000;
// 策略阈值由引擎统一维护，避免用户参数彼此冲突或产生不可解释的组合。
export const STRATEGY_DEFAULTS = {
  volumeMaPeriod: 20,
  breakoutThreshold: 0.01,
  volumeSpikeRatio: 1.5,
  lowVolumeRatio: 0.7,
} as const;
export type WyckoffStage =
  | 'ACCUMULATION'
  | 'SPRING_TEST'
  | 'MARKUP'
  | 'DISTRIBUTION'
  | 'MARKDOWN'
  | 'UNKNOWN';
export type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'RISK';
export type VolumeLabel = 'SPIKE' | 'LOW' | 'NORMAL';
export type EvidenceCode =
  | 'PRICE_ONLY'
  | 'B003'
  | 'S003'
  | 'B001'
  | 'S002'
  | 'B004'
  | 'TREND_UP'
  | 'TREND_DOWN';
export type TradeSignal = {
  action: TradeAction;
  confidence: number;
  price?: number;
  reasonCodes: EvidenceCode[];
  riskWarnings: LocalizedMessage[];
};
export type EvidenceItem = { code: EvidenceCode; score: number };
export type WyckoffAnalysisResult = {
  id: string;
  stage: WyckoffStage;
  signal: TradeSignal;
  volumeSummary: {
    average: number;
    latest: number;
    ratio: number;
    label: VolumeLabel;
  };
  keyLevels: { support: number; resistance: number };
  evidence: EvidenceItem[];
  warnings: LocalizedMessage[];
  createdAt: number;
};
export type RawMarketPayload = {
  id: string;
  siteId?: string;
  symbol?: string;
  period?: string;
  pageUrl?: string;
  url: string;
  method: 'WS';
  status: number;
  contentType?: string;
  requestAt: number;
  responseAt: number;
  source: 'websocket';
  raw: unknown;
  sampleText?: string;
  confidence: number;
};
