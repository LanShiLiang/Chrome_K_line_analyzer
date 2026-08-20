export type MarketSite = 'binance' | 'tonghuashun' | 'tradingview' | 'unsupported';

export function detectMarketSiteFromHost(host: string): MarketSite {
  const hostname = host.toLowerCase().replace(/\.$/, '');
  if (hostname === 'binance.com' || hostname.endsWith('.binance.com')) return 'binance';
  if (hostname === 'stockpage.10jqka.com.cn') return 'tonghuashun';
  if (hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com')) return 'tradingview';
  return 'unsupported';
}

export function detectMarketSite(pageUrl?: string): MarketSite {
  if (!pageUrl) return 'unsupported';
  try {
    return detectMarketSiteFromHost(new URL(pageUrl).hostname);
  } catch {
    return 'unsupported';
  }
}

const normalizedUrl = (url: URL) => {
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.toString();
};

// SPA 会在不改变标的的情况下补充语言、主题和跟踪参数。页面所有权应比较
// “站点 + 市场 + 标的”，不能比较瞬时 URL 字符串，否则同一 Binance 图表会被误判为旧页面。
export function getMarketPageIdentity(pageUrl?: string): string | undefined {
  if (!pageUrl) return undefined;
  try {
    const url = new URL(pageUrl);
    const site = detectMarketSiteFromHost(url.hostname);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (site === 'binance') {
      const segments = url.pathname.split('/').filter(Boolean);
      const tradeIndex = segments.findIndex((segment) => segment.toLowerCase() === 'trade');
      const symbol = tradeIndex >= 0 ? segments[tradeIndex + 1]?.toUpperCase() : undefined;
      if (symbol) {
        const marketType = (url.searchParams.get('type') || 'spot').toLowerCase();
        return `binance:${hostname}:trade:${symbol}:${marketType}`;
      }
    }
    if (site === 'tonghuashun') {
      const symbol = url.pathname.match(/^\/(\d{6})(?:\/|$)/)?.[1];
      if (symbol) return `tonghuashun:${hostname}:stock:${symbol}`;
    }
    if (site === 'tradingview') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase();
      if (symbol) return `tradingview:${hostname}:chart:${symbol}`;
    }
    return `${site}:${normalizedUrl(url)}`;
  } catch {
    return undefined;
  }
}

export function isSameMarketPage(left?: string, right?: string) {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftIdentity = getMarketPageIdentity(left);
  return Boolean(leftIdentity && leftIdentity === getMarketPageIdentity(right));
}
