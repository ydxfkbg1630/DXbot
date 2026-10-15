export function createChatWorkQueue(
  limit: number,
  onError: (error: unknown) => void,
) {
  const running = new Map<string, Promise<void>>();
  return {
    enqueue(chatId: string, work: () => Promise<void>): boolean {
      if (running.has(chatId) || running.size >= limit) return false;
      const task = Promise.resolve()
        .then(work)
        .catch(onError)
        .finally(() => { running.delete(chatId); });
      running.set(chatId, task);
      return true;
    },
    has(chatId: string): boolean {
      return running.has(chatId);
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...running.values()]);
    },
  };
}

let uiTail: Promise<unknown> = Promise.resolve();
const sessionTails = new Map<string, Promise<unknown>>();

export function withWeChatUi<T>(work: () => Promise<T>): Promise<T> {
  const task = uiTail.then(work, work);
  uiTail = task.catch(() => undefined);
  return task;
}

export function withWeChatSession<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
  const previous = sessionTails.get(sessionKey) ?? Promise.resolve();
  const task = previous.then(work, work);
  const tail = task.catch(() => undefined).finally(() => {
    if (sessionTails.get(sessionKey) === tail) sessionTails.delete(sessionKey);
  });
  sessionTails.set(sessionKey, tail);
  return task;
}
