import { describe, expect, it, vi } from 'vitest';
import { AnalysisTaskRegistry } from '../src/background/analysis-tasks';

describe('background analysis task registry', () => {
  it('aborts the previous task before installing a replacement for the same tab', () => {
    const registry = new AnalysisTaskRegistry();
    const first = registry.start(7, 'first');
    const onAbort = vi.fn();
    first.addEventListener('abort', onAbort);

    const second = registry.start(7, 'second');

    expect(first.aborted).toBe(true);
    expect(first.reason).toMatchObject({ name: 'AbortError' });
    expect(onAbort).toHaveBeenCalledOnce();
    expect(second.aborted).toBe(false);
    expect(registry.has(7)).toBe(true);
  });

  it('does not let a stale completion remove the newer task', () => {
    const registry = new AnalysisTaskRegistry();
    registry.start(7, 'first');
    const second = registry.start(7, 'second');

    registry.complete(7, 'first');
    expect(registry.has(7)).toBe(true);
    expect(second.aborted).toBe(false);

    registry.complete(7, 'second');
    expect(registry.has(7)).toBe(false);
  });

  it('cancels idempotently and isolates tabs', () => {
    const registry = new AnalysisTaskRegistry();
    const first = registry.start(7, 'first');
    const other = registry.start(8, 'other');

    expect(registry.cancel(7)).toBe(true);
    expect(registry.cancel(7)).toBe(false);
    expect(first.aborted).toBe(true);
    expect(other.aborted).toBe(false);
    expect(registry.has(8)).toBe(true);
  });
});
