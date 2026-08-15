import { parseWebSocketFrame, type WebSocketMarketUpdate } from '../core/adapter/websocket';
import type { Candle, RawMarketPayload } from '../core/model/types';

const CHANNEL = 'KLA_MARKET_RESPONSE';
const HOOK_MARKER = '__klaWebSocketHookInstalledV1__';
const EMIT_INTERVAL_MS = 100;
const NativeWebSocket = window.WebSocket;
const streams = new Map<
  string,
  { candles: Map<number, Candle>; update: WebSocketMarketUpdate; url: string; openedAt: number }
>();

const pendingEmits = new Map<string, RawMarketPayload>();
let emitTimer: number | undefined;
// 高频逐笔更新只保留每个频道的最新快照，避免主线程和扩展消息队列被重复序列化淹没。
const emit = (payload: RawMarketPayload) => {
  pendingEmits.set(payload.id, payload);
  if (emitTimer !== undefined) return;
  emitTimer = window.setTimeout(() => {
    emitTimer = undefined;
    for (const next of pendingEmits.values())
      window.postMessage({ channel: CHANNEL, payload: next }, window.location.origin);
    pendingEmits.clear();
  }, EMIT_INTERVAL_MS);
};
const merge = (update: WebSocketMarketUpdate, url: string, openedAt: number) => {
  const key = `${update.adapterId}:${update.channel}`;
  const stream = streams.get(key) ?? { candles: new Map<number, Candle>(), update, url, openedAt };
  stream.update = update;
  for (const item of update.candles) stream.candles.set(item.timestamp, item);
  while (stream.candles.size > 2000) stream.candles.delete(stream.candles.keys().next().value!);
  streams.set(key, stream);
  emit({
    id: key,
    siteId: update.siteId,
    symbol: update.symbol,
    period: update.period,
    url,
    method: 'WS',
    status: 101,
    contentType: 'application/websocket',
    requestAt: openedAt,
    responseAt: Date.now(),
    source: 'websocket',
    raw: [...stream.candles.values()].sort((a, b) => a.timestamp - b.timestamp),
    confidence: update.confidence,
  });
};
const consume = async (data: unknown, url: string, openedAt: number) => {
  // 浏览器 WebSocket 消息可能是字符串、Blob 或 ArrayBuffer。
  let text: string | undefined;
  if (typeof data === 'string') text = data;
  else if (data instanceof Blob) text = await data.text();
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  if (!text) return;
  for (const update of parseWebSocketFrame(location.hostname, text)) merge(update, url, openedAt);
};

const hookedWindow = window as typeof window & { [HOOK_MARKER]?: boolean };
if (!hookedWindow[HOOK_MARKER]) {
  hookedWindow[HOOK_MARKER] = true;
  window.WebSocket = new Proxy(NativeWebSocket, {
    // 只旁路监听 message 事件，不改变宿主页面的连接、发送和关闭行为。
    construct(Target, args) {
      const openedAt = Date.now();
      const socket = Reflect.construct(Target, args) as WebSocket;
      socket.addEventListener('message', (event) => {
        void consume(event.data, socket.url || String(args[0]), openedAt);
      });
      return socket;
    },
  });
}
