import type { RawMarketPayload, SelectionRange } from '../core/model/types';
import { createMessage, type ExtensionMessage } from '../shared/messages';

const CHANNEL = 'KLA_MARKET_RESPONSE';
const candidates: RawMarketPayload[] = [];

// 将 MAIN World 捕获的行情桥接到扩展消息总线，并按频道保留最新候选。
window.addEventListener('message', (event) => {
  if (
    event.source !== window ||
    event.origin !== window.location.origin ||
    event.data?.channel !== CHANNEL
  )
    return;
  const payload = event.data.payload as RawMarketPayload;
  if (!payload?.url) return;
  const existing = candidates.findIndex((c) => c.id === payload.id);
  if (existing >= 0) candidates.splice(existing, 1);
  candidates.unshift(payload);
  candidates.splice(20);
  chrome.runtime.sendMessage(createMessage('MARKET_DATA_CANDIDATES', 'content', candidates));
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'START_SELECTION') {
    beginSelection().then((selection) => {
      if (selection)
        chrome.runtime.sendMessage(createMessage('SELECTION_DONE', 'content', selection));
    });
    sendResponse({ ok: true });
  }
  if (message.type === 'GET_STATE') sendResponse({ ok: true, candidates });
});

function beginSelection(): Promise<SelectionRange | null> {
  // 遮罩只记录视口坐标；它不读取或修改宿主页面的图表数据。
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
      border: '2px solid #00a878',
      background: 'rgba(0,168,120,.12)',
      pointerEvents: 'none',
    });
    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);
    let start: { x: number; y: number } | null = null;
    const finish = (value: SelectionRange | null) => {
      overlay.remove();
      resolve(value);
    };
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
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') finish(null);
      },
      { once: true },
    );
  });
}

chrome.runtime.sendMessage(
  createMessage('PAGE_DETECTED', 'content', { url: location.href, title: document.title }),
);
