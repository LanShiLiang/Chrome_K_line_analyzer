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
import './styles.css';

const extensionReady = () =>
  location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined';
type ActiveTabContext = {
  tabId: number;
  page?: { url: string; title: string };
};

// Drawer 始终以当前活动标签页作为查询和分析上下文，失败时抛出可展示的用户错误。
async function getActiveTabContext(): Promise<ActiveTabContext> {
  if (!extensionReady()) throw new Error('当前环境无法连接 Chrome 扩展服务');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('未找到可分析的活动标签页');
  return {
    tabId: tab.id,
    page: tab.url ? { url: tab.url, title: tab.title ?? '' } : undefined,
  };
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

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
      if (!response?.ok) throw new Error(response?.error?.message ?? '刷新页面状态失败');
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
          .set({ syncing: false, error: errorMessage(error, '同步当前标签页失败') });
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
      console.warn('无法通过 Side Panel API 关闭分析面板，将使用页面关闭兜底。', error);
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
        useDrawerStore.getState().set({ config, error: getAnalysisConfigError(config) });
        await syncActiveTab();
      } catch (error) {
        useDrawerStore
          .getState()
          .set({ syncing: false, error: errorMessage(error, '初始化页面状态失败') });
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
      s.set({ error: errorMessage(error, '无法启动 K 线框选') });
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
        throw new Error('当前标签页正在切换，请稍后重新分析');
      const requestSite = detectMarketSite(page?.url);
      const requestConfig = resolveUserConfigForSite(requestSite, config);
      const configError = getAnalysisConfigError(requestConfig);
      if (configError) throw new Error(configError);
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
          throw new Error('分析结果与当前标签页不一致，已阻止展示旧页面数据');
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
        error: response?.error?.message ?? '分析失败，请刷新行情页面后重试',
        marketData: undefined,
        result: undefined,
      });
    } catch (error) {
      if (requestSequence !== analysisSequence.current) return;
      useDrawerStore.getState().set({
        busy: false,
        error: errorMessage(error, '无法连接分析服务'),
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
      error: configError,
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
          <h1>量价分析台</h1>
        </div>
        <div className="header-actions">
          <button
            className="icon panel-toggle"
            type="button"
            title="关闭分析面板"
            aria-label="关闭分析面板"
            onClick={closePanel}
          >
            <ToggleRight />
          </button>
          <button
            className="icon"
            type="button"
            title="重置分析台"
            aria-label="重置分析台"
            onClick={() => void resetAnalyzer()}
          >
            <RotateCcw />
          </button>
        </div>
      </header>
      <section className="status">
        <span className={canAnalyze ? 'dot ok' : 'dot'} />
        <span>
          {s.syncing
            ? '正在同步当前标签页行情上下文'
            : supportsActiveRequest
              ? `已识别${site === 'binance' ? ' Binance' : '同花顺'}，开始分析时主动获取行情`
              : isTradingView
                ? s.candidates.length
                  ? `已被动捕获 ${s.candidates.length} 组 TradingView 行情`
                  : '等待 TradingView 页面推送行情数据'
                : s.candidates.length
                  ? `已被动捕获 ${s.candidates.length} 组行情`
                  : '当前页面暂不支持主动获取行情'}
        </span>
      </section>
      <p className="privacy-note">行情与分析结果不上传至开发者服务器。</p>
      <div className="actions">
        <button disabled={s.syncing} onClick={() => void select()}>
          <MousePointer2 />
          框选 K 线
        </button>
        <button className="primary" disabled={s.busy || !canAnalyze} onClick={() => void analyze()}>
          <CandlestickChart />
          {s.busy ? '分析中' : '开始分析'}
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
      <section className="empty">
        <CandlestickChart />
        <h2>等待分析</h2>
        <p>刷新行情页面后框选目标区域，插件会从页面请求中识别 OHLCV 数据。</p>
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
          <span>策略结论</span>
          <strong>{result.signal.action}</strong>
        </div>
        <div>
          <span>阶段</span>
          <strong>{result.stage}</strong>
        </div>
        <div>
          <span>置信度</span>
          <strong>{result.signal.confidence}</strong>
        </div>
      </section>
      <section>
        <h2>分析依据</h2>
        {result.evidence.map((e) => (
          <article key={e.code}>
            <b>{e.label}</b>
            <p>{e.detail}</p>
          </article>
        ))}
        {result.warnings.map((w) => (
          <p className="warning" key={w}>
            {w}
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
      <h2>K线与成交量</h2>
      <p className="chart-summary">
        {data.siteId === 'tradingview' ? '跟随当前 TradingView 图表，' : ''}
        本次分析与图表均使用最近 {data.candles.length} 根 K 线
      </p>
      {!data.candles.some((c) => c.volume > 0) && (
        <p className="warning">当前图表数据不含成交量，仅展示 K 线并降级为价格结构分析</p>
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
        策略参数
      </summary>
      <div className={`config-body${disabled ? ' is-disabled' : ''}`}>
        <div className="config-heading">
          <strong>策略设置</strong>
          <span>
            {disabled
              ? 'TradingView 跟随当前图表周期与实际捕获数据，当前页面不可修改'
              : '分析和图表使用相同的 K 线数量，修改后立即应用并自动保存'}
          </span>
        </div>
        {disabled ? (
          <div className="chart-context-settings" aria-label="TradingView 当前图表分析规则">
            <div>
              <span>行情周期</span>
              <strong>{s.marketData?.period ?? '跟随当前图表'}</strong>
            </div>
            <div>
              <span>分析 K 线数量</span>
              <strong>
                {capturedCandles
                  ? `已捕获 ${Math.min(capturedCandles, MAX_ANALYSIS_CANDLES)} 根`
                  : '等待图表数据'}
              </strong>
            </div>
          </div>
        ) : (
          <>
            <label>
              行情周期
              <select
                value={s.config.analysisPeriod}
                onChange={(event) =>
                  update(
                    'analysisPeriod',
                    event.currentTarget.value as UserConfig['analysisPeriod'],
                  )
                }
              >
                <option value="1d">日线</option>
                <option value="1w">周线</option>
                <option value="1M">月线</option>
              </select>
            </label>
            <label>
              分析 K 线数量
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
