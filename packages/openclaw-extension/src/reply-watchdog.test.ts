import test from "node:test";
import assert from "node:assert/strict";
import {
  ReplyWatchdogTimeoutError,
  runWithReplyWatchdog,
} from "./reply-watchdog.ts";

test("returns a fast model reply", async () => {
  const result = await runWithReplyWatchdog(
    async () => "ok",
    { timeoutMs: 50 },
  );
  assert.equal(result, "ok");
});

test("aborts and retries a timed-out model reply", async () => {
  let attempts = 0;
  const result = await runWithReplyWatchdog(
    async (signal) => {
      attempts++;
      if (attempts === 1) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      }
      return "recovered";
    },
    { timeoutMs: 10, maxAttempts: 2 },
  );

  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
});

test("does not retry after a timeout when a reply already started", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithReplyWatchdog(
      async (signal) => {
        attempts++;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      },
      {
        timeoutMs: 10,
        maxAttempts: 2,
        canRetry: () => false,
      },
    ),
    ReplyWatchdogTimeoutError,
  );

  assert.equal(attempts, 1);
});
