import type { LocalizedMessage, MessageKey } from './i18n-types';

const emergencyFallback = () => {
  try {
    return chrome.i18n.getUILanguage().toLowerCase().startsWith('zh')
      ? '暂时无法显示此本地化内容。'
      : 'Localized content is temporarily unavailable.';
  } catch {
    return 'Localized content is temporarily unavailable.';
  }
};

export function t(key: MessageKey, substitutions?: readonly (string | number)[]): string {
  try {
    const normalized = substitutions?.map(String) ?? [];
    // Chrome 会拒绝 getMessage(key, []) 的运行时签名；没有替换值时必须省略第二个参数。
    const translated = normalized.length
      ? chrome.i18n.getMessage(key, normalized)
      : chrome.i18n.getMessage(key);
    if (translated) return translated;
    console.error(`Missing i18n message: ${key}`);
  } catch (error) {
    console.error(`Unable to localize message: ${key}`, error);
  }
  return emergencyFallback();
}

export const translateMessage = ({ key, substitutions }: LocalizedMessage) => t(key, substitutions);

export function localizeDocument(titleKey: MessageKey = 'page_title') {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  try {
    document.documentElement.dir = chrome.i18n.getMessage('@@bidi_dir') || 'ltr';
  } catch {
    document.documentElement.dir = 'ltr';
  }
  document.title = t(titleKey);
}
