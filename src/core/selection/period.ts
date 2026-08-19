import { ANALYSIS_PERIODS } from '../config';
import type { AnalysisPeriod, RawMarketPayload, SelectionRange } from '../model/types';

const DIRECT_PERIODS: Record<string, AnalysisPeriod> = {
  '30': '30m',
  '30m': '30m',
  '60': '1h',
  '60m': '1h',
  '1h': '1h',
  '240': '4h',
  '240m': '4h',
  '4h': '4h',
  D: '1d',
  '1D': '1d',
  '1d': '1d',
  W: '1w',
  '1W': '1w',
  '1w': '1w',
  M: '1M',
  '1M': '1M',
};

export function normalizeMarketPeriod(value?: string): AnalysisPeriod | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (DIRECT_PERIODS[trimmed]) return DIRECT_PERIODS[trimmed];
  return ANALYSIS_PERIODS.find((period) => period === trimmed);
}

// 只提取周期词，不保存页面原文，避免把宿主页面的无关文字带入扩展会话。
export function extractAnalysisPeriods(text: string): AnalysisPeriod[] {
  const periods: AnalysisPeriod[] = [];
  const add = (period: AnalysisPeriod) => {
    if (!periods.includes(period)) periods.push(period);
  };
  if (/(?:^|\W)(?:30\s*m(?:in(?:ute)?s?)?|30\s*分钟)(?:$|\W)/i.test(text)) add('30m');
  if (/(?:^|\W)(?:1\s*h(?:our)?s?|60\s*m(?:in(?:ute)?s?)?|1\s*小时)(?:$|\W)/i.test(text)) add('1h');
  if (/(?:^|\W)(?:4\s*h(?:our)?s?|240\s*m(?:in(?:ute)?s?)?|4\s*小时)(?:$|\W)/i.test(text))
    add('4h');
  if (/(?:^|\W)(?:1\s*d|daily?|day|日线|日K|1\s*日)(?:$|\W)/i.test(text)) add('1d');
  if (/(?:^|\W)(?:1\s*w|weekly?|week|周线|周K|1\s*周)(?:$|\W)/i.test(text)) add('1w');
  if (/(?:^|\W)(?:1\s*M|monthly?|month|月线|月K|1\s*月)(?:$|\W)/.test(text)) add('1M');
  return periods;
}

export function resolveSelectionPeriod(
  selection: SelectionRange,
  candidates: RawMarketPayload[],
  fallback: AnalysisPeriod,
): { period?: AnalysisPeriod; raw?: string; source: 'market' | 'page' | 'config' } {
  const latestWithPeriod = candidates
    .filter((candidate) => candidate.period)
    .sort((left, right) => right.responseAt - left.responseAt)[0];
  if (latestWithPeriod?.period) {
    return {
      period: normalizeMarketPeriod(latestWithPeriod.period),
      raw: latestWithPeriod.period,
      source: 'market',
    };
  }
  const hint = [...(selection.periodHints ?? [])].sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
  if (hint) return { period: hint.period, raw: hint.period, source: 'page' };
  return { period: fallback, raw: fallback, source: 'config' };
}
