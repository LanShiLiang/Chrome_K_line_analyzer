import React, { useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CandlestickChart,
  MousePointer2,
  RotateCcw,
  Settings,
  ShieldAlert,
  ToggleRight,
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
import {
  getAnalysisConfigError,
  loadStoredUserConfig,
  resolveUserConfigForSite,
} from '../core/config';
import {
  DEFAULT_CONFIG,
  MAX_ANALYSIS_CANDLES,
  MIN_ANALYSIS_CANDLES,
  type MarketData,
  type RawMarketPayload,
  type UserConfig,
  type WyckoffAnalysisResult,
} from '../core/model/types';
import { hasConflictingPage, isSameTabContext, resetTabScopedState, useDrawerStore } from './store';
import { getMarketColorTheme } from './market-colors';
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

function App() {
  const s = useDrawerStore();
  const analysisSequence = useRef(0);
  const syncSequence = useRef(0);
  const windowId = useRef<number | undefined>(undefined);
  const site = detectMarketSite(s.page?.url);
  const isTradingView = site === 'tradingview';
  const supportsActiveRequest = site === 'binance' || site === 'tonghuashun';
  const canAnalyze = !s.syncing && (supportsActiveRequest || s.candidates.length > 0);

  const syncActiveTab = useCallback(async (hintTabId?: number) => {
    const requestId = ++syncSequence.current;
    const initial = useDrawerStore.getState();
    if (hintTabId !== undefined && initial.activeTabId !== hintTabId) {
      analysisSequence.current += 1;
      initial.set(resetTabScopedState(hintTabId));
    }
    try {
      const context = await getActiveTabContext();
      if (requestId !== syncSequence.current) return false;
      let current = useDrawerStore.getState();
      const changed = !isSameTabContext(current, context.tabId, context.page);
      if (changed) {
        analysisSequence.current += 1;
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
      });
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
    analysisSequence.current += 1;
    const current = useDrawerStore.getState();
    current.set({
      config: { ...DEFAULT_CONFIG },
      busy: false,
      error: undefined,
      selection: undefined,
      marketData: undefined,
      result: undefined,
    });
    if (!extensionReady()) return;
    await chrome.storage.local.set({ 'kla:userConfig': DEFAULT_CONFIG });
    if (current.activeTabId !== undefined)
      await chrome.runtime.sendMessage({
        ...createMessage('RESET_ANALYSIS', 'drawer'),
        tabId: current.activeTabId,
      });
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
          .set({ config, error: configError ? translateMessage(configError) : undefined });
        await syncActiveTab();
      } catch (error) {
        useDrawerStore
          .getState()
          .set({ syncing: false, error: errorMessage(error, 'error_initialize_page') });
      }
    })();
    const messageListener = (m: ExtensionMessage, sender: chrome.runtime.MessageSender) => {
      if (sender.tab?.id === undefined) return;
      const current = useDrawerStore.getState();
      if (sender.tab.id !== current.activeTabId) return;
      if (m.type === 'PAGE_DETECTED') {
        const page = m.payload as ActiveTabContext['page'];
        if (!page?.url) return;
        analysisSequence.current += 1;
        current.set(resetTabScopedState(sender.tab.id, page));
        void syncActiveTab(sender.tab.id);
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
      await chrome.tabs.sendMessage(tabId, createMessage('START_SELECTION', 'drawer'));
      s.set({ error: undefined });
    } catch (error) {
      s.set({ error: errorMessage(error, 'error_start_selection') });
    }
  };
  const analyze = async (config = s.config, showBusy = true) => {
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
      const configError = getAnalysisConfigError(requestConfig);
      if (configError) throw new Error(translateMessage(configError));
      if (showBusy) current.set({ busy: true, error: undefined });
      if (
        requestConfig.analysisPeriod !== current.config.analysisPeriod ||
        requestConfig.analysisCandleCount !== current.config.analysisCandleCount
      ) {
        current.set({ config: requestConfig });
        if (extensionReady()) void chrome.storage.local.set({ 'kla:userConfig': requestConfig });
      }
      const response = await chrome.runtime.sendMessage({
        ...createMessage('RUN_ANALYSIS', 'drawer', {
          config: requestConfig,
          pageUrl: page?.url,
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
        marketData: undefined,
        result: undefined,
      });
    } catch (error) {
      if (requestSequence !== analysisSequence.current) return;
      useDrawerStore.getState().set({
        busy: false,
        error: errorMessage(error, 'error_analysis_service'),
        marketData: undefined,
        result: undefined,
      });
    }
  };
  const applyConfig = (config: UserConfig) => {
    if (isTradingView) {
      s.set({ config: { ...DEFAULT_CONFIG } });
      return;
    }
    const shouldReanalyze = Boolean(s.result || s.busy) && canAnalyze;
    const wasBusy = s.busy;
    analysisSequence.current += 1;
    const configError = getAnalysisConfigError(config);
    s.set({
      config,
      busy: false,
      error: configError ? translateMessage(configError) : undefined,
      ...(configError ? { marketData: undefined, result: undefined } : {}),
    });
    if (configError) return;
    if (extensionReady()) chrome.storage.local.set({ 'kla:userConfig': config });
    if (shouldReanalyze) void analyze(config, wasBusy);
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
        <button data-testid="select-candles" disabled={s.syncing} onClick={() => void select()}>
          <MousePointer2 />
          {t('drawer_select_candles')}
        </button>
        <button
          className="primary"
          data-testid="run-analysis"
          disabled={s.busy || !canAnalyze}
          onClick={() => void analyze()}
        >
          <CandlestickChart />
          {s.busy ? t('drawer_analyzing') : t('drawer_start_analysis')}
        </button>
      </div>
      {s.error && (
        <p className="error">
          <ShieldAlert />
          {s.error}
        </p>
      )}
      <Result result={s.result} site={site} />
      <Chart data={s.marketData} />
      <Config
        site={site}
        capturedCandles={capturedCandleCount(s.candidates)}
        onChange={applyConfig}
      />
    </main>
  );
}
function Result({ result, site }: { result?: WyckoffAnalysisResult; site: MarketSite }) {
  if (!result)
    return (
      <section className="empty" data-testid="analysis-empty">
        <CandlestickChart />
        <h2>{t('drawer_empty_title')}</h2>
        <p>{t('drawer_empty_description')}</p>
      </section>
    );
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
                value={s.config.analysisCandleCount}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value)) update('analysisCandleCount', value);
                }}
              />
            </label>
          </>
        )}
      </div>
    </details>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
