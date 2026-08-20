import { afterEach, describe, expect, it, vi } from 'vitest';
import { t, translateMessage } from '../src/shared/i18n';

const installChromeI18n = (getMessage: ReturnType<typeof vi.fn>) =>
  vi.stubGlobal('chrome', {
    i18n: {
      getMessage,
      getUILanguage: () => 'en-US',
    },
  });

describe('Chrome i18n boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('omits the substitutions argument when a message has no placeholders', () => {
    const getMessage = vi.fn(() => 'Ready');
    installChromeI18n(getMessage);

    expect(t('drawer_empty_title')).toBe('Ready');
    expect(translateMessage({ key: 'warning_unclear_structure' })).toBe('Ready');
    expect(getMessage).toHaveBeenNthCalledWith(1, 'drawer_empty_title');
    expect(getMessage).toHaveBeenNthCalledWith(2, 'warning_unclear_structure');
  });

  it('normalizes every placeholder substitution to a string', () => {
    const getMessage = vi.fn(() => '20 / 19');
    installChromeI18n(getMessage);

    expect(t('error_selection_candles_insufficient', [10, 20, 19])).toBe('20 / 19');
    expect(getMessage).toHaveBeenCalledWith('error_selection_candles_insufficient', [
      '10',
      '20',
      '19',
    ]);
  });

  it('returns a safe localized fallback instead of crashing the React tree', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installChromeI18n(
      vi.fn(() => {
        throw new TypeError('No matching signature');
      }),
    );

    expect(t('drawer_title')).toBe('Localized content is temporarily unavailable.');
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
