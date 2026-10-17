export class ReplyWatchdogTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Model reply timed out after ${timeoutMs}ms`);
    this.name = "ReplyWatchdogTimeoutError";
  }
}

export async function runWithReplyWatchdog<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    timeoutMs: number;
    maxAttempts?: number;
    canRetry?: () => boolean;
    onTimeout?: (attempt: number, timeoutMs: number) => void;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new ReplyWatchdogTimeoutError(options.timeoutMs);
          controller.abort(error);
          options.onTimeout?.(attempt, options.timeoutMs);
          reject(error);
        }, options.timeoutMs);
      });
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      if (
        timedOut &&
        attempt < maxAttempts &&
        (options.canRetry?.() ?? true)
      ) {
        continue;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw new Error("Reply watchdog exhausted");
}
