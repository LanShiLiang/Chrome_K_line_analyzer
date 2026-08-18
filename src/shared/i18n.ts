import type { LocalizedMessage, MessageKey } from './i18n-types';

export function t(key: MessageKey, substitutions: readonly (string | number)[] = []): string {
  const translated = chrome.i18n.getMessage(key, substitutions.map(String));
  if (!translated) throw new Error(`Missing i18n message: ${key}`);
  return translated;
}

export const translateMessage = ({ key, substitutions }: LocalizedMessage) => t(key, substitutions);

export function localizeDocument(titleKey: MessageKey = 'page_title') {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.documentElement.dir = chrome.i18n.getMessage('@@bidi_dir') || 'ltr';
  document.title = t(titleKey);
}
