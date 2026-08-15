import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CandlestickChart,
  MousePointer2,
  RefreshCw,
  Settings,
  ShieldAlert,
  ToggleRight,
} from 'lucide-react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType } from 'lightweight-charts';
import { createMessage } from '../shared/messages';
import type { ExtensionMessage } from '../shared/messages';
import { detectMarketSite } from '../core/adapter/sites';
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
import { useDrawerStore } from './store';
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

function App() {
  const s = useDrawerStore();
  const analysisSequence = useRef(0);
  const site = detectMarketSite(s.page?.url);
  const isTradingView = site === 'tradingview';
  const supportsActiveRequest = site === 'binance' || site === 'tonghuashun';
  const canAnalyze = supportsActiveRequest || s.candidates.length > 0;
  useEffect(() => {
    if (site !== 'tradingview') return;
    const current = useDrawerStore.getState();
    const config = resolveUserConfigForSite(site, current.config);
    if (
      current.config.analysisPeriod === config.analysisPeriod &&
      current.config.analysisCandleCount === config.analysisCandleCount
    )
      return;
    analysisSequence.current += 1;
    current.set({
      config,
      busy: false,
      error: undefined,
      marketData: undefined,
      result: undefined,
    });
    if (extensionReady()) void chrome.storage.local.set({ 'kla:userConfig': config });
  }, [site, s.config.analysisPeriod, s.config.analysisCandleCount]);
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
  const refresh = async () => {
    try {
      const { tabId, page } = await getActiveTabContext();
      const response = await chrome.runtime.sendMessage({
        ...createMessage('GET_STATE', 'drawer'),
        tabId,
      });
      if (!response?.ok) throw new Error(response?.error?.message ?? '刷新页面状态失败');
      const nextPage = page ?? response.data?.page;
      const pageChanged = Boolean(s.page?.url && nextPage?.url && s.page.url !== nextPage.url);
      s.set({
        candidates: response.data?.candidates ?? [],
        selection: response.data?.selection,
        page: nextPage,
        error: undefined,
        ...(pageChanged ? { marketData: undefined, result: undefined } : {}),
      });
    } catch (error) {
      s.set({ error: errorMessage(error, '刷新页面状态失败') });
    }
  };
  useEffect(() => {
    if (!extensionReady()) return;
    chrome.storage.local.get('kla:userConfig', (values) => {
      const saved = values['kla:userConfig'] as Partial<UserConfig> | undefined;
      const config = loadStoredUserConfig(saved);
      useDrawerStore.getState().set({ config, error: getAnalysisConfigError(config) });
    });
    void (async () => {
      try {
        const { tabId, page } = await getActiveTabContext();
        const response = await chrome.runtime.sendMessage({
          ...createMessage('GET_STATE', 'drawer'),
          tabId,
        });
        if (response?.ok)
          useDrawerStore.getState().set({
            candidates: response.data?.candidates ?? [],
            selection: response.data?.selection,
            page: page ?? response.data?.page,
          });
      } catch (error) {
        useDrawerStore.getState().set({ error: errorMessage(error, '初始化页面状态失败') });
      }
    })();
    const listener = (m: ExtensionMessage) => {
      if (m.type === 'MARKET_DATA_CANDIDATES')
        useDrawerStore.getState().set({ candidates: m.payload as RawMarketPayload[] });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
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
    const requestSequence = ++analysisSequence.current;
    const visibleConfig = resolveUserConfigForSite(site, config);
    const configError = getAnalysisConfigError(visibleConfig);
    if (configError) {
      s.set({ busy: false, error: configError, marketData: undefined, result: undefined });
      return;
    }
    if (showBusy) s.set({ busy: true, error: undefined });
    try {
      const { tabId, page } = await getActiveTabContext();
      const requestSite = detectMarketSite(page?.url);
      const requestConfig = resolveUserConfigForSite(requestSite, visibleConfig);
      if (
        requestConfig.analysisPeriod !== s.config.analysisPeriod ||
        requestConfig.analysisCandleCount !== s.config.analysisCandleCount
      ) {
        s.set({ config: requestConfig });
        if (extensionReady()) void chrome.storage.local.set({ 'kla:userConfig': requestConfig });
      }
      const response = await chrome.runtime.sendMessage({
        ...createMessage('RUN_ANALYSIS', 'drawer', {
          candidateId: s.candidates[0]?.id,
          config: requestConfig,
          pageUrl: page?.url,
        }),
        tabId,
      });
      if (requestSequence !== analysisSequence.current) return;
      if (response?.ok) {
        s.set({
          busy: false,
          error: undefined,
          page: page ?? s.page,
          marketData: response.data.marketData,
          result: response.data.result,
          selection: response.data.selection,
        });
        return;
      }
      s.set({
        busy: false,
        error: response?.error?.message ?? '分析失败，请刷新行情页面后重试',
        marketData: undefined,
        result: undefined,
      });
    } catch (error) {
      if (requestSequence !== analysisSequence.current) return;
      s.set({
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
            title="刷新状态"
            aria-label="刷新状态"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </button>
        </div>
      </header>
      <section className="status">
        <span className={canAnalyze ? 'dot ok' : 'dot'} />
        <span>
          {supportsActiveRequest
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
      <div className="actions">
        <button onClick={() => void select()}>
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
      <Result result={s.result} />
      <Chart data={s.marketData} />
      <Config disabled={isTradingView} onChange={applyConfig} />
    </main>
  );
}
function Result({ result }: { result?: WyckoffAnalysisResult }) {
  if (!result)
    return (
      <section className="empty">
        <CandlestickChart />
        <h2>等待分析</h2>
        <p>刷新行情页面后框选目标区域，插件会从页面请求中识别 OHLCV 数据。</p>
      </section>
    );
  return (
    <>
      <section className={`signal ${result.signal.action.toLowerCase()}`}>
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
    const chart = createChart(ref.current, {
      height: 260,
      layout: { background: { type: ColorType.Solid, color: '#101820' }, textColor: '#aab6be' },
      grid: { vertLines: { color: '#243039' }, horzLines: { color: '#243039' } },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#17b890',
      downColor: '#ef6461',
      wickUpColor: '#17b890',
      wickDownColor: '#ef6461',
      borderVisible: false,
    });
    candles.setData(
      data.candles.map((c) => ({
        time: (c.timestamp / 1000) as never,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    const volumes = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumes.setData(
      data.candles.map((c) => ({
        time: (c.timestamp / 1000) as never,
        value: c.volume,
        color: c.close >= c.open ? '#17b89088' : '#ef646188',
      })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);
  return data ? (
    <section>
      <h2>K线与成交量</h2>
      <p className="chart-summary">本次分析与图表均使用最近 {data.candles.length} 根 K 线</p>
      <div ref={ref} />
    </section>
  ) : null;
}
function Config({
  disabled,
  onChange,
}: {
  disabled: boolean;
  onChange: (config: UserConfig) => void;
}) {
  const s = useDrawerStore();
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
              ? 'TradingView 使用默认参数，当前页面不可修改'
              : '分析和图表使用相同的 K 线数量，修改后立即应用并自动保存'}
          </span>
        </div>
        <label>
          行情周期
          <select
            disabled={disabled}
            value={s.config.analysisPeriod}
            onChange={(event) =>
              update('analysisPeriod', event.currentTarget.value as UserConfig['analysisPeriod'])
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
            disabled={disabled}
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
      </div>
    </details>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
