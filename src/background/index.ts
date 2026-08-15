import { AnalysisInputError, runMarketAnalysis } from '../core/analysis/engine';
import { ActiveMarketDataError, fetchActiveMarketData } from '../core/adapter/active';
import { createMarketData } from '../core/adapter/normalize';
import { detectMarketSite } from '../core/adapter/sites';
import { getAnalysisConfigError, mergeUserConfig, resolveUserConfigForSite } from '../core/config';
import type { MarketData, SelectionRange, UserConfig } from '../core/model/types';
import { MIN_ANALYSIS_CANDLES } from '../core/model/types';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';
import { createSession, updateSessionPage, type Session } from './session';

// Service Worker 按标签页维护临时会话，并统一执行标准化与策略分析。
const sessions = new Map<number, Session>();
const session = (tabId: number) => {
  if (!sessions.has(tabId)) sessions.set(tabId, createSession());
  return sessions.get(tabId)!;
};

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // 页面消息优先使用 sender.tab；扩展页面必须显式携带 tabId。
  const tabId = sender.tab?.id ?? message.tabId;
  if (tabId === undefined) {
    sendResponse({
      ok: false,
      error: { code: 'E_TAB_REQUIRED', message: '缺少 Tab 上下文', recoverable: true },
    });
    return;
  }
  const current = session(tabId);
  if (message.type === 'PAGE_DETECTED')
    updateSessionPage(current, message.payload as Session['page']);
  if (message.type === 'SELECTION_DONE')
    current.selection = { ...(message.payload as SelectionRange), tabId };
  if (message.type === 'MARKET_DATA_CANDIDATES')
    current.candidates = Array.isArray(message.payload)
      ? message.payload.filter(isRawMarketPayload)
      : [];
  if (message.type === 'GET_STATE') {
    void hydrateSessionFromContent(tabId, current).then(() =>
      sendResponse({ ok: true, data: current }),
    );
    return true;
  }
  if (message.type === 'RUN_ANALYSIS') {
    const requested = message.payload as {
      candidateId?: string;
      config?: UserConfig;
      pageUrl?: string;
    };
    void runAnalysis(current, requested).then(sendResponse);
    return true;
  }
  sendResponse({ ok: true });
});

async function hydrateSessionFromContent(tabId: number, current: Session) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, createMessage('GET_STATE', 'background'));
    if (response?.ok && Array.isArray(response.candidates))
      current.candidates = response.candidates.filter(isRawMarketPayload);
  } catch {
    // 不支持的页面没有 Content Script；保留后台现有状态即可。
  }
}

chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));
function locationHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'generic';
  }
}

async function runAnalysis(
  current: Session,
  requested: { candidateId?: string; config?: UserConfig; pageUrl?: string },
) {
  const pageUrl = requested.pageUrl ?? current.page?.url;
  if (requested.pageUrl)
    updateSessionPage(current, { url: requested.pageUrl, title: current.page?.title ?? '' });
  const site = detectMarketSite(pageUrl);
  const config = resolveUserConfigForSite(site, mergeUserConfig(requested.config));
  const candidate =
    current.candidates.find((item) => item.id === requested.candidateId) ?? current.candidates[0];

  try {
    const configError = getAnalysisConfigError(config);
    if (configError) throw new AnalysisInputError('E_ANALYSIS_CONFIG_INVALID', configError);
    let normalized: MarketData | undefined;
    let activeError: unknown;
    if ((site === 'binance' || site === 'tonghuashun') && pageUrl) {
      try {
        normalized = await fetchActiveMarketData(pageUrl, config);
      } catch (error) {
        activeError = error;
      }
    }

    if (pageUrl && current.page?.url && current.page.url !== pageUrl)
      throw new AnalysisInputError(
        'E_PAGE_CONTEXT_CHANGED',
        '分析期间行情页面已切换，请在新页面重新开始分析',
      );

    if (!normalized && candidate) {
      normalized = createMarketData(
        candidate.raw,
        candidate.url,
        candidate.siteId ?? locationHost(candidate.url),
        candidate.symbol,
        candidate.period,
        MIN_ANALYSIS_CANDLES,
        'passive-websocket',
      );
      if (activeError)
        normalized.quality.warnings.unshift('主动行情请求失败，本次已回退到页面被动捕获的数据');
    }

    if (!normalized) {
      if (activeError instanceof ActiveMarketDataError) throw activeError;
      throw new AnalysisInputError(
        'E_MARKET_DATA_NOT_FOUND',
        site === 'tradingview'
          ? '尚未被动捕获到 TradingView 行情，请等待图表加载或切换周期后重试'
          : '未获取到行情数据，请确认当前页面标的后重试',
      );
    }

    const analysis = runMarketAnalysis(normalized, config);
    return {
      ok: true,
      data: {
        marketData: analysis.marketData,
        result: analysis.result,
        selection: current.selection,
      },
    };
  } catch (error) {
    const known = error instanceof AnalysisInputError || error instanceof ActiveMarketDataError;
    console.error('K 线分析失败', error);
    return {
      ok: false,
      error: {
        code: known ? error.code : 'E_ANALYSIS_FAILED',
        message: known ? error.message : '分析计算失败，请检查策略参数或刷新行情页面后重试',
        recoverable: true,
      },
    };
  }
}
