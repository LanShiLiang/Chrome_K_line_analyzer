import type { Candle, DataQuality, MarketData } from '../model/types';

const n = (value: unknown) => (typeof value === 'number' ? value : Number(value));
const timestamp = (value: unknown) => {
  const v = n(value);
  return v < 1e12 ? v * 1000 : v;
};

// 将数组或对象形式的行情统一为按时间排序、去重后的 OHLCV。
export function normalizeCandles(input: unknown): Candle[] {
  const rows = Array.isArray(input) ? input : [];
  const parsed = rows
    .map((row): Candle | null => {
      if (Array.isArray(row) && row.length >= 6)
        return {
          timestamp: timestamp(row[0]),
          open: n(row[1]),
          high: n(row[2]),
          low: n(row[3]),
          close: n(row[4]),
          volume: n(row[5]),
        };
      if (row && typeof row === 'object') {
        const r = row as Record<string, unknown>;
        return {
          timestamp: timestamp(r.timestamp ?? r.time ?? r.t),
          open: n(r.open ?? r.o),
          high: n(r.high ?? r.h),
          low: n(r.low ?? r.l),
          close: n(r.close ?? r.c),
          volume: n(r.volume ?? r.vol ?? r.v),
        };
      }
      return null;
    })
    .filter(
      (c): c is Candle =>
        !!c &&
        Object.values(c).every(Number.isFinite) &&
        c.timestamp > 0 &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close) &&
        c.volume >= 0,
    );
  return [
    ...new Map(
      parsed.sort((a, b) => a.timestamp - b.timestamp).map((c) => [c.timestamp, c]),
    ).values(),
  ];
}

export function assessQuality(candles: Candle[], minCandles = 80): DataQuality {
  // 数据量和成交量是量价策略可执行的最低质量门槛。
  const warnings: string[] = [];
  if (candles.length < minCandles) warnings.push(`数据不足：至少需要 ${minCandles} 根 K 线`);
  if (candles.every((c) => c.volume === 0)) warnings.push('成交量缺失，无法可靠执行量价分析');
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round((candles.length / minCandles) * 70) + (candles.some((c) => c.volume > 0) ? 30 : 0),
    ),
  );
  return {
    valid: candles.length >= minCandles && candles.some((c) => c.volume > 0),
    candleCount: candles.length,
    missingFields: [],
    warnings,
    score,
  };
}

export function createMarketData(
  raw: unknown,
  sourceUrl: string,
  siteId = 'generic',
  symbol?: string,
  period?: string,
): MarketData {
  // 适配器输出最终都在此汇总为策略引擎使用的统一模型。
  const candidates =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (Object.values(raw as Record<string, unknown>).find(Array.isArray) ?? raw)
      : raw;
  const candles = normalizeCandles(candidates);
  return {
    id: crypto.randomUUID(),
    siteId,
    symbol,
    period,
    candles,
    source: { url: sourceUrl, adapterId: 'generic-ohlcv', capturedAt: Date.now() },
    quality: assessQuality(candles),
  };
}
