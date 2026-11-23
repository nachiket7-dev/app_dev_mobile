export interface SessionAttempt {
  generation: number;
  signal: AbortSignal;
}

/** A response, error, and finally block must all belong to the same live attempt. */
export function createSessionGuard() {
  let generation = 0;
  let controller = new AbortController();
  const rotate = () => {
    controller.abort();
    controller = new AbortController();
    return { generation: ++generation, signal: controller.signal };
  };
  return {
    begin: rotate,
    invalidate: rotate,
    isCurrent: (attempt: SessionAttempt) =>
      attempt.generation === generation && !attempt.signal.aborted,
  };
}

export function sessionKey(server: string, accountId: string, generation: number) {
  return JSON.stringify([server, accountId, generation]);
}

export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/chats';
  return /^\/(?:chats|new-chat|chat\/[a-zA-Z0-9_-]+)$/.test(value) ? value : '/chats';
}
