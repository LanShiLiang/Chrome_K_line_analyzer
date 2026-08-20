export const createAbortError = () => new DOMException('Operation cancelled', 'AbortError');

export const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : createAbortError();

export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortReason(signal);
};

export const isAbortError = (error: unknown) =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';

export function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
