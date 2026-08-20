// 所有跨 Popup、Drawer、Content 和 Worker 的消息共享同一信封与 traceId。
import type { LocalizedMessage } from './i18n-types';

export type MessageType =
  | 'PAGE_DETECTED'
  | 'START_SELECTION'
  | 'CANCEL_SELECTION'
  | 'SELECTION_DONE'
  | 'SELECTION_UPDATED'
  | 'MARKET_DATA_CANDIDATES'
  | 'RUN_ANALYSIS'
  | 'CANCEL_ANALYSIS'
  | 'RESET_ANALYSIS'
  | 'GET_STATE';
export type ExtensionError = {
  code: string;
  message: LocalizedMessage;
  detail?: unknown;
  guidance?: LocalizedMessage[];
  recoverable: boolean;
};
export type ExtensionMessage<T = unknown> = {
  id: string;
  type: MessageType;
  source: 'popup' | 'drawer' | 'background' | 'content' | 'inject';
  target?: 'popup' | 'drawer' | 'background' | 'content';
  tabId?: number;
  payload?: T;
  traceId: string;
  timestamp: number;
};
export type ExtensionResponse<T = unknown> = {
  id: string;
  traceId: string;
  ok: boolean;
  data?: T;
  error?: ExtensionError;
};
export const createMessage = <T>(
  type: MessageType,
  source: ExtensionMessage['source'],
  payload?: T,
): ExtensionMessage<T> => ({
  id: crypto.randomUUID(),
  type,
  source,
  payload,
  traceId: crypto.randomUUID(),
  timestamp: Date.now(),
});
