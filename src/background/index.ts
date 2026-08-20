import { AnalysisInputError, runMarketAnalysis } from '../core/analysis/engine';
import { ActiveMarketDataError, fetchActiveMarketData } from '../core/adapter/active';
import { detectMarketSite, isSameMarketPage } from '../core/adapter/sites';
import {
  getAnalysisConfigError,
  mergeUserConfig,
  resolveAnalysisConfigForMarket,
  resolveUserConfigForSite,
} from '../core/config';
import type { AnalysisRunMode, MarketData, SelectionRange, UserConfig } from '../core/model/types';
import {
  MAX_ANALYSIS_CANDLES,
  MIN_ANALYSIS_CANDLES,
  MIN_SELECTION_DATE_EVIDENCE,
} from '../core/model/types';
import { assessQuality } from '../core/adapter/normalize';
import { interpretSelectionRange } from '../core/selection/image';
import { resolveSelectionPeriod } from '../core/selection/period';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';
import { message as localizedMessage } from '../shared/i18n-types';
import { selectBestPassiveMarketData } from './market';
import { createSession, resolveSessionTabId, updateSessionPage, type Session } from './session';
import { captureSelectionImage } from './selection-capture';
import { AnalysisTaskRegistry } from './analysis-tasks';
import { awaitWithSignal, isAbortError, throwIfAborted } from '../shared/cancellation';

// Service Worker 按标签页维护临时会话，并统一执行标准化与策略分析。
const sessions = new Map<number, Session>();
const selectionTasks = new Map<number, Promise<void>>();
const analysisTasks = new AnalysisTaskRegistry();
const session = (tabId: number) => {
  if (!sessions.has(tabId)) sessions.set(tabId, createSession());
  return sessions.get(tabId)!;
};

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // 页面消息优先使用 sender.tab；扩展页面必须显式携带 tabId。
  const tabId = resolveSessionTabId(message.source, sender.tab?.id, message.tabId);
  if (tabId === undefined) {
    sendResponse({
      ok: false,
      error: {
        code: 'E_TAB_REQUIRED',
        message: localizedMessage('error_tab_required'),
        recoverable: true,
      },
    });
    return;
  }
  const current = session(tabId);
  if (message.type === 'PAGE_DETECTED') {
    const revision = current.revision;
    updateSessionPage(current, message.payload as Session['page']);
    if (current.revision !== revision) analysisTasks.cancel(tabId);
  }
  if (message.type === 'SELECTION_DONE') {
    analysisTasks.cancel(tabId);
    current.revision += 1;
    const selection = {
      ...(message.payload as SelectionRange),
      tabId,
      recognitionStatus: 'capturing' as const,
    };
    current.selection = selection;
    broadcastSelection(tabId, selection);
    const task = captureSelectionImage(tabId, selection)
      .then((image) => {
        if (current.selection?.capturedAt !== selection.capturedAt) return;
        current.selection = { ...selection, image, recognitionStatus: 'ready' };
        broadcastSelection(tabId, current.selection);
      })
      .catch((error) => {
        console.warn('Unable to capture the selected K-line image.', error);
        if (current.selection?.capturedAt !== selection.capturedAt) return;
        current.selection = { ...selection, recognitionStatus: 'failed' };
        broadcastSelection(tabId, current.selection);
      });
    selectionTasks.set(tabId, task);
    void task.finally(() => {
      if (selectionTasks.get(tabId) === task) selectionTasks.delete(tabId);
    });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'MARKET_DATA_CANDIDATES')
    current.candidates = Array.isArray(message.payload)
      ? message.payload.filter(isRawMarketPayload)
      : [];
  if (message.type === 'RESET_ANALYSIS') {
    analysisTasks.cancel(tabId);
    current.revision += 1;
    current.selection = undefined;
    current.candidates = [];
    selectionTasks.delete(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'CANCEL_ANALYSIS') {
    analysisTasks.cancel(tabId);
    current.revision += 1;
    current.selection = undefined;
    selectionTasks.delete(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'GET_STATE') {
    const requestedPage = message.payload as Session['page'];
    if (requestedPage?.url) updateSessionPage(current, requestedPage);
    void hydrateSessionFromContent(tabId, current).then(() =>
      sendResponse({ ok: true, data: current }),
    );
    return true;
  }
  if (message.type === 'RUN_ANALYSIS') {
    const requested = message.payload as {
      config?: UserConfig;
      pageUrl?: string;
      mode?: AnalysisRunMode;
      selectionCapturedAt?: number;
    };
    if ((requested.mode ?? 'manual') === 'manual') {
      current.revision += 1;
      current.selection = undefined;
      selectionTasks.delete(tabId);
    }
    const signal = analysisTasks.start(tabId, message.id);
    void runAnalysis(tabId, current, requested, signal)
      .then(sendResponse)
      .finally(() => analysisTasks.complete(tabId, message.id));
    return true;
  }
  sendResponse({ ok: true });
});

async function hydrateSessionFromContent(tabId: number, current: Session) {
  const revision = current.revision;
  try {
    const response = await chrome.tabs.sendMessage(tabId, createMessage('GET_STATE', 'background'));
    if (current.revision !== revision) return;
    if (response?.ok && response.page?.url) updateSessionPage(current, response.page);
    if (response?.ok && Array.isArray(response.candidates))
      current.candidates = response.candidates.filter(isRawMarketPayload);
  } catch {
    // 不支持的页面没有 Content Script；保留后台现有状态即可。
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  analysisTasks.cancel(tabId);
  sessions.delete(tabId);
  selectionTasks.delete(tabId);
});

function broadcastSelection(tabId: number, selection: SelectionRange) {
  try {
    void chrome.runtime
      .sendMessage({ ...createMessage('SELECTION_UPDATED', 'background', selection), tabId })
      .catch(() => undefined);
  } catch {
    // Side Panel may be closed while the screenshot is processed.
  }
}

async function getAuthoritativePage(tabId: number, current: Session, requestedUrl?: string) {
  let tabUrl: string | undefined;
  let tabTitle = current.page?.title ?? '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url;
    tabTitle = tab.title ?? tabTitle;
  } catch {
    // activeTab 权限在极少数生命周期边界可能暂时不可用，此时使用消息携带的当前 URL。
  }
  const pageUrl = tabUrl ?? requestedUrl ?? current.page?.url;
  if (!pageUrl)
    throw new AnalysisInputError(
      'E_PAGE_CONTEXT_MISSING',
      localizedMessage('error_page_context_missing'),
    );
  if (tabUrl && requestedUrl && !isSameMarketPage(tabUrl, requestedUrl))
    throw new AnalysisInputError(
      'E_PAGE_CONTEXT_CHANGED',
      localizedMessage('error_page_context_changed'),
    );
  updateSessionPage(current, { url: pageUrl, title: tabTitle });
  return pageUrl;
}

async function assertPageStillActive(
  tabId: number,
  current: Session,
  pageUrl: string,
  revision: number,
) {
  if (
    current.revision !== revision ||
    !current.page?.url ||
    !isSameMarketPage(current.page.url, pageUrl)
  )
    throw new AnalysisInputError(
      'E_PAGE_CONTEXT_CHANGED',
      localizedMessage('error_page_context_changed_during_analysis'),
    );
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && !isSameMarketPage(tab.url, pageUrl))
      throw new AnalysisInputError(
        'E_PAGE_CONTEXT_CHANGED',
        localizedMessage('error_page_context_changed_during_analysis'),
      );
  } catch (error) {
    if (error instanceof AnalysisInputError) throw error;
  }
}

async function runAnalysis(
  tabId: number,
  current: Session,
  requested: {
    config?: UserConfig;
    pageUrl?: string;
    mode?: AnalysisRunMode;
    selectionCapturedAt?: number;
  },
  signal: AbortSignal,
) {
  try {
    throwIfAborted(signal);
    const selectionTask = selectionTasks.get(tabId);
    if (selectionTask) await awaitWithSignal(selectionTask, signal);
    throwIfAborted(signal);
    const pageUrl = await getAuthoritativePage(tabId, current, requested.pageUrl);
    throwIfAborted(signal);
    const revision = current.revision;
    const site = detectMarketSite(pageUrl);
    const storedConfig = resolveUserConfigForSite(site, mergeUserConfig(requested.config));
    const mode = requested.mode ?? 'manual';
    const selection = mode === 'selection' ? current.selection : undefined;
    if (
      mode === 'selection' &&
      (!selection ||
        (requested.selectionCapturedAt !== undefined &&
          selection.capturedAt !== requested.selectionCapturedAt))
    )
      throw new AnalysisInputError('E_SELECTION_STALE', localizedMessage('error_selection_stale'), [
        localizedMessage('guidance_selection_retry'),
      ]);
    if (selection?.recognitionStatus === 'failed')
      throw new AnalysisInputError(
        'E_SELECTION_CAPTURE_FAILED',
        localizedMessage('error_selection_capture_failed'),
        [localizedMessage('guidance_selection_keep_tab_active')],
      );
    const selectionPeriod = selection
      ? resolveSelectionPeriod(selection, current.candidates, storedConfig.analysisPeriod)
      : undefined;
    if (selection && selectionPeriod?.source === 'config')
      throw new AnalysisInputError(
        'E_SELECTION_PERIOD_UNRECOGNIZED',
        localizedMessage('error_selection_period_unrecognized'),
        [localizedMessage('guidance_selection_period_visible')],
      );
    if (selection && !selectionPeriod?.period)
      throw new AnalysisInputError(
        'E_SELECTION_PERIOD_UNSUPPORTED',
        localizedMessage('error_selection_period_unsupported', [selectionPeriod?.raw ?? '']),
        [localizedMessage('guidance_selection_supported_period')],
      );
    const userConfig = selection
      ? {
          analysisPeriod: selectionPeriod!.period!,
          analysisCandleCount: MAX_ANALYSIS_CANDLES,
        }
      : storedConfig;
    const configError = getAnalysisConfigError(userConfig);
    if (configError) throw new AnalysisInputError('E_ANALYSIS_CONFIG_INVALID', configError);
    if (selection?.image && selection.image.detectedCandles < MIN_ANALYSIS_CANDLES)
      throw new AnalysisInputError(
        'E_SELECTION_CANDLES_INSUFFICIENT',
        localizedMessage('error_selection_candles_insufficient', [
          selection.image.detectedCandles,
          MIN_ANALYSIS_CANDLES,
          MIN_ANALYSIS_CANDLES - 1,
        ]),
        [
          localizedMessage('guidance_selection_include_five'),
          localizedMessage('guidance_selection_clear_bodies'),
        ],
      );
    const knownSelectionCandles = selection?.image?.candleColors.filter(
      (color) => color !== 'unknown',
    ).length;
    if (selection?.image && (knownSelectionCandles ?? 0) < MIN_SELECTION_DATE_EVIDENCE)
      throw new AnalysisInputError(
        'E_SELECTION_DATE_EVIDENCE_INSUFFICIENT',
        localizedMessage('error_selection_date_evidence_insufficient', [
          knownSelectionCandles ?? 0,
          MIN_SELECTION_DATE_EVIDENCE,
        ]),
        [
          localizedMessage('guidance_selection_clear_bodies'),
          localizedMessage('guidance_selection_main_chart'),
        ],
      );
    let normalized: MarketData | undefined;
    let activeError: unknown;
    if ((site === 'binance' || site === 'tonghuashun') && pageUrl) {
      try {
        normalized = await fetchActiveMarketData(pageUrl, userConfig, fetch, undefined, signal);
      } catch (error) {
        throwIfAborted(signal);
        activeError = error;
      }
    }

    await assertPageStillActive(tabId, current, pageUrl, revision);
    throwIfAborted(signal);

    if (!normalized) {
      normalized = selectBestPassiveMarketData(
        current.candidates,
        site,
        pageUrl,
        selectionPeriod?.period,
      );
      if (activeError)
        normalized?.quality.warnings.unshift(localizedMessage('warning_active_request_fallback'));
    }

    if (!normalized) {
      if (activeError instanceof ActiveMarketDataError) throw activeError;
      throw new AnalysisInputError(
        'E_MARKET_DATA_NOT_FOUND',
        site === 'tradingview'
          ? localizedMessage('error_market_data_tradingview_not_found')
          : localizedMessage('error_market_data_not_found'),
      );
    }

    let analysisConfig = resolveAnalysisConfigForMarket(
      site,
      storedConfig,
      normalized.candles.length,
    );
    if (selection) {
      normalized = { ...normalized, period: selectionPeriod!.period };
      const interpretation = interpretSelectionRange(
        selection,
        normalized,
        site,
        normalized.source.adapterId.startsWith('passive-'),
      );
      if (!interpretation)
        throw new AnalysisInputError(
          'E_SELECTION_RANGE_UNRECOGNIZED',
          localizedMessage('error_selection_range_unrecognized'),
          [
            localizedMessage('guidance_selection_main_chart'),
            localizedMessage('guidance_selection_clear_bodies'),
            localizedMessage('guidance_selection_period_visible'),
            localizedMessage('guidance_selection_avoid_overlays'),
            localizedMessage('guidance_selection_recent_range'),
          ],
        );
      if (interpretation.candleCount < MIN_ANALYSIS_CANDLES)
        throw new AnalysisInputError(
          'E_SELECTION_CANDLES_INSUFFICIENT',
          localizedMessage('error_selection_candles_insufficient', [
            interpretation.candleCount,
            MIN_ANALYSIS_CANDLES,
            MIN_ANALYSIS_CANDLES - 1,
          ]),
          [localizedMessage('guidance_selection_include_five')],
        );
      if (site === 'binance') {
        const rangeConfig = {
          analysisPeriod: interpretation.period,
          analysisCandleCount: interpretation.candleCount,
        };
        normalized =
          (await fetchActiveMarketData(
            pageUrl,
            rangeConfig,
            fetch,
            {
              startTime: interpretation.startTime,
              endTime: interpretation.endTime,
            },
            signal,
          )) ?? normalized;
      }
      const selectedCandles = normalized.candles.filter(
        (candle) =>
          candle.timestamp >= interpretation.startTime &&
          candle.timestamp <= interpretation.endTime,
      );
      if (selectedCandles.length < MIN_ANALYSIS_CANDLES)
        throw new AnalysisInputError(
          'E_SELECTION_CANDLES_INSUFFICIENT',
          localizedMessage('error_selection_candles_insufficient', [
            selectedCandles.length,
            MIN_ANALYSIS_CANDLES,
            MIN_ANALYSIS_CANDLES - 1,
          ]),
          [
            localizedMessage('guidance_selection_date_range_missing'),
            localizedMessage('guidance_selection_recent_range'),
          ],
        );
      normalized = {
        ...normalized,
        candles: selectedCandles,
        quality: assessQuality(selectedCandles, MIN_ANALYSIS_CANDLES),
      };
      analysisConfig = {
        analysisPeriod: interpretation.period,
        analysisCandleCount: selectedCandles.length,
      };
      throwIfAborted(signal);
      current.selection = { ...selection, interpretation, recognitionStatus: 'ready' };
      broadcastSelection(tabId, current.selection);
    }
    const analysis = runMarketAnalysis(normalized, analysisConfig);
    throwIfAborted(signal);
    await assertPageStillActive(tabId, current, pageUrl, revision);
    throwIfAborted(signal);
    return {
      ok: true,
      data: {
        marketData: analysis.marketData,
        result: analysis.result,
        selection: current.selection,
        context: {
          tabId,
          pageUrl,
          site,
          mode: selection
            ? 'selection'
            : site === 'tradingview'
              ? 'current-chart'
              : 'configured-request',
        },
      },
    };
  } catch (error) {
    if (isAbortError(error))
      return {
        ok: false,
        error: {
          code: 'E_ANALYSIS_CANCELLED',
          message: localizedMessage('error_analysis_cancelled'),
          recoverable: true,
        },
      };
    const known = error instanceof AnalysisInputError || error instanceof ActiveMarketDataError;
    console.error('K-line analysis failed', error);
    return {
      ok: false,
      error: {
        code: known ? error.code : 'E_ANALYSIS_FAILED',
        message: known ? error.userMessage : localizedMessage('error_analysis_failed'),
        guidance: error instanceof AnalysisInputError ? error.guidance : undefined,
        recoverable: true,
      },
    };
  }
}
