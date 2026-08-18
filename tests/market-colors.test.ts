import { describe, expect, it } from 'vitest';
import { getMarketColorTheme } from '../src/drawer/market-colors';

describe('site-specific market colors', () => {
  it.each(['binance', 'tradingview', 'unsupported'])(
    'uses green-up and red-down for %s',
    (siteId) => {
      expect(getMarketColorTheme(siteId)).toEqual({
        rising: '#17b890',
        falling: '#ef6461',
        risingVolume: '#17b89088',
        fallingVolume: '#ef646188',
      });
    },
  );

  it('uses red-up and green-down for Tonghuashun', () => {
    expect(getMarketColorTheme('tonghuashun')).toEqual({
      rising: '#ef6461',
      falling: '#17b890',
      risingVolume: '#ef646188',
      fallingVolume: '#17b89088',
    });
  });
});
