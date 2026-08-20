import React, { useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CandlestickChart,
  MousePointer2,
  RotateCcw,
  Settings,
  ShieldAlert,
  ToggleRight,
  X,
} from 'lucide-react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  type UTCTimestamp,
} from 'lightweight-charts';
import { createMessage } from '../shared/messages';
import type { ExtensionMessage } from '../shared/messages';
import { localizeDocument, t, translateMessage } from '../shared/i18n';
import type { MessageKey } from '../shared/i18n-types';
import { detectMarketSite, isSameMarketPage, type MarketSite } from '../core/adapter/sites';
import { normalizeMarketPeriod } from '../core/selection/period';
import {
  getAnalysisConfigError,
  getRunConfigError,
  loadStoredUserConfig,
  resolveUserConfigForSite,
} from '../core/config';
import {
  DEFAULT_CONFIG,
  MAX_ANALYSIS_CANDLES,
  MIN_ANALYSIS_CANDLES,
  type AnalysisPeriod,
  type AnalysisRunMode,
  type MarketData,
  type RawMarketPayload,
  type SelectionRange,
  type UserConfig,
  type WyckoffAnalysisResult,
} from '../core/model/types';
import {
  hasConflictingPage,
  isSameTabContext,
  resetTabScopedState,
  selectionUpdatePatch,
  useDrawerStore,
} from './store';
import { getMarketColorTheme } from './market-colors';
import { sendToContentWithRecovery } from './content-connection';
import {
  ACTION_MESSAGE_KEYS,
  EVIDENCE_MESSAGE_KEYS,
  SITE_MESSAGE_KEYS,
  STAGE_MESSAGE_KEYS,
} from './presentation';
import './styles.css';

const extensionReady = () =>
  location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined';
if (extensionReady()) localizeDocument();
type ActiveTabContext = {
  tabId: number;
  page?: { url: string; title: string };
};

// Drawer 始终以当前活动标签页作为查询和分析上下文，失败时抛出可展示的用户错误。
async function getActiveTabContext(): Promise<ActiveTabContext> {
  if (!extensionReady()) throw new Error(t('error_extension_unavailable'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error(t('error_analyzable_tab_not_found'));
  return {
    tabId: tab.id,
    page: tab.url ? { url: tab.url, title: tab.title ?? '' } : undefined,
  };
}

const errorMessage = (error: unknown, fallback: MessageKey) =>
  error instanceof Error && error.message ? error.message : t(fallback);

const responseError = (response: {
  error?: { message?: Parameters<typeof translateMessage>[0] };
}) => (response.error?.message ? translateMessage(response.error.message) : undefined);

const responseGuidance = (response: {
  error?: { guidance?: Parameters<typeof translateMessage>[0][] };
}) => response.error?.guidance?.map((item) => translateMessage(item));

const candidatesForSite = (candidates: RawMarketPayload[], url?: string) => {
  const site = detectMarketSite(url);
  return candidates.filter(
    (candidate) =>
      candidate.siteId === site &&
      (!candidate.pageUrl || !url || isSameMarketPage(candidate.pageUrl, url)),
  );
};

const capturedCandleCount = (candidates: RawMarketPayload[]) =>
  candidates.reduce(
    (largest, candidate) =>
      Math.max(largest, Array.isArray(candidate.raw) ? candidate.raw.length : 0),
    0,
  );

const cancelBackgroundAnalysis = (tabId?: number) => {
  if (!extensionReady() || tabId === undefined) return;
  try {
    void chrome.runtime
      .sendMessage({ ...createMessage('CANCEL_ANALYSIS', 'drawer'), tabId })
      .catch(() => undefined);
  } catch {
    // The panel may be closing while Chrome invalidates the extension context.
  }
};

const cancelPageSelection = async (tabId?: number) => {
  if (!extensionReady() || tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, createMessage('CANCEL_SELECTION', 'drawer'));
  } catch {
    // A missing receiver also means there cannot be a live selection overlay to close.
  }
};

function App() {
  const s = useDrawerStore();
  const analysisSequence = useRef(0);
  const syncSequence = useRef(0);
  const resetInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const autoSelectionRuns = useRef(new Set<number>());
  const analyzeRef = useRef<(mode: AnalysisRunMode, selectionCapturedAt?: number) => Promise<void>>(
    async () => undefined,
  );
  const windowId = useRef<number | undefined>(undefined);
  const site = detectMarketSite(s.page?.url);
  const isTradingView = site === 'tradingview';
  const supportsActiveRequest = site === 'binance' || site === 'tonghuashun';
  const canAnalyze = !s.syncing && (supportsActiveRequest || s.candidates.length > 0);

  useEffect(() => {
    let resetFrame = 0;
    const resetHorizontalScroll = () => {
      window.cancelAnimationFrame(resetFrame);
      resetFrame = window.requestAnimationFrame(() => {
        document.documentElement.scrollLeft = 0;
        document.body.scrollLeft = 0;
        window.scrollTo(0, window.scrollY);
      });
    };
    resetHorizontalScroll();
    window.addEventListener('resize', resetHorizontalScroll, { passive: true });
    return () => {
      window.removeEventListener('resize', resetHorizontalScroll);
      window.cancelAnimationFrame(resetFrame);
    };
  }, []);

  const syncActiveTab = useCallback(async (hintTabId?: number) => {
    const requestId = ++syncSequence.current;
    const initial = useDrawerStore.getState();
    if (hintTabId !== undefined && initial.activeTabId !== hintTabId) {
      analysisSequence.current += 1;
      autoSelectionRuns.current.clear();
      initial.set(resetTabScopedState(hintTabId));
    }
    try {
      const context = await getActiveTabContext();
      if (requestId !== syncSequence.current) return false;
      let current = useDrawerStore.getState();
      const changed = !isSameTabContext(current, context.tabId, context.page);
      if (changed) {
        analysisSequence.current += 1;
        autoSelectionRuns.current.clear();
        current.set(resetTabScopedState(context.tabId, context.page));
      } else {
        current.set({ syncing: true, error: undefined });
      }

      const response = await chrome.runtime.sendMessage({
        ...createMessage('GET_STATE', 'drawer', context.page),
        tabId: context.tabId,
      });
      if (!response?.ok) throw new Error(responseError(response) ?? t('error_refresh_page_state'));
      const confirmed = await getActiveTabContext();
      if (
        requestId !== syncSequence.current ||
        confirmed.tabId !== context.tabId ||
        hasConflictingPage(confirmed.page, context.page)
      )
        return false;

      // Content Script 的 location.href 是 SPA 最终页面，优先于 tabs API 的瞬时 URL 快照。
      const page = response.data?.page ?? context.page;
      const nextSite = detectMarketSite(page?.url);
      const candidates = candidatesForSite(response.data?.candidates ?? [], page?.url);
      current = useDrawerStore.getState();
      const config = resolveUserConfigForSite(nextSite, current.config);
      current.set({
        activeTabId: context.tabId,
        page,
        candidates,
        selection: response.data?.selection,
        config,
        syncing: false,
        error: undefined,
        errorGuidance: undefined,
      });
      const selection = response.data?.selection as SelectionRange | undefined;
      if (
        selection?.recognitionStatus === 'ready' &&
        selection.image &&
        !selection.interpretation &&
        !autoSelectionRuns.current.has(selection.capturedAt)
      ) {
        autoSelectionRuns.current.add(selection.capturedAt);
        queueMicrotask(() => void analyzeRef.current('selection', selection.capturedAt));
      }
      if (
        nextSite === 'tradingview' &&
        (current.config.analysisPeriod !== config.analysisPeriod ||
          current.config.analysisCandleCount !== config.analysisCandleCount)
      )
        void chrome.storage.local.set({ 'kla:userConfig': config });
      return true;
    } catch (error) {
      if (requestId === syncSequence.current)
        useDrawerStore
          .getState()
          .set({ syncing: false, error: errorMessage(error, 'error_sync_tab') });
      return false;
    }
  }, []);

  const closePanel = async () => {
    const current = useDrawerStore.getState();
    await cancelPageSelection(current.activeTabId);
    if (current.busy) {
      analysisSequence.current += 1;
      cancelBackgroundAnalysis(current.activeTabId);
    }
    if (!extensionReady()) return;
    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow.id !== undefined && typeof chrome.sidePanel.close === 'function') {
        await chrome.sidePanel.close({ windowId: currentWindow.id });
        return;
      }
    } catch (error) {
      console.warn('Unable to close the analysis panel through the Side Panel API.', error);
    }
    window.close();
  };
  const resetAnalyzer = async () => {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    const resetSequence = ++analysisSequence.current;
    const current = useDrawerStore.getState();
    const tabId = current.activeTabId;
    autoSelectionRuns.current.clear();
    current.set({
      config: { ...DEFAULT_CONFIG },
      candidates: [],
      busy: false,
      syncing: true,
      error: undefined,
      errorGuidance: undefined,
      configError: undefined,
      selection: undefined,
      marketData: undefined,
      result: undefined,
    });
    if (!extensionReady()) {
      current.set({ syncing: false });
      resetInFlight.current = false;
      return;
    }
    try {
      const [storageResult, resetResult, selectionResult] = await Promise.allSettled([
        chrome.storage.local.set({ 'kla:userConfig': DEFAULT_CONFIG }),
        tabId === undefined
          ? Promise.resolve({ ok: true })
          : chrome.runtime.sendMessage({
              ...createMessage('RESET_ANALYSIS', 'drawer'),
              tabId,
            }),
        cancelPageSelection(tabId),
      ]);
      const resetResponse = resetResult.status === 'fulfilled' ? resetResult.value : undefined;
      if (resetSequence === analysisSequence.current)
        useDrawerStore.getState().set({
          syncing: false,
          error:
            storageResult.status === 'rejected' ||
            resetResult.status === 'rejected' ||
            selectionResult.status === 'rejected' ||
            resetResponse?.ok !== true
              ? t('error_reset_analyzer')
              : undefined,
        });
    } catch {
      if (resetSequence === analysisSequence.current)
        useDrawerStore.getState().set({ syncing: false, error: t('error_reset_analyzer') });
    } finally {
      resetInFlight.current = false;
    }
  };

  const cancelAnalysis = async () => {
    if (cancelInFlight.current) return;
    cancelInFlight.current = true;
    const cancelSequence = ++analysisSequence.current;
    const current = useDrawerStore.getState();
    const tabId = current.activeTabId;
    autoSelectionRuns.current.clear();
    current.set({
      busy: true,
      error: undefined,
      errorGuidance: undefined,
      marketData: undefined,
      result: undefined,
      selection: undefined,
    });
    if (!extensionReady() || tabId === undefined) {
      current.set({ busy: false });
      cancelInFlight.current = false;
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        ...createMessage('CANCEL_ANALYSIS', 'drawer'),
        tabId,
      });
      if (cancelSequence === analysisSequence.current)
        useDrawerStore.getState().set({
          busy: false,
          error: response?.ok === true ? undefined : t('error_cancel_analysis'),
        });
    } catch {
      if (cancelSequence === analysisSequence.current)
        useDrawerStore.getState().set({ busy: false, error: t('error_cancel_analysis') });
    }
    cancelInFlight.current = false;
  };

  useEffect(() => {
    if (!extensionReady()) return;
    void (async () => {
      try {
        const currentWindow = await chrome.windows.getCurrent();
        windowId.current = currentWindow.id ?? undefined;
        const values = await chrome.storage.local.get('kla:userConfig');
        const saved = values['kla:userConfig'] as Partial<UserConfig> | undefined;
        const config = loadStoredUserConfig(saved);
        const configError = getAnalysisConfigError(config);
        useDrawerStore
          .getState()
          .set({ config, configError: configError ? translateMessage(configError) : undefined });
        await syncActiveTab();
      } catch (error) {
        useDrawerStore
          .getState()
          .set({ syncing: false, error: errorMessage(error, 'error_initialize_page') });
      }
    })();
    const messageListener = (m: ExtensionMessage, sender: chrome.runtime.MessageSender) => {
      const current = useDrawerStore.getState();
      const messageTabId = sender.tab?.id ?? m.tabId;
      if (messageTabId === undefined || messageTabId !== current.activeTabId) return;
      if (m.type === 'SELECTION_UPDATED') {
        const selection = m.payload as SelectionRange;
        if (
          current.selection &&
          (current.selection.capturedAt > selection.capturedAt ||
            (current.selection.capturedAt === selection.capturedAt &&
              current.selection.interpretation &&
              !selection.interpretation))
        )
          return;
        current.set(selectionUpdatePatch(selection));
        if (
          selection.recognitionStatus === 'ready' &&
          selection.image &&
          !selection.interpretation &&
          !autoSelectionRuns.current.has(selection.capturedAt)
        ) {
          autoSelectionRuns.current.add(selection.capturedAt);
          queueMicrotask(() => void analyzeRef.current('selection', selection.capturedAt));
        }
        return;
      }
      if (m.type === 'PAGE_DETECTED') {
        const page = m.payload as ActiveTabContext['page'];
        if (!page?.url) return;
        analysisSequence.current += 1;
        current.set(resetTabScopedState(messageTabId, page));
        void syncActiveTab(messageTabId);
        return;
      }
      if (m.type === 'MARKET_DATA_CANDIDATES' && Array.isArray(m.payload))
        current.set({
          candidates: candidatesForSite(m.payload as RawMarketPayload[], current.page?.url),
        });
    };
    const activatedListener = (activeInfo: { tabId: number; windowId: number }) => {
      if (windowId.current !== undefined && activeInfo.windowId !== windowId.current) return;
      const current = useDrawerStore.getState();
      void cancelPageSelection(current.activeTabId);
      autoSelectionRuns.current.clear();
      if (current.busy) cancelBackgroundAnalysis(current.activeTabId);
      analysisSequence.current += 1;
      current.set(resetTabScopedState(activeInfo.tabId));
      void syncActiveTab(activeInfo.tabId);
    };
    const updatedListener = (
      tabId: number,
      changeInfo: { status?: string; url?: string },
      tab: chrome.tabs.Tab,
    ) => {
      const current = useDrawerStore.getState();
      if (tabId !== current.activeTabId || changeInfo.url === undefined) return;
      void cancelPageSelection(tabId);
      autoSelectionRuns.current.clear();
      if (current.busy) cancelBackgroundAnalysis(tabId);
      analysisSequence.current += 1;
      current.set(resetTabScopedState(tabId, { url: changeInfo.url, title: tab.title ?? '' }));
      void syncActiveTab(tabId);
    };
    chrome.runtime.onMessage.addListener(messageListener);
    chrome.tabs.onActivated.addListener(activatedListener);
    chrome.tabs.onUpdated.addListener(updatedListener);
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.tabs.onActivated.removeListener(activatedListener);
      chrome.tabs.onUpdated.removeListener(updatedListener);
    };
  }, [syncActiveTab]);

  const select = async () => {
    try {
      const { tabId } = await getActiveTabContext();
      await sendToContentWithRecovery(tabId, createMessage('START_SELECTION', 'drawer'));
      s.set({
        selection: undefined,
        marketData: undefined,
        result: undefined,
        error: undefined,
        errorGuidance: undefined,
      });
    } catch (error) {
      console.warn('Unable to connect the candlestick selector to the market page.', error);
      s.set({ error: t('error_start_selection') });
    }
  };
  const analyze = async (
    config = useDrawerStore.getState().config,
    mode: AnalysisRunMode = 'manual',
    selectionCapturedAt?: number,
  ) => {
    let requestSequence = ++analysisSequence.current;
    try {
      const { tabId, page: observedPage } = await getActiveTabContext();
      let current = useDrawerStore.getState();
      if (!isSameTabContext(current, tabId, observedPage)) {
        await syncActiveTab(tabId);
        current = useDrawerStore.getState();
        requestSequence = ++analysisSequence.current;
      }
      const page = observedPage ?? current.page;
      if (!isSameTabContext(current, tabId, observedPage) || current.syncing || !page?.url)
        throw new Error(t('error_tab_switching'));
      const requestSite = detectMarketSite(page?.url);
      const requestConfig = resolveUserConfigForSite(requestSite, config);
      const selectionMode = mode === 'selection';
      if (
        selectionMode &&
        (!current.selection ||
          (selectionCapturedAt !== undefined &&
            current.selection.capturedAt !== selectionCapturedAt))
      )
        return;
      const configError = getRunConfigError(requestConfig, selectionMode);
      if (configError) throw new Error(translateMessage(configError));
      if (!selectionMode) await cancelPageSelection(tabId);
      current.set({
        busy: true,
        error: undefined,
        errorGuidance: undefined,
        marketData: undefined,
        result: undefined,
        ...(selectionMode ? {} : { selection: undefined }),
      });
      if (
        !selectionMode &&
        (requestConfig.analysisPeriod !== current.config.analysisPeriod ||
          requestConfig.analysisCandleCount !== current.config.analysisCandleCount)
      ) {
        current.set({ config: requestConfig });
        if (extensionReady()) void chrome.storage.local.set({ 'kla:userConfig': requestConfig });
      }
      const response = await chrome.runtime.sendMessage({
        ...createMessage('RUN_ANALYSIS', 'drawer', {
          config: requestConfig,
          pageUrl: page?.url,
          mode,
          selectionCapturedAt,
        }),
        tabId,
      });
      if (requestSequence !== analysisSequence.current) return;
      current = useDrawerStore.getState();
      if (!isSameTabContext(current, tabId, page)) return;
      if (response?.ok) {
        if (
          response.data?.context?.tabId !== tabId ||
          !isSameMarketPage(response.data?.context?.pageUrl, page?.url)
        )
          throw new Error(t('error_result_context_changed'));
        current.set({
          busy: false,
          error: undefined,
          errorGuidance: undefined,
          page: page ?? current.page,
          marketData: response.data.marketData,
          result: response.data.result,
          selection: response.data.selection,
        });
        return;
      }
      current.set({
        busy: false,
        error: responseError(response) ?? t('error_analysis_retry'),
        errorGuidance: responseGuidance(response),
        marketData: undefined,
        result: undefined,
      });
    } catch (error) {
      if (requestSequence !== analysisSequence.current) return;
      useDrawerStore.getState().set({
        busy: false,
        error: errorMessage(error, 'error_analysis_service'),
        errorGuidance: undefined,
        marketData: undefined,
        result: undefined,
      });
    }
  };
  useEffect(() => {
    analyzeRef.current = (mode, selectionCapturedAt) =>
      analyze(useDrawerStore.getState().config, mode, selectionCapturedAt);
  });
  const applyConfig = (config: UserConfig) => {
    if (isTradingView) {
      s.set({ config: { ...DEFAULT_CONFIG } });
      return;
    }
    const configError = getAnalysisConfigError(config);
    s.set({
      config,
      configError: configError ? translateMessage(configError) : undefined,
    });
    if (!configError && extensionReady())
      void chrome.storage.local.set({ 'kla:userConfig': config });
  };
  return (
    <main className="drawer-shell">
      <header>
        <div>
          <span className="eyebrow">K LINE ANALYZER</span>
          <h1>{t('drawer_title')}</h1>
        </div>
        <div className="header-actions">
          <button
            className="icon panel-toggle"
            type="button"
            title={t('drawer_close_panel')}
            aria-label={t('drawer_close_panel')}
            onClick={closePanel}
          >
            <ToggleRight />
          </button>
          <button
            className="icon"
            data-testid="reset-analyzer"
            type="button"
            disabled={s.syncing}
            title={t('drawer_reset_analyzer')}
            aria-label={t('drawer_reset_analyzer')}
            onClick={() => void resetAnalyzer()}
          >
            <RotateCcw />
          </button>
        </div>
      </header>
      <section className="status" data-testid="market-status" data-site={site}>
        <span className={canAnalyze ? 'dot ok' : 'dot'} />
        <span>
          {s.syncing
            ? t('status_syncing')
            : supportsActiveRequest
              ? t('status_active_site', [t(SITE_MESSAGE_KEYS[site] ?? 'site_binance')])
              : isTradingView
                ? s.candidates.length
                  ? t(
                      s.candidates.length === 1
                        ? 'status_tradingview_captured_one'
                        : 'status_tradingview_captured_many',
                      [s.candidates.length],
                    )
                  : t('status_tradingview_waiting')
                : s.candidates.length
                  ? t(
                      s.candidates.length === 1
                        ? 'status_passive_captured_one'
                        : 'status_passive_captured_many',
                      [s.candidates.length],
                    )
                  : t('status_active_unsupported')}
        </span>
      </section>
      <p className="privacy-note">{t('drawer_privacy')}</p>
      <div className="actions">
        <button
          data-testid="select-candles"
          disabled={s.syncing || s.busy}
          onClick={() => void select()}
        >
          <MousePointer2 />
          {t('drawer_select_candles')}
        </button>
        <button
          className="primary"
          data-testid="run-analysis"
          disabled={s.busy || !canAnalyze || Boolean(s.configError)}
          onClick={() => void analyze(s.config, 'manual')}
        >
          <CandlestickChart />
          {s.busy ? t('drawer_analyzing') : t('drawer_start_analysis')}
        </button>
      </div>
      {s.configError && (
        <p className="config-validation" role="status" data-testid="config-validation">
          <ShieldAlert />
          {s.configError}
        </p>
      )}
      <SelectionSummary selection={s.selection} />
      {s.busy && <AnalysisLoading selectionMode={Boolean(s.selection)} onCancel={cancelAnalysis} />}
      {s.error && (
        <section className="error-block" role="alert">
          <p className="error">
            <ShieldAlert />
            {s.error}
          </p>
          {s.errorGuidance?.length ? (
            <ol>
              {s.errorGuidance.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          ) : null}
        </section>
      )}
      {!s.busy && <Result result={s.result} site={site} selectionReady={Boolean(s.selection)} />}
      {!s.busy && <AnalysisWindow data={s.marketData} selection={s.selection} />}
      {!s.busy && <Chart data={s.marketData} />}
      <Config
        site={site}
        capturedCandles={capturedCandleCount(s.candidates)}
        onChange={applyConfig}
      />
    </main>
  );
}

function AnalysisLoading({
  selectionMode,
  onCancel,
}: {
  selectionMode: boolean;
  onCancel: () => Promise<void>;
}) {
  return (
    <section
      className="analysis-loading"
      data-testid="analysis-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loading-spinner" aria-hidden="true" />
      <h2>{t(selectionMode ? 'drawer_loading_selection_title' : 'drawer_loading_title')}</h2>
      <p>{t('drawer_loading_description')}</p>
      <button
        className="cancel-analysis"
        data-testid="cancel-analysis"
        type="button"
        onClick={() => void onCancel()}
      >
        <X />
        {t('drawer_cancel_analysis')}
      </button>
    </section>
  );
}

function Result({
  result,
  site,
  selectionReady,
}: {
  result?: WyckoffAnalysisResult;
  site: MarketSite;
  selectionReady: boolean;
}) {
  if (!result) {
    if (selectionReady) return null;
    return (
      <section className="empty" data-testid="analysis-empty">
        <CandlestickChart />
        <h2>{t('drawer_empty_title')}</h2>
        <p>{t('drawer_empty_description')}</p>
      </section>
    );
  }
  const colors = getMarketColorTheme(site);
  const signalColorStyle = {
    '--signal-rising': colors.rising,
    '--signal-falling': colors.falling,
  } as React.CSSProperties;
  return (
    <>
      <section className={`signal ${result.signal.action.toLowerCase()}`} style={signalColorStyle}>
        <div>
          <span>{t('drawer_strategy_conclusion')}</span>
          <strong data-testid="analysis-action">
            {t(ACTION_MESSAGE_KEYS[result.signal.action])}
          </strong>
        </div>
        <div>
          <span>{t('drawer_stage')}</span>
          <strong data-testid="analysis-stage">{t(STAGE_MESSAGE_KEYS[result.stage])}</strong>
        </div>
        <div>
          <span>{t('drawer_confidence')}</span>
          <strong data-testid="analysis-confidence">{result.signal.confidence}</strong>
        </div>
      </section>
      <section>
        <h2 data-testid="analysis-evidence-heading">{t('drawer_analysis_evidence')}</h2>
        {result.evidence.map((e) => {
          const messages = EVIDENCE_MESSAGE_KEYS[e.code];
          return (
            <article key={e.code} data-evidence-code={e.code}>
              <b>{t(messages.label)}</b>
              <p>{t(messages.detail)}</p>
            </article>
          );
        })}
        {result.warnings.map((w) => (
          <p className="warning" key={`${w.key}-${w.substitutions?.join('-') ?? ''}`}>
            {translateMessage(w)}
          </p>
        ))}
      </section>
    </>
  );
}

const formatMarketTime = (timestamp: number, period: AnalysisPeriod, timezone?: string) => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(period === '30m' || period === '1h' || period === '4h'
      ? { hour: '2-digit', minute: '2-digit' }
      : {}),
    ...(timezone ? { timeZone: timezone } : {}),
  };
  const locale = extensionReady() ? chrome.i18n.getUILanguage() : navigator.language;
  try {
    return new Intl.DateTimeFormat(locale, options).format(timestamp);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat(locale, options).format(timestamp);
  }
};

function AnalysisWindow({ data, selection }: { data?: MarketData; selection?: SelectionRange }) {
  if (!data?.candles.length) return null;
  const period = normalizeMarketPeriod(data.period);
  const formatPeriod = period ?? '30m';
  const first = data.candles[0];
  const last = data.candles.at(-1)!;
  return (
    <section className="analysis-window" data-testid="analysis-window">
      <h2>{t('drawer_analysis_window')}</h2>
      <p>
        {t('drawer_analysis_window_summary', [
          data.symbol ?? t('drawer_unknown_symbol'),
          period ? t(PERIOD_MESSAGE_KEYS[period]) : (data.period ?? t('drawer_unknown_period')),
          data.candles.length,
          formatMarketTime(first.timestamp, formatPeriod, data.timezone),
          formatMarketTime(last.timestamp, formatPeriod, data.timezone),
          data.timezone ?? t('drawer_local_timezone'),
        ])}
      </p>
      <span>
        {t(selection?.interpretation ? 'drawer_window_selection' : 'drawer_window_manual')}
      </span>
    </section>
  );
}
// 图表仅消费标准化数据，不直接依赖任何行情网站协议。
function Chart({ data }: { data?: MarketData }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !data?.candles.length) return;
    const colors = getMarketColorTheme(data.siteId);
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 260,
      layout: { background: { type: ColorType.Solid, color: '#101820' }, textColor: '#aab6be' },
      grid: { vertLines: { color: '#243039' }, horzLines: { color: '#243039' } },
      rightPriceScale: {
        borderColor: '#33414b',
        scaleMargins: { top: 0.08, bottom: 0.28 },
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.rising,
      downColor: colors.falling,
      wickUpColor: colors.rising,
      wickDownColor: colors.falling,
      borderVisible: false,
    });
    candles.setData(
      data.candles.map((c) => ({
        time: Math.trunc(c.timestamp / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    if (data.candles.some((c) => c.volume > 0)) {
      const volumes = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });
      volumes.priceScale().applyOptions({
        visible: false,
        scaleMargins: { top: 0.78, bottom: 0 },
      });
      volumes.setData(
        data.candles.map((c) => ({
          time: Math.trunc(c.timestamp / 1000) as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? colors.risingVolume : colors.fallingVolume,
        })),
      );
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);
  return data ? (
    <section>
      <h2>{t('drawer_chart_title')}</h2>
      <p className="chart-summary">
        {t(
          data.siteId === 'tradingview'
            ? 'drawer_chart_summary_tradingview'
            : 'drawer_chart_summary',
          [data.candles.length],
        )}
      </p>
      {!data.candles.some((c) => c.volume > 0) && (
        <p className="warning">{t('drawer_chart_no_volume')}</p>
      )}
      <div
        className="market-chart"
        data-testid="market-chart"
        data-candle-count={data.candles.length}
        ref={ref}
      />
    </section>
  ) : null;
}
function Config({
  site,
  capturedCandles,
  onChange,
}: {
  site: MarketSite;
  capturedCandles: number;
  onChange: (config: UserConfig) => void;
}) {
  const s = useDrawerStore();
  const disabled = site === 'tradingview';
  const update = (key: keyof UserConfig, value: UserConfig[keyof UserConfig]) => {
    const config: UserConfig = { ...s.config, [key]: value };
    onChange(config);
  };
  return (
    <details>
      <summary>
        <Settings />
        {t('drawer_strategy_parameters')}
      </summary>
      <div className={`config-body${disabled ? ' is-disabled' : ''}`}>
        <div className="config-heading">
          <strong>{t('drawer_strategy_settings')}</strong>
          <span>
            {disabled ? t('drawer_settings_locked_tradingview') : t('drawer_settings_description')}
          </span>
        </div>
        {disabled ? (
          <div className="chart-context-settings" aria-label={t('drawer_tradingview_rules')}>
            <div>
              <span>{t('drawer_market_period')}</span>
              <strong>{s.marketData?.period ?? t('drawer_follow_current_chart')}</strong>
            </div>
            <div>
              <span>{t('drawer_analysis_candle_count')}</span>
              <strong>
                {capturedCandles
                  ? t('drawer_captured_candles', [Math.min(capturedCandles, MAX_ANALYSIS_CANDLES)])
                  : t('drawer_waiting_chart_data')}
              </strong>
            </div>
          </div>
        ) : (
          <>
            <label>
              {t('drawer_market_period')}
              <select
                value={s.config.analysisPeriod}
                onChange={(event) =>
                  update(
                    'analysisPeriod',
                    event.currentTarget.value as UserConfig['analysisPeriod'],
                  )
                }
              >
                <option value="30m">{t('period_30_minutes')}</option>
                <option value="1h">{t('period_hour')}</option>
                <option value="4h">{t('period_4_hours')}</option>
                <option value="1d">{t('period_day')}</option>
                <option value="1w">{t('period_week')}</option>
                <option value="1M">{t('period_month')}</option>
              </select>
            </label>
            <label>
              {t('drawer_analysis_candle_count')}
              <input
                type="number"
                min={MIN_ANALYSIS_CANDLES}
                max={MAX_ANALYSIS_CANDLES}
                step={1}
                aria-invalid={Boolean(s.configError)}
                value={
                  Number.isFinite(s.config.analysisCandleCount) ? s.config.analysisCandleCount : ''
                }
                onChange={(event) => {
                  update(
                    'analysisCandleCount',
                    event.currentTarget.value === ''
                      ? Number.NaN
                      : event.currentTarget.valueAsNumber,
                  );
                }}
              />
              {s.configError && <span className="field-error">{s.configError}</span>}
            </label>
          </>
        )}
      </div>
    </details>
  );
}

const PERIOD_MESSAGE_KEYS: Record<AnalysisPeriod, MessageKey> = {
  '30m': 'period_30_minutes',
  '1h': 'period_hour',
  '4h': 'period_4_hours',
  '1d': 'period_day',
  '1w': 'period_week',
  '1M': 'period_month',
};

function SelectionSummary({ selection }: { selection?: SelectionRange }) {
  if (!selection) return null;
  if (selection.recognitionStatus === 'capturing')
    return <section className="selection-summary">{t('drawer_selection_capturing')}</section>;
  if (selection.recognitionStatus === 'failed')
    return <section className="selection-summary warning">{t('drawer_selection_failed')}</section>;
  const interpretation = selection.interpretation;
  return (
    <section
      className="selection-summary"
      data-testid="selection-summary"
      data-detected-candles={selection.image?.detectedCandles ?? 0}
    >
      <h2>{t('drawer_selection_ready')}</h2>
      {selection.image?.dataUrl && (
        <img src={selection.image.dataUrl} alt={t('drawer_selection_ready')} />
      )}
      <p>
        {interpretation
          ? t('drawer_selection_detected', [
              t(PERIOD_MESSAGE_KEYS[interpretation.period]),
              interpretation.candleCount,
              formatMarketTime(interpretation.startTime, interpretation.period),
              formatMarketTime(interpretation.endTime, interpretation.period),
            ])
          : t('drawer_selection_image_candles', [selection.image?.detectedCandles ?? 0])}
      </p>
    </section>
  );
}

class DrawerErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('The analysis panel stopped rendering.', error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="drawer-shell fatal-recovery" data-testid="drawer-recovery">
        <ShieldAlert aria-hidden="true" />
        <h1>{t('drawer_recovery_title')}</h1>
        <p>{t('drawer_recovery_description')}</p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          <RotateCcw />
          {t('drawer_recovery_action')}
        </button>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DrawerErrorBoundary>
      <App />
    </DrawerErrorBoundary>
  </React.StrictMode>,
);
