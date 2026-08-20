import type { RawMarketPayload, SelectionRange } from '../core/model/types';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';
import { extractAnalysisPeriods, extractMarketPeriodTokens } from '../core/selection/period';

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
      const pageImage = captureSelectionCanvases({ left, top, width, height });
      finish({
        pageUrl: location.href,
        tabId: -1,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
        rect: { left, top, width, height },
        chartRect,
        pageImage,
        ...collectPeriodHints(chartRect),
        capturedAt: Date.now(),
        recognitionStatus: 'capturing',
      });
    };
    window.addEventListener('keydown', onKeyDown);
  });
}

function captureSelectionCanvases(rect: ViewRect): SelectionRange['pageImage'] {
  const pixelScale = Math.min(
    devicePixelRatio,
    1600 / rect.width,
    1000 / rect.height,
    Math.sqrt(2_000_000 / (rect.width * rect.height)),
  );
  const width = Math.max(1, Math.round(rect.width * pixelScale));
  const height = Math.max(1, Math.round(rect.height * pixelScale));
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const context = output.getContext('2d');
  if (!context) return undefined;
  const pageBackground = getComputedStyle(document.body).backgroundColor;
  context.fillStyle =
    pageBackground && pageBackground !== 'rgba(0, 0, 0, 0)' ? pageBackground : '#fff';
  context.fillRect(0, 0, width, height);
  let drawn = 0;
  for (const canvas of document.querySelectorAll('canvas')) {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const left = Math.max(rect.left, bounds.left);
    const top = Math.max(rect.top, bounds.top);
    const right = Math.min(rect.left + rect.width, bounds.right);
    const bottom = Math.min(rect.top + rect.height, bounds.bottom);
    if (right <= left || bottom <= top) continue;
    const sourceX = ((left - bounds.left) / bounds.width) * canvas.width;
    const sourceY = ((top - bounds.top) / bounds.height) * canvas.height;
    const sourceWidth = ((right - left) / bounds.width) * canvas.width;
    const sourceHeight = ((bottom - top) / bounds.height) * canvas.height;
    const targetX = (left - rect.left) * pixelScale;
    const targetY = (top - rect.top) * pixelScale;
    const targetWidth = (right - left) * pixelScale;
    const targetHeight = (bottom - top) * pixelScale;
    try {
      const layer = document.createElement('canvas');
      layer.width = Math.max(1, Math.ceil(targetWidth));
      layer.height = Math.max(1, Math.ceil(targetHeight));
      const layerContext = layer.getContext('2d', { willReadFrequently: true });
      if (!layerContext) continue;
      layerContext.drawImage(
        canvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        layer.width,
        layer.height,
      );
      // 先在隔离画布上验证来源未被跨域内容污染，避免一个失败图层污染整个降级快照。
      layerContext.getImageData(0, 0, 1, 1);
      context.drawImage(layer, targetX, targetY, targetWidth, targetHeight);
      drawn += 1;
    } catch {
      // 被跨域图片污染的 Canvas 无法复制；继续尝试同一图表的其他画布层。
    }
  }
  if (!drawn) return undefined;
  try {
    return { dataUrl: output.toDataURL('image/png'), width, height };
  } catch {
    return undefined;
  }
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

function collectPeriodHints(
  chartRect?: ViewRect,
): Pick<SelectionRange, 'periodHints' | 'rawPeriodHints'> {
  const hints: NonNullable<SelectionRange['periodHints']> = [];
  const rawHints: NonNullable<SelectionRange['rawPeriodHints']> = [];
  const add = (
    text: string,
    confidence: number,
    source: NonNullable<SelectionRange['periodHints']>[number]['source'],
  ) => {
    const before = hints.length + rawHints.length;
    for (const period of extractAnalysisPeriods(text)) hints.push({ period, confidence, source });
    for (const raw of extractMarketPeriodTokens(text)) {
      if (!rawHints.some((hint) => hint.raw === raw && hint.confidence >= confidence))
        rawHints.push({ raw, confidence, source });
    }
    return hints.length + rawHints.length > before;
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
  // Binance 等站点只通过字号/字重标记当前周期，不提供 aria-selected 或 active class。
  // 只扫描主图附近的短文本控件，并要求明显字重，避免把页面正文误当作周期。
  const nearbyControls = document.querySelectorAll('button,[role="button"],li,span');
  let nearbyMatches = 0;
  for (const element of [...nearbyControls]) {
    const bounds = element.getBoundingClientRect();
    const text =
      `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`.trim();
    if (!text || text.length > 24 || bounds.width < 8 || bounds.height < 8) continue;
    if (
      chartRect &&
      (bounds.right < chartRect.left - 80 ||
        bounds.left > chartRect.left + chartRect.width + 80 ||
        bounds.bottom < chartRect.top - 120 ||
        bounds.top > chartRect.top + Math.min(chartRect.height, 180))
    )
      continue;
    const style = getComputedStyle(element);
    const weight = Number.parseInt(style.fontWeight, 10);
    if (!(Number.isFinite(weight) && weight >= 600)) continue;
    if (!add(text, Math.min(95, 92 + Math.floor((weight - 600) / 100)), 'selected-control'))
      continue;
    nearbyMatches += 1;
    if (nearbyMatches >= 100) break;
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
  return {
    periodHints: hints
      .sort((left, right) => right.confidence - left.confidence)
      .filter((hint, index, all) => all.findIndex((item) => item.period === hint.period) === index),
    rawPeriodHints: rawHints
      .sort((left, right) => right.confidence - left.confidence)
      .filter((hint, index, all) => all.findIndex((item) => item.raw === hint.raw) === index),
  };
}

sendToBackground(
  createMessage('PAGE_DETECTED', 'content', { url: location.href, title: document.title }),
);
