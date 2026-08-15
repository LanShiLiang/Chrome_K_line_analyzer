import { describe, expect, it } from 'vitest';
import { hasConflictingPage, isSameTabContext, resetTabScopedState } from '../src/drawer/store';

describe('drawer active-tab context', () => {
  it('treats both tab id and page URL as result ownership boundaries', () => {
    const current = { activeTabId: 7, page: { url: 'https://www.binance.com/a', title: 'A' } };
    expect(isSameTabContext(current, 7, current.page)).toBe(true);
    expect(isSameTabContext(current, 8, { url: 'https://www.binance.com/a', title: 'A' })).toBe(
      false,
    );
    expect(
      isSameTabContext(current, 7, { url: 'https://www.tradingview.com/chart', title: 'TV' }),
    ).toBe(false);
  });

  it('does not mistake a temporarily hidden activeTab URL for a tab switch', () => {
    const current = {
      activeTabId: 7,
      page: { url: 'https://www.binance.com/en/trade/ETH_USDT?type=spot', title: 'ETH' },
    };
    expect(isSameTabContext(current, 7)).toBe(true);
    expect(isSameTabContext({ activeTabId: 7 }, 7, current.page)).toBe(false);
    expect(hasConflictingPage(current.page, undefined)).toBe(false);
    expect(
      hasConflictingPage(current.page, {
        url: 'https://www.tradingview.com/chart',
        title: 'TV',
      }),
    ).toBe(true);
  });

  it('atomically clears every tab-scoped value while a new tab is synchronizing', () => {
    expect(resetTabScopedState(8)).toEqual({
      activeTabId: 8,
      page: undefined,
      candidates: [],
      selection: undefined,
      marketData: undefined,
      result: undefined,
      busy: false,
      syncing: true,
      error: undefined,
    });
  });
});
