import { describe, expect, it } from 'vitest';
import { isRawMarketPayload } from '../src/shared/guards';

describe('isRawMarketPayload', () => {
  const valid = {
    id: 'binance:btc',
    url: 'wss://example.test/stream',
    method: 'WS',
    status: 101,
    requestAt: 1,
    responseAt: 2,
    source: 'websocket',
    raw: [],
    confidence: 100,
  };

  it('accepts complete bridge payloads', () => {
    expect(isRawMarketPayload(valid)).toBe(true);
  });

  it('rejects page messages with missing identity or non-array market data', () => {
    expect(isRawMarketPayload({ ...valid, id: '' })).toBe(false);
    expect(isRawMarketPayload({ ...valid, raw: {} })).toBe(false);
    expect(isRawMarketPayload({ ...valid, confidence: Number.NaN })).toBe(false);
  });
});
