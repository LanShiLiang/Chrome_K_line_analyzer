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
