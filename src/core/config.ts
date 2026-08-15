import {
  DEFAULT_CONFIG,
  MAX_ANALYSIS_CANDLES,
  MIN_ANALYSIS_CANDLES,
  type AnalysisPeriod,
  type UserConfig,
} from './model/types';
import type { MarketSite } from './adapter/sites';

const ANALYSIS_PERIODS: readonly AnalysisPeriod[] = ['1d', '1w', '1M'];

export const isAnalysisPeriod = (value: unknown): value is AnalysisPeriod =>
  ANALYSIS_PERIODS.some((period) => period === value);

// 仅迁移仍对用户开放的字段，旧版本中已经移除的策略参数不会继续混入运行时配置。
export function loadStoredUserConfig(value: unknown): UserConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONFIG };
  const saved = value as Record<string, unknown>;
  return {
    analysisPeriod: isAnalysisPeriod(saved.analysisPeriod)
      ? saved.analysisPeriod
      : DEFAULT_CONFIG.analysisPeriod,
    analysisCandleCount:
      typeof saved.analysisCandleCount === 'number' && Number.isFinite(saved.analysisCandleCount)
        ? saved.analysisCandleCount
        : DEFAULT_CONFIG.analysisCandleCount,
  };
}

// 消息载荷只允许覆盖公开配置字段，同时保留非法值交给统一校验器生成明确反馈。
export function mergeUserConfig(value?: Partial<UserConfig>): UserConfig {
  return {
    analysisPeriod: value?.analysisPeriod ?? DEFAULT_CONFIG.analysisPeriod,
    analysisCandleCount: value?.analysisCandleCount ?? DEFAULT_CONFIG.analysisCandleCount,
  };
}

// TradingView 依赖页面当前周期与已捕获批次，禁止沿用其他站点的自定义请求参数。
export function resolveUserConfigForSite(site: MarketSite, config: UserConfig): UserConfig {
  return site === 'tradingview' ? { ...DEFAULT_CONFIG } : { ...config };
}

export function getAnalysisConfigError(config: UserConfig): string | undefined {
  if (!isAnalysisPeriod(config.analysisPeriod)) return '行情周期无效，请重新选择';
  if (!Number.isInteger(config.analysisCandleCount)) return '分析 K 线数量必须是整数';
  if (config.analysisCandleCount < MIN_ANALYSIS_CANDLES)
    return `分析 K 线数量不能少于 ${MIN_ANALYSIS_CANDLES} 根`;
  if (config.analysisCandleCount > MAX_ANALYSIS_CANDLES)
    return `分析 K 线数量不能超过当前页面上限 ${MAX_ANALYSIS_CANDLES} 根`;
}
