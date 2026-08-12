import type { MarketData, RawMarketPayload, SelectionRange, UserConfig, WyckoffAnalysisResult } from '../core/model/types';
export type MessageType='PAGE_DETECTED'|'START_SELECTION'|'SELECTION_DONE'|'MARKET_RESPONSE_CAPTURED'|'MARKET_DATA_CANDIDATES'|'RUN_ANALYSIS'|'ANALYSIS_PROGRESS'|'ANALYSIS_DONE'|'ANALYSIS_FAILED'|'OPEN_DRAWER'|'GET_STATE';
export type ExtensionError={code:string;message:string;detail?:unknown;recoverable:boolean};
export type ExtensionMessage<T=unknown>={id:string;type:MessageType;source:'popup'|'options'|'drawer'|'background'|'content'|'inject';target?:'popup'|'options'|'drawer'|'background'|'content';tabId?:number;payload?:T;traceId:string;timestamp:number};
export type ExtensionResponse<T=unknown>={id:string;traceId:string;ok:boolean;data?:T;error?:ExtensionError};
export type RunAnalysisPayload={marketData:MarketData;selection?:SelectionRange;config:UserConfig};
export type CapturedPayload={payload:RawMarketPayload};
export type AnalysisDonePayload={result:WyckoffAnalysisResult};
export const createMessage=<T>(type:MessageType,source:ExtensionMessage['source'],payload?:T):ExtensionMessage<T>=>({id:crypto.randomUUID(),type,source,payload,traceId:crypto.randomUUID(),timestamp:Date.now()});
