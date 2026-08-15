import type { Candle } from '../model/types';
import { detectMarketSiteFromHost } from './sites';

export type WebSocketMarketUpdate = {
  adapterId: 'tradingview-ws' | 'binance-ws';
  channel: string;
  siteId: string;
  symbol?: string;
  period?: string;
  candles: Candle[];
  confidence: number;
};

// 宽松读取数字字段，但在组装蜡烛时严格校验时间、OHLC 关系和成交量。
const number = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const candle = (values: unknown[]): Candle | undefined => {
  for (const offset of [0, 1]) {
    if (values.length - offset < 6) continue;
    const [time, open, high, low, close, volume] = values.slice(offset, offset + 6).map(number);
    if (
      time === undefined ||
      time <= 0 ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined ||
      volume === undefined
    )
      continue;
    if (high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) continue;
    return { timestamp: time < 1e12 ? time * 1000 : time, open, high, low, close, volume };
  }
};

export function decodeTradingViewMessages(frame: string): unknown[] {
  // TradingView 可在一个 WebSocket 帧内拼接多条长度前缀消息。
  const messages: unknown[] = [];
  const pattern = /~m~(\d+)~m~/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(frame))) {
    const start = pattern.lastIndex;
    const text = frame.slice(start, start + Number(match[1]));
    pattern.lastIndex = start + Number(match[1]);
    if (text.startsWith('~h~')) continue;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'string' || !parsed.startsWith('~h~')) messages.push(parsed);
    } catch {
      /* Ignore heartbeat and incomplete frames. */
    }
  }
  if (messages.length === 0 && frame.trim().startsWith('{'))
    try {
      messages.push(JSON.parse(frame));
    } catch {
      /* Non-JSON frame. */
    }
  return messages;
}

const MAX_TRADINGVIEW_NODES = 20000;
const MAX_CANDLES_PER_UPDATE = 2000;
const MAX_CHANNEL_PATH_LENGTH = 256;

function tradingViewSeries(value: unknown, path: string, updates: WebSocketMarketUpdate[]) {
  // 协议层级不是稳定 API；使用有预算的迭代遍历，避免异常深帧造成递归爆栈或长期占用主线程。
  const pending: Array<{ value: unknown; path: string }> = [{ value, path }];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;
  while (pending.length && visitedNodes < MAX_TRADINGVIEW_NODES) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== 'object') continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    visitedNodes += 1;
    const record = current.value as Record<string, unknown>;
    if (Array.isArray(record.s)) {
      const candles = record.s
        .slice(-MAX_CANDLES_PER_UPDATE)
        .map((item) =>
          item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).v)
            ? candle((item as Record<string, unknown>).v as unknown[])
            : undefined,
        )
        .filter((item): item is Candle => Boolean(item));
      if (candles.length)
        updates.push({
          adapterId: 'tradingview-ws',
          channel: current.path,
          siteId: 'tradingview',
          candles,
          confidence: 95,
        });
    }
    const entries = Object.entries(record);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (visitedNodes + pending.length >= MAX_TRADINGVIEW_NODES) break;
      const [key, child] = entries[index];
      if (key === 's' && Array.isArray(child)) continue;
      if (!child || typeof child !== 'object') continue;
      const nextPath = current.path ? `${current.path}.${key}` : key;
      pending.push({
        value: child,
        path:
          nextPath.length <= MAX_CHANNEL_PATH_LENGTH
            ? nextPath
            : nextPath.slice(0, MAX_CHANNEL_PATH_LENGTH),
      });
    }
  }
}

export function parseTradingViewFrame(frame: string): WebSocketMarketUpdate[] {
  const updates: WebSocketMarketUpdate[] = [];
  for (const message of decodeTradingViewMessages(frame)) {
    if (!message || typeof message !== 'object') continue;
    const envelope = message as { m?: string; p?: unknown[] };
    if (envelope.m !== 'timescale_update' && envelope.m !== 'du') continue;
    tradingViewSeries(envelope.p?.[1], String(envelope.p?.[0] ?? envelope.m), updates);
  }
  return updates;
}

export function parseBinanceFrame(frame: string): WebSocketMarketUpdate[] {
  // 同时兼容 Binance raw stream 与 combined stream 外层包装。
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return [];
  }
  const envelope = parsed as {
    stream?: unknown;
    data?: unknown;
    e?: unknown;
    k?: unknown;
    s?: unknown;
  };
  const data = (envelope.data ?? envelope) as { e?: unknown; k?: unknown; s?: unknown };
  if (data.e !== 'kline' || !data.k || typeof data.k !== 'object') return [];
  const k = data.k as Record<string, unknown>;
  const parsedCandle = candle([k.t, k.o, k.h, k.l, k.c, k.v]);
  if (!parsedCandle) return [];
  const symbol = String(k.s ?? data.s ?? '');
  const period = String(k.i ?? '');
  return [
    {
      adapterId: 'binance-ws',
      channel: String(envelope.stream ?? `${symbol.toLowerCase()}@kline_${period}`),
      siteId: 'binance',
      symbol: symbol || undefined,
      period: period || undefined,
      candles: [parsedCandle],
      confidence: 100,
    },
  ];
}

export function parseWebSocketFrame(host: string, frame: string): WebSocketMarketUpdate[] {
  // 已知站点只运行对应适配器；未知站点再尝试两种公开格式。
  const site = detectMarketSiteFromHost(host);
  if (site === 'tradingview') return parseTradingViewFrame(frame);
  if (site === 'binance') return parseBinanceFrame(frame);
  return [...parseBinanceFrame(frame), ...parseTradingViewFrame(frame)];
}
