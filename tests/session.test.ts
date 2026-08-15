import { describe, expect, it } from 'vitest';
import { createSession, updateSessionPage } from '../src/background/session';
import type { RawMarketPayload, SelectionRange } from '../src/core/model/types';

const candidate = { id: 'candidate' } as RawMarketPayload;
const selection = { pageUrl: 'https://example.test/a' } as SelectionRange;

describe('background tab session', () => {
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
  });
});
