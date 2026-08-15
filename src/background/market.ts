import { createMarketData } from '../core/adapter/normalize';
import type { MarketSite } from '../core/adapter/sites';
import type { MarketData, RawMarketPayload } from '../core/model/types';
import { MIN_ANALYSIS_CANDLES } from '../core/model/types';

const locationHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'generic';
  }
};

const positiveVolumeCount = (data: MarketData) =>
  data.candles.reduce((count, candle) => count + (candle.volume > 0 ? 1 : 0), 0);

// TradingView 一个 socket 可能同时推送主图、指标和旧序列。候选必须先按站点隔离，
// 再优先选择具备真实成交量且 K 线更完整的主图序列。
export function selectBestPassiveMarketData(
  candidates: RawMarketPayload[],
  site: MarketSite,
  pageUrl?: string,
): MarketData | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.siteId === site && (!candidate.pageUrl || candidate.pageUrl === pageUrl),
    )
    .map((candidate) => ({
      candidate,
      data: createMarketData(
        candidate.raw,
        candidate.url,
        candidate.siteId ?? locationHost(candidate.url),
        candidate.symbol,
        candidate.period,
        MIN_ANALYSIS_CANDLES,
        `passive-${site}-websocket`,
      ),
    }))
    .sort((left, right) => {
      const volumeDifference = positiveVolumeCount(right.data) - positiveVolumeCount(left.data);
      if (volumeDifference) return volumeDifference;
      const candleDifference = right.data.candles.length - left.data.candles.length;
      if (candleDifference) return candleDifference;
      return right.candidate.responseAt - left.candidate.responseAt;
    })[0]?.data;
}
