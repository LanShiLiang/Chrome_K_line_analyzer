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
import {
  DEFAULT_CONFIG,
  type MarketData,
  type RawMarketPayload,
  type UserConfig,
  type WyckoffAnalysisResult,
} from '../core/model/types';
import { useDrawerStore } from './store';
import './styles.css';

const extensionReady = () =>
  location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined';
// Drawer 始终以当前活动标签页作为查询和分析上下文。
const withActiveTab = (callback: (tabId: number) => void) => {
  if (!extensionReady()) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) callback(tabId);
  });
};
function App() {
  const s = useDrawerStore();
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
  const refresh = () =>
    withActiveTab((tabId) =>
      chrome.runtime.sendMessage({ ...createMessage('GET_STATE', 'drawer'), tabId }, (r) => {
        if (r?.ok) s.set({ candidates: r.data?.candidates ?? [], selection: r.data?.selection });
      }),
    );
  useEffect(() => {
    if (!extensionReady()) return;
    chrome.storage.local.get('kla:userConfig', (values) => {
      const saved = values['kla:userConfig'] as Partial<UserConfig> | undefined;
      useDrawerStore.getState().set({ config: { ...DEFAULT_CONFIG, ...saved } });
    });
    withActiveTab((tabId) =>
      chrome.runtime.sendMessage({ ...createMessage('GET_STATE', 'drawer'), tabId }, (r) => {
        if (r?.ok)
          useDrawerStore
            .getState()
            .set({ candidates: r.data?.candidates ?? [], selection: r.data?.selection });
      }),
    );
    const listener = (m: ExtensionMessage) => {
      if (m.type === 'MARKET_DATA_CANDIDATES')
        useDrawerStore.getState().set({ candidates: m.payload as RawMarketPayload[] });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  const select = () => {
    if (!extensionReady()) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) chrome.tabs.sendMessage(tabId, createMessage('START_SELECTION', 'drawer'));
    });
  };
  const analyze = (config = s.config, showBusy = true) => {
    if (showBusy) s.set({ busy: true, error: undefined });
    withActiveTab((tabId) =>
      chrome.runtime.sendMessage(
        {
          ...createMessage('RUN_ANALYSIS', 'drawer', {
            candidateId: s.candidates[0]?.id,
            config,
          }),
          tabId,
        },
        (r) =>
          r?.ok
            ? s.set({
                busy: false,
                marketData: r.data.marketData,
                result: r.data.result,
                selection: r.data.selection,
              })
            : s.set({ busy: false, error: r?.error?.message ?? '分析失败' }),
      ),
    );
  };
  const applyConfig = (config: UserConfig) => {
    s.set({ config });
    if (extensionReady()) chrome.storage.local.set({ 'kla:userConfig': config });
    if (s.result && s.candidates.length) analyze(config, false);
  };
  return (
    <main>
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
            onClick={refresh}
          >
            <RefreshCw />
          </button>
        </div>
      </header>
      <section className="status">
        <span className={s.candidates.length ? 'dot ok' : 'dot'} />
        <span>
          {s.candidates.length ? `已捕获 ${s.candidates.length} 个候选接口` : '等待行情数据'}
        </span>
      </section>
      <div className="actions">
        <button onClick={select}>
          <MousePointer2 />
          框选 K 线
        </button>
        <button
          className="primary"
          disabled={s.busy || !s.candidates.length}
          onClick={() => analyze()}
        >
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
      <Config onChange={applyConfig} />
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
      <div ref={ref} />
    </section>
  ) : null;
}
const numericConfigFields: Array<{
  key: Exclude<keyof UserConfig, 'debugMode'>;
  label: string;
  min: number;
  step?: number;
}> = [
  { key: 'volumeMaPeriod', label: '成交量均线周期', min: 1 },
  { key: 'rangeLookback', label: '支撑阻力分析窗口', min: 2 },
  { key: 'breakoutThreshold', label: '突破阈值', min: 0, step: 0.01 },
  { key: 'volumeSpikeRatio', label: '放量倍数', min: 0, step: 0.1 },
  { key: 'lowVolumeRatio', label: '缩量倍数', min: 0, step: 0.1 },
  { key: 'minCandles', label: '最小 K 线数量', min: 1 },
  { key: 'maxHistoryItems', label: '最大历史记录数', min: 1 },
];

function Config({ onChange }: { onChange: (config: UserConfig) => void }) {
  const s = useDrawerStore();
  const update = (key: keyof UserConfig, value: number | boolean) => {
    const config: UserConfig = { ...s.config, [key]: value };
    onChange(config);
  };
  return (
    <details>
      <summary>
        <Settings />
        策略参数
      </summary>
      <div className="config-heading">
        <strong>策略设置</strong>
        <span>修改后立即应用并自动保存</span>
      </div>
      {numericConfigFields.map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            type="number"
            min={field.min}
            step={field.step}
            value={s.config[field.key]}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value)) update(field.key, value);
            }}
          />
        </label>
      ))}
      <label>
        调试模式
        <input
          className="config-checkbox"
          type="checkbox"
          checked={s.config.debugMode}
          onChange={(event) => update('debugMode', event.currentTarget.checked)}
        />
      </label>
    </details>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
