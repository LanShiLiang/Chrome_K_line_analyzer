import type { RawMarketPayload } from '../core/model/types';

export function isRawMarketPayload(value: unknown): value is RawMarketPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<RawMarketPayload>;
  return (
    typeof payload.id === 'string' &&
    payload.id.length > 0 &&
    typeof payload.url === 'string' &&
    payload.url.length > 0 &&
    payload.method === 'WS' &&
    payload.status === 101 &&
    payload.source === 'websocket' &&
    Array.isArray(payload.raw) &&
    typeof payload.requestAt === 'number' &&
    Number.isFinite(payload.requestAt) &&
    typeof payload.responseAt === 'number' &&
    Number.isFinite(payload.responseAt) &&
    typeof payload.confidence === 'number' &&
    Number.isFinite(payload.confidence)
  );
}
