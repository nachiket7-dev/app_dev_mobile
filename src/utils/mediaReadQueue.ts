interface WaitingRead {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

function cancelledRead() {
  const error = new Error('Media read cancelled.');
  error.name = 'AbortError';
  return error;
}

export function createMediaReadQueue(limit = 2) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Media read concurrency must be positive.');
  const waiting: WaitingRead[] = [];
  let active = 0;
  const drain = () => {
    while (active < limit && waiting.length) {
      const read = waiting.shift()!;
      read.cleanup();
      active++;
      let released = false;
      read.resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  };
  return {
    acquire(signals: (AbortSignal | null | undefined)[] = []): Promise<() => void> {
      const live = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
      if (live.some((signal) => signal.aborted)) return Promise.reject(cancelledRead());
      return new Promise<() => void>((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(read);
          if (index < 0) return;
          waiting.splice(index, 1);
          read.cleanup();
          reject(cancelledRead());
          drain();
        };
        const read = { resolve, reject, cleanup: () => live.forEach((signal) => signal.removeEventListener('abort', abort)) };
        waiting.push(read);
        live.forEach((signal) => signal.addEventListener('abort', abort, { once: true }));
        drain();
      });
    },
  };
}

const queues = new WeakMap<object, ReturnType<typeof createMediaReadQueue>>();

export function sessionMediaReadQueue(config: { signal?: AbortSignal }) {
  const scope = config.signal || config;
  let queue = queues.get(scope);
  if (!queue) { queue = createMediaReadQueue(); queues.set(scope, queue); }
  return queue;
}

export function waitForMediaRetry(milliseconds: number, signals: (AbortSignal | null | undefined)[]) {
  const live = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
  if (live.some((signal) => signal.aborted)) return Promise.reject(cancelledRead());
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => live.forEach((signal) => signal.removeEventListener('abort', abort));
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(cancelledRead()); };
    live.forEach((signal) => signal.addEventListener('abort', abort, { once: true }));
  });
}
