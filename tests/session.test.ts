import { describe, expect, it } from 'vitest';
import { createSession, resolveSessionTabId, updateSessionPage } from '../src/background/session';
import type { RawMarketPayload, SelectionRange } from '../src/core/model/types';

const candidate = { id: 'candidate' } as RawMarketPayload;
const selection = { pageUrl: 'https://example.test/a' } as SelectionRange;

describe('background tab session', () => {
  it('uses the explicit active tab for extension pages and sender.tab for content scripts', () => {
    expect(resolveSessionTabId('drawer', 99, 7)).toBe(7);
    expect(resolveSessionTabId('popup', undefined, 8)).toBe(8);
    expect(resolveSessionTabId('content', 9, 7)).toBe(9);
  });

  it('preserves current-page data when only the title changes', () => {
    const current = {
      ...createSession(),
      page: { url: 'https://example.test/a', title: 'Old' },
      candidates: [candidate],
      selection,
    };
    updateSessionPage(current, { url: 'https://example.test/a', title: 'New' });
    expect(current.candidates).toEqual([candidate]);
    expect(current.selection).toBe(selection);
    expect(current.page?.title).toBe('New');
    expect(current.revision).toBe(0);
  });

  it('clears candidates and selection after the tab navigates', () => {
    const current = {
      ...createSession(),
      page: { url: 'https://example.test/a', title: 'A' },
      candidates: [candidate],
      selection,
    };
    updateSessionPage(current, { url: 'https://example.test/b', title: 'B' });
    expect(current.candidates).toEqual([]);
    expect(current.selection).toBeUndefined();
    expect(current.revision).toBe(1);
  });
});
