import { describe, expect, it } from 'vitest';
import { getMarketPageIdentity, isSameMarketPage } from '../src/core/adapter/sites';

describe('market page identity', () => {
  it('normalizes locale and presentation parameters for the same Binance spot symbol', () => {
    const requested = 'https://www.binance.com/en/trade/ETH_USDT?type=spot';
    const canonical =
      'https://www.binance.com/zh-CN/trade/ETH_USDT?theme=dark&utm_source=test&type=spot';
    expect(getMarketPageIdentity(requested)).toBe('binance:www.binance.com:trade:ETH_USDT:spot');
    expect(getMarketPageIdentity(canonical)).toBe('binance:www.binance.com:trade:ETH_USDT:spot');
    expect(isSameMarketPage(requested, canonical)).toBe(true);
  });

  it('keeps different symbols and market types isolated', () => {
    const ethSpot = 'https://www.binance.com/en/trade/ETH_USDT?type=spot';
    expect(isSameMarketPage(ethSpot, 'https://www.binance.com/en/trade/BTC_USDT?type=spot')).toBe(
      false,
    );
    expect(isSameMarketPage(ethSpot, 'https://www.binance.com/en/trade/ETH_USDT?type=cross')).toBe(
      false,
    );
    expect(
      isSameMarketPage(ethSpot, 'https://testnet.binance.com/en/trade/ETH_USDT?type=spot'),
    ).toBe(false);
  });

  it('ignores Tonghuashun page decoration parameters without mixing stock codes', () => {
    expect(
      isSameMarketPage(
        'https://stockpage.10jqka.com.cn/600519/',
        'https://stockpage.10jqka.com.cn/600519/?theme=dark&tracking=e2e',
      ),
    ).toBe(true);
    expect(
      isSameMarketPage(
        'https://stockpage.10jqka.com.cn/600519/',
        'https://stockpage.10jqka.com.cn/600487/?theme=dark',
      ),
    ).toBe(false);
  });
});
