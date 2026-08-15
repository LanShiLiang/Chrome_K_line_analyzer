import { AnalysisInputError, runMarketAnalysis } from '../core/analysis/engine';
import { ActiveMarketDataError, fetchActiveMarketData } from '../core/adapter/active';
import { detectMarketSite } from '../core/adapter/sites';
import {
  getAnalysisConfigError,
  mergeUserConfig,
  resolveAnalysisConfigForMarket,
  resolveUserConfigForSite,
} from '../core/config';
import type { MarketData, SelectionRange, UserConfig } from '../core/model/types';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';
import { selectBestPassiveMarketData } from './market';
import { createSession, resolveSessionTabId, updateSessionPage, type Session } from './session';

// Service Worker 按标签页维护临时会话，并统一执行标准化与策略分析。
const sessions = new Map<number, Session>();
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
  if (message.type === 'RESET_ANALYSIS') {
    current.selection = undefined;
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
    };
    void runAnalysis(tabId, current, requested).then(sendResponse);
    return true;
  }
  sendResponse({ ok: true });
});

async function hydrateSessionFromContent(tabId: number, current: Session) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, createMessage('GET_STATE', 'background'));
    if (response?.ok && response.page?.url) updateSessionPage(current, response.page);
    if (response?.ok && Array.isArray(response.candidates))
      current.candidates = response.candidates.filter(isRawMarketPayload);
  } catch {
    // 不支持的页面没有 Content Script；保留后台现有状态即可。
  }
}

chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));

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
    throw new AnalysisInputError('E_PAGE_CONTEXT_MISSING', '无法确认当前行情页面，请刷新后重试');
  if (tabUrl && requestedUrl && tabUrl !== requestedUrl)
    throw new AnalysisInputError(
      'E_PAGE_CONTEXT_CHANGED',
      '当前标签页已经切换，请等待页面状态同步后重新分析',
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
  if (current.revision !== revision || current.page?.url !== pageUrl)
    throw new AnalysisInputError(
      'E_PAGE_CONTEXT_CHANGED',
      '分析期间行情页面已切换，本次旧页面结果已丢弃',
    );
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url !== pageUrl)
      throw new AnalysisInputError(
        'E_PAGE_CONTEXT_CHANGED',
        '分析期间行情页面已切换，本次旧页面结果已丢弃',
      );
  } catch (error) {
    if (error instanceof AnalysisInputError) throw error;
  }
}

async function runAnalysis(
  tabId: number,
  current: Session,
  requested: { config?: UserConfig; pageUrl?: string },
) {
  try {
    const pageUrl = await getAuthoritativePage(tabId, current, requested.pageUrl);
    const revision = current.revision;
    const site = detectMarketSite(pageUrl);
    const userConfig = resolveUserConfigForSite(site, mergeUserConfig(requested.config));
    const configError = getAnalysisConfigError(userConfig);
    if (configError) throw new AnalysisInputError('E_ANALYSIS_CONFIG_INVALID', configError);
    let normalized: MarketData | undefined;
    let activeError: unknown;
    if ((site === 'binance' || site === 'tonghuashun') && pageUrl) {
      try {
        normalized = await fetchActiveMarketData(pageUrl, userConfig);
      } catch (error) {
        activeError = error;
      }
    }

    await assertPageStillActive(tabId, current, pageUrl, revision);

    if (!normalized) {
      normalized = selectBestPassiveMarketData(current.candidates, site, pageUrl);
      if (activeError)
        normalized?.quality.warnings.unshift('主动行情请求失败，本次已回退到页面被动捕获的数据');
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

    const analysisConfig = resolveAnalysisConfigForMarket(
      site,
      userConfig,
      normalized.candles.length,
    );
    const analysis = runMarketAnalysis(normalized, analysisConfig);
    await assertPageStillActive(tabId, current, pageUrl, revision);
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
          mode: site === 'tradingview' ? 'current-chart' : 'configured-request',
        },
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
