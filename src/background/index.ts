import { AnalysisInputError, runMarketAnalysis } from '../core/analysis/engine';
import { ActiveMarketDataError, fetchActiveMarketData } from '../core/adapter/active';
import { detectMarketSite, isSameMarketPage } from '../core/adapter/sites';
import {
  getAnalysisConfigError,
  mergeUserConfig,
  resolveAnalysisConfigForMarket,
  resolveUserConfigForSite,
} from '../core/config';
import type { MarketData, SelectionRange, UserConfig } from '../core/model/types';
import { isRawMarketPayload } from '../shared/guards';
import { createMessage, type ExtensionMessage } from '../shared/messages';
import { message as localizedMessage } from '../shared/i18n-types';
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
      error: {
        code: 'E_TAB_REQUIRED',
        message: localizedMessage('error_tab_required'),
        recoverable: true,
      },
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
    console.error('K-line analysis failed', error);
    return {
      ok: false,
      error: {
        code: known ? error.code : 'E_ANALYSIS_FAILED',
        message: known ? error.userMessage : localizedMessage('error_analysis_failed'),
        recoverable: true,
      },
    };
  }
}
