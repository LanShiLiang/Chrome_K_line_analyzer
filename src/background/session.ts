import type { RawMarketPayload, SelectionRange } from '../core/model/types';

export type PageContext = { url: string; title: string };

export type Session = {
  selection?: SelectionRange;
  candidates: RawMarketPayload[];
  page?: PageContext;
  revision: number;
};

export const createSession = (): Session => ({ candidates: [], revision: 0 });

// 同一 Tab 导航到新页面后，旧候选和旧框选都不能继续参与分析。
export function updateSessionPage(current: Session, page?: PageContext) {
  if (!page) return;
  if (current.page && current.page.url !== page.url) {
    current.candidates = [];
    current.selection = undefined;
    current.revision += 1;
  }
  current.page = page;
}
