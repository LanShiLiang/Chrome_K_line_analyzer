export type MarketColorTheme = {
  rising: string;
  falling: string;
  risingVolume: string;
  fallingVolume: string;
};

const GLOBAL_MARKET_COLORS: MarketColorTheme = {
  rising: '#17b890',
  falling: '#ef6461',
  risingVolume: '#17b89088',
  fallingVolume: '#ef646188',
};

const TONGHUASHUN_MARKET_COLORS: MarketColorTheme = {
  rising: '#ef6461',
  falling: '#17b890',
  risingVolume: '#ef646188',
  fallingVolume: '#17b89088',
};

export const getMarketColorTheme = (siteId?: string): MarketColorTheme =>
  siteId === 'tonghuashun' ? TONGHUASHUN_MARKET_COLORS : GLOBAL_MARKET_COLORS;
