import type { RawMarketPayload, SelectionRange } from '../core/model/types';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';

const CHANNEL = 'KLA_MARKET_RESPONSE';
const CANDIDATE_BROADCAST_INTERVAL_MS = 100;
const candidates: RawMarketPayload[] = [];
let bridgeActive = true;
let cancelActiveSelection: (() => void) | undefined;
let candidateBroadcastTimer: number | undefined;

const extensionContextInvalidated = (error: unknown) =>
  !chrome.runtime?.id || String(error).includes('Extension context invalidated');
const disableBridge = () => {
  if (!bridgeActive) return;
  bridgeActive = false;
  window.removeEventListener('message', onMarketMessage);
  if (candidateBroadcastTimer !== undefined) window.clearTimeout(candidateBroadcastTimer);
  cancelActiveSelection?.();
};
const sendToBackground = (message: ExtensionMessage) => {
  if (!bridgeActive) return;
  try {
    const pending = chrome.runtime.sendMessage(message);
    void pending.catch((error) => {
      if (extensionContextInvalidated(error)) disableBridge();
    });
  } catch (error) {
    if (extensionContextInvalidated(error)) disableBridge();
  }
};
const scheduleCandidateBroadcast = () => {
  if (candidateBroadcastTimer !== undefined) return;
  candidateBroadcastTimer = window.setTimeout(() => {
    candidateBroadcastTimer = undefined;
    sendToBackground(createMessage('MARKET_DATA_CANDIDATES', 'content', candidates));
  }, CANDIDATE_BROADCAST_INTERVAL_MS);
};

// 将 MAIN World 捕获的行情桥接到扩展消息总线，并按频道保留最新候选。
function onMarketMessage(event: MessageEvent) {
  if (
    event.source !== window ||
    event.origin !== window.location.origin ||
    event.data?.channel !== CHANNEL
  )
    return;
  const payload = event.data.payload;
  if (!isRawMarketPayload(payload)) return;
  const existing = candidates.findIndex((c) => c.id === payload.id);
  if (existing >= 0) candidates.splice(existing, 1);
  candidates.unshift(payload);
  candidates.splice(20);
  scheduleCandidateBroadcast();
}
window.addEventListener('message', onMarketMessage);

const onRuntimeMessage = (
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => {
  if (message.type === 'START_SELECTION') {
    beginSelection().then((selection) => {
      if (selection) sendToBackground(createMessage('SELECTION_DONE', 'content', selection));
    });
    sendResponse({ ok: true });
  }
  if (message.type === 'GET_STATE')
    sendResponse({
      ok: true,
      page: { url: location.href, title: document.title },
      candidates: candidates.filter(
        (candidate) => !candidate.pageUrl || candidate.pageUrl === location.href,
      ),
    });
};
chrome.runtime.onMessage.addListener(onRuntimeMessage);

function beginSelection(): Promise<SelectionRange | null> {
  // 遮罩只记录视口坐标；它不读取或修改宿主页面的图表数据。
  cancelActiveSelection?.();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      cursor: 'crosshair',
      background: 'rgba(12,18,24,.08)',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      border: '2px solid #4f8cff',
      background: 'rgba(79,140,255,.14)',
      pointerEvents: 'none',
    });
    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);
    let start: { x: number; y: number } | null = null;
    let settled = false;
    const finish = (value: SelectionRange | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown);
      overlay.onmousedown = null;
      overlay.onmousemove = null;
      overlay.onmouseup = null;
      overlay.remove();
      cancelActiveSelection = undefined;
      resolve(value);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(null);
    };
    cancelActiveSelection = () => finish(null);
    overlay.onmousedown = (e) => {
      start = { x: e.clientX, y: e.clientY };
    };
    overlay.onmousemove = (e) => {
      if (!start) return;
      const left = Math.min(start.x, e.clientX),
        top = Math.min(start.y, e.clientY);
      Object.assign(box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.abs(e.clientX - start.x)}px`,
        height: `${Math.abs(e.clientY - start.y)}px`,
      });
    };
    overlay.onmouseup = (e) => {
      if (!start) return finish(null);
      const left = Math.min(start.x, e.clientX),
        top = Math.min(start.y, e.clientY),
        width = Math.abs(e.clientX - start.x),
        height = Math.abs(e.clientY - start.y);
      if (width < 40 || height < 40) {
        finish(null);
        return;
      }
      finish({
        pageUrl: location.href,
        tabId: -1,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
        rect: { left, top, width, height },
        capturedAt: Date.now(),
      });
    };
    window.addEventListener('keydown', onKeyDown);
  });
}

sendToBackground(
  createMessage('PAGE_DETECTED', 'content', { url: location.href, title: document.title }),
);
