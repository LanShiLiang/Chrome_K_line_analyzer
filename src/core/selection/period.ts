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

// 保留页面明确显示但插件尚不支持的周期（例如同花顺 120 分），让错误提示说明
// “该周期不支持”，而不是误报为“没有识别到周期”。
export function extractMarketPeriodTokens(text: string): string[] {
  const tokens: string[] = [];
  const add = (value: string) => {
    if (!tokens.includes(value)) tokens.push(value);
  };
  const patterns = [
    /(?:^|\W)(\d{1,4})\s*(?:m|min(?:ute)?s?|分|分钟)(?:$|\W)/gi,
    /(?:^|\W)(\d{1,3})\s*(?:h|hour(?:s)?|小时)(?:$|\W)/gi,
    /(?:^|\W)(\d{1,3})\s*(?:d|day(?:s)?|日)(?:$|\W)/gi,
    /(?:^|\W)(\d{1,3})\s*(?:w|week(?:s)?|周)(?:$|\W)/gi,
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      const suffix = index === 0 ? 'm' : index === 1 ? 'h' : index === 2 ? 'd' : 'w';
      add(`${match[1]}${suffix}`);
    }
  }
  if (/(?:^|\W)(?:日线|日K)(?:$|\W)/i.test(text)) add('1d');
  if (/(?:^|\W)(?:周线|周K)(?:$|\W)/i.test(text)) add('1w');
  if (/(?:^|\W)(?:月线|月K)(?:$|\W)/i.test(text)) add('1M');
  return tokens;
}

export function resolveSelectionPeriod(
  selection: SelectionRange,
  candidates: RawMarketPayload[],
  fallback: AnalysisPeriod,
): { period?: AnalysisPeriod; raw?: string; source: 'market' | 'page' | 'config' } {
  const hint = [...(selection.periodHints ?? [])].sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
  const rawHint = [...(selection.rawPeriodHints ?? [])].sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
  // 页面中明确处于选中状态的主图周期控件，比“最后收到的 WebSocket 批次”更接近
  // 用户当前所见；后者可能来自指标或刚切换前的旧订阅。
  if ((hint?.confidence ?? 0) >= 90 || (rawHint?.confidence ?? 0) >= 90) {
    if (rawHint && rawHint.confidence > (hint?.confidence ?? 0))
      return {
        period: normalizeMarketPeriod(rawHint.raw),
        raw: rawHint.raw,
        source: 'page',
      };
    if (hint) return { period: hint.period, raw: hint.period, source: 'page' };
  }
  const latestWithPeriod = candidates
    .filter((candidate) => normalizeMarketPeriod(candidate.period))
    .sort((left, right) => right.responseAt - left.responseAt)[0];
  if (latestWithPeriod?.period) {
    return {
      period: normalizeMarketPeriod(latestWithPeriod.period),
      raw: latestWithPeriod.period,
      source: 'market',
    };
  }
  if (hint) return { period: hint.period, raw: hint.period, source: 'page' };
  return { period: fallback, raw: fallback, source: 'config' };
}
