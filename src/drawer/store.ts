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
  candidates: RawMarketPayload[];
  page?: { url: string; title: string };
  selection?: SelectionRange;
  marketData?: MarketData;
  result?: WyckoffAnalysisResult;
  config: UserConfig;
  busy: boolean;
  error?: string;
  set: (patch: Partial<DrawerState>) => void;
};
export const useDrawerStore = create<DrawerState>((set) => ({
  candidates: [],
  config: DEFAULT_CONFIG,
  busy: false,
  set,
}));
