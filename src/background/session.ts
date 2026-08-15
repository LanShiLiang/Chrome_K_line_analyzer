import type { RawMarketPayload, SelectionRange } from '../core/model/types';
import type { ExtensionMessage } from '../shared/messages';
import { isSameMarketPage } from '../core/adapter/sites';

export type PageContext = { url: string; title: string };

export type Session = {
  selection?: SelectionRange;
  candidates: RawMarketPayload[];
  page?: PageContext;
  revision: number;
};

export const createSession = (): Session => ({ candidates: [], revision: 0 });

// 扩展页面必须使用自己显式查询到的活动 Tab；网页消息则只信任 Chrome 提供的 sender.tab。
export function resolveSessionTabId(
  source: ExtensionMessage['source'],
  senderTabId?: number,
  explicitTabId?: number,
) {
  return source === 'drawer' || source === 'popup'
    ? (explicitTabId ?? senderTabId)
    : (senderTabId ?? explicitTabId);
}

// 同一 Tab 导航到新页面后，旧候选和旧框选都不能继续参与分析。
export function updateSessionPage(current: Session, page?: PageContext) {
  if (!page) return;
  if (current.page && !isSameMarketPage(current.page.url, page.url)) {
    current.candidates = [];
    current.selection = undefined;
    current.revision += 1;
  }
  current.page = page;
}
