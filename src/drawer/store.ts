import { create } from 'zustand';
import {
  DEFAULT_CONFIG,
  type MarketData,
  type RawMarketPayload,
  type SelectionRange,
  type UserConfig,
  type WyckoffAnalysisResult,
} from '../core/model/types';

// Drawer 的瞬时 UI 状态集中管理，浏览器会话数据仍由 Service Worker 按 Tab 持有。
type DrawerState = {
  activeTabId?: number;
  candidates: RawMarketPayload[];
  page?: { url: string; title: string };
  selection?: SelectionRange;
  marketData?: MarketData;
  result?: WyckoffAnalysisResult;
  config: UserConfig;
  busy: boolean;
  syncing: boolean;
  error?: string;
  set: (patch: Partial<DrawerState>) => void;
};

export function resetTabScopedState(
  activeTabId?: number,
  page?: DrawerState['page'],
): Partial<DrawerState> {
  return {
    activeTabId,
    page,
    candidates: [],
    selection: undefined,
    marketData: undefined,
    result: undefined,
    busy: false,
    syncing: true,
    error: undefined,
  };
}

export const isSameTabContext = (
  state: Pick<DrawerState, 'activeTabId' | 'page'>,
  tabId: number,
  page?: DrawerState['page'],
) => state.activeTabId === tabId && (!page?.url || state.page?.url === page.url);

export const hasConflictingPage = (left?: DrawerState['page'], right?: DrawerState['page']) =>
  Boolean(left?.url && right?.url && left.url !== right.url);

export const useDrawerStore = create<DrawerState>((set) => ({
  candidates: [],
  config: DEFAULT_CONFIG,
  busy: false,
  syncing: true,
  set,
}));
