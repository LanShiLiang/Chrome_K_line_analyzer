import { describe, expect, it } from 'vitest';
import { isSameTabContext, resetTabScopedState } from '../src/drawer/store';

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
