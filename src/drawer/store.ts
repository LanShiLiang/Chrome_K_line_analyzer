import { create } from 'zustand';
import { DEFAULT_CONFIG, type MarketData, type RawMarketPayload, type SelectionRange, type UserConfig, type WyckoffAnalysisResult } from '../core/model/types';
type DrawerState={candidates:RawMarketPayload[];selection?:SelectionRange;marketData?:MarketData;result?:WyckoffAnalysisResult;config:UserConfig;busy:boolean;error?:string;set:(patch:Partial<DrawerState>)=>void};
export const useDrawerStore=create<DrawerState>(set=>({candidates:[],config:DEFAULT_CONFIG,busy:false,set}));
