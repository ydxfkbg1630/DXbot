import test from "node:test";
import assert from "node:assert/strict";
import { createChatWorkQueue, withWeChatUi, withWeChatSession } from "./chat-work-queue.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("a slow chat leaves capacity for another chat and preserves its own order", async () => {
  const slow = gate();
  const calls: string[] = [];
  const queue = createChatWorkQueue(2, (error) => { throw error; });
  assert.equal(queue.enqueue("group", async () => {
    calls.push("group:start");
    await slow.promise;
    calls.push("group:end");
  }), true);
  assert.equal(queue.enqueue("group", async () => { calls.push("duplicate"); }), false);
  assert.equal(queue.enqueue("private", async () => { calls.push("private"); }), true);
  assert.equal(queue.enqueue("third", async () => { calls.push("third"); }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["group:start", "private"]);
  slow.release();
  await queue.drain();
  assert.equal(queue.enqueue("group", async () => { calls.push("next"); }), true);
  await queue.drain();
  assert.deepEqual(calls, ["group:start", "private", "group:end", "next"]);
});

test("a failed chat releases capacity for a later attempt", async () => {
  const errors: unknown[] = [];
  const queue = createChatWorkQueue(1, (error) => { errors.push(error); });
  queue.enqueue("private", async () => { throw new Error("temporary delivery failure"); });
  await queue.drain();
  assert.equal(errors.length, 1);
  let delivered = false;
  assert.equal(queue.enqueue("private", async () => { delivered = true; }), true);
  await queue.drain();
  assert.equal(delivered, true);
});

test("image capture and sending remain serialized, including after a UI failure", async () => {
  const saved = gate();
  const calls: string[] = [];
  const image = withWeChatUi(async () => {
    calls.push("image:start");
    await saved.promise;
    calls.push("image:end");
  });
  const failed = withWeChatUi(async () => {
    calls.push("failed-send");
    throw new Error("UI retry required");
  });
  const failure = assert.rejects(failed, /UI retry required/);
  const sent = withWeChatUi(async () => { calls.push("send"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["image:start"]);
  saved.release();
  await Promise.all([image, failure, sent]);
  assert.deepEqual(calls, ["image:start", "image:end", "failed-send", "send"]);
});

test("shared model sessions preserve context order while distinct sessions progress", async () => {
  const first = gate();
  const calls: string[] = [];
  const a = withWeChatSession("shared", async () => {
    calls.push("a:start");
    await first.promise;
    calls.push("a:end");
  });
  const b = withWeChatSession("shared", async () => { calls.push("b"); });
  const c = withWeChatSession("other", async () => { calls.push("c"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a:start", "c"]);
  first.release();
  await Promise.all([a, b, c]);
  assert.deepEqual(calls, ["a:start", "c", "a:end", "b"]);
});
