import type { ExtensionMessage } from '../shared/messages';

type ContentConnectionDependencies = {
  sendMessage: (tabId: number, message: ExtensionMessage) => Promise<unknown>;
  injectMain: (tabId: number) => Promise<unknown>;
  injectContent: (tabId: number) => Promise<unknown>;
};

const defaultDependencies: ContentConnectionDependencies = {
  sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  injectMain: (tabId) =>
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject.js'],
      world: 'MAIN',
    }),
  injectContent: (tabId) =>
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED',
    }),
};

export const isMissingContentReceiver = (error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    detail.includes('Receiving end does not exist') ||
    detail.includes('Could not establish connection')
  );
};

export async function sendToContentWithRecovery(
  tabId: number,
  message: ExtensionMessage,
  dependencies: ContentConnectionDependencies = defaultDependencies,
) {
  try {
    return await dependencies.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
  }

  // 扩展更新后，已打开的行情页仍持有失效的旧 Content Script。仅在确认接收端
  // 不存在时重建 MAIN/ISOLATED 两层桥接，然后重试原消息一次。
  await dependencies.injectMain(tabId);
  await dependencies.injectContent(tabId);
  return dependencies.sendMessage(tabId, message);
}
