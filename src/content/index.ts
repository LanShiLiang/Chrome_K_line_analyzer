import type { RawMarketPayload, SelectionRange } from '../core/model/types';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';
import { extractAnalysisPeriods } from '../core/selection/period';

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
  if (message.type === 'CANCEL_SELECTION') {
    cancelActiveSelection?.();
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
  // 遮罩记录视口和图表范围；截图由 Service Worker 在松开鼠标后本地截取。
  cancelActiveSelection?.();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.dataset.klaSelectionOverlay = 'true';
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
      overlay.style.display = 'none';
      const chartRect = findChartRect({ left, top, width, height });
      finish({
        pageUrl: location.href,
        tabId: -1,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
        rect: { left, top, width, height },
        chartRect,
        periodHints: collectPeriodHints(chartRect),
        capturedAt: Date.now(),
        recognitionStatus: 'capturing',
      });
    };
    window.addEventListener('keydown', onKeyDown);
  });
}

type ViewRect = { left: number; top: number; width: number; height: number };
const containsRect = (outer: DOMRect, inner: ViewRect) =>
  outer.left <= inner.left + 2 &&
  outer.top <= inner.top + 2 &&
  outer.right >= inner.left + inner.width - 2 &&
  outer.bottom >= inner.top + inner.height - 2;

function findChartRect(selection: ViewRect): ViewRect | undefined {
  const centerX = selection.left + selection.width / 2;
  const centerY = selection.top + selection.height / 2;
  const elements = document.elementsFromPoint(centerX, centerY);
  const candidates = new Set<Element>();
  for (const element of elements) {
    candidates.add(element);
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement)
      candidates.add(parent);
  }
  for (const canvas of document.querySelectorAll('canvas,svg')) {
    const bounds = canvas.getBoundingClientRect();
    if (containsRect(bounds, selection)) candidates.add(canvas);
  }
  const ranked = [...candidates]
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .filter(
      ({ bounds }) =>
        containsRect(bounds, selection) &&
        bounds.width >= 120 &&
        bounds.height >= 100 &&
        bounds.left < innerWidth &&
        bounds.top < innerHeight,
    )
    .sort((leftItem, rightItem) => {
      const leftCanvas = /^(CANVAS|SVG)$/.test(leftItem.element.tagName) ? -1 : 0;
      const rightCanvas = /^(CANVAS|SVG)$/.test(rightItem.element.tagName) ? -1 : 0;
      return (
        leftCanvas - rightCanvas ||
        leftItem.bounds.width * leftItem.bounds.height -
          rightItem.bounds.width * rightItem.bounds.height
      );
    });
  const bounds = ranked[0]?.bounds;
  return bounds
    ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
    : undefined;
}

function collectPeriodHints(chartRect?: ViewRect): NonNullable<SelectionRange['periodHints']> {
  const hints: NonNullable<SelectionRange['periodHints']> = [];
  const add = (
    text: string,
    confidence: number,
    source: NonNullable<SelectionRange['periodHints']>[number]['source'],
  ) => {
    for (const period of extractAnalysisPeriods(text)) hints.push({ period, confidence, source });
  };
  const selectedControls = document.querySelectorAll(
    '[aria-selected="true"],[aria-pressed="true"],[data-active="true"],button[class*="active" i],[role="button"][class*="selected" i]',
  );
  for (const element of [...selectedControls].slice(0, 100)) {
    const bounds = element.getBoundingClientRect();
    if (
      chartRect &&
      (bounds.right < chartRect.left - 160 ||
        bounds.left > chartRect.left + chartRect.width + 160 ||
        bounds.bottom < chartRect.top - 160 ||
        bounds.top > chartRect.top + chartRect.height + 160)
    )
      continue;
    add(
      `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`,
      95,
      'selected-control',
    );
  }
  try {
    const url = new URL(location.href);
    for (const key of ['interval', 'period', 'resolution', 'timeframe']) {
      const value = url.searchParams.get(key);
      if (value) add(value, 80, 'page');
    }
  } catch {
    // location.href is expected to be valid, but selection must still work on unusual documents.
  }
  return [...new Map(hints.map((hint) => [hint.period, hint])).values()].sort(
    (left, right) => right.confidence - left.confidence,
  );
}

sendToBackground(
  createMessage('PAGE_DETECTED', 'content', { url: location.href, title: document.title }),
);
