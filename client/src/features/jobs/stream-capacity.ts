/** Browser-owned locks release on tab termination and cap SSE across tabs of this origin. */
export function acquireStreamCapacity(
  documentJob: boolean,
  signal: AbortSignal,
): (() => void) | Promise<() => void> {
  if (typeof window === 'undefined' || !navigator.locks) return () => {};
  const locks = navigator.locks,
    slots = documentJob ? [1, 2, 3] : [0, 1, 2, 3];
  const attempt = (slot: number) =>
    new Promise<(() => void) | undefined>((resolve, reject) => {
      void locks
        .request('local-rag-sse-' + slot, { ifAvailable: true }, (lock) => {
          if (!lock || signal.aborted) {
            resolve(undefined);
            return;
          }
          return new Promise<void>((release) => {
            const close = () => {
              signal.removeEventListener('abort', close);
              release();
            };
            signal.addEventListener('abort', close, { once: true });
            resolve(close);
          });
        })
        .catch(reject);
    });
  return (async () => {
    while (true) {
      signal.throwIfAborted();
      for (const slot of slots) {
        const release = await attempt(slot);
        if (release) {
          if (signal.aborted) {
            release();
            signal.throwIfAborted();
          }
          return release;
        }
      }
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            reject(new DOMException('Stream cancelled', 'AbortError'));
          },
          timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
          }, 250);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  })();
}
