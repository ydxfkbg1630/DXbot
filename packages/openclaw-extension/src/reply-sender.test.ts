import test from "node:test";
import assert from "node:assert/strict";
import { sendWechatReplyLines } from "./reply-sender.ts";

test("sends each non-empty reply line as a separate prefixed payload", async () => {
  const sent: string[] = [];

  await sendWechatReplyLines(
    "第一行\n第二行\n第三行",
    async (payload) => {
      sent.push(payload);
    },
  );

  assert.deepEqual(sent, [
    "DXbot: 第一行",
    "DXbot: 第二行",
    "DXbot: 第三行",
  ]);
});

test("skips empty reply lines while preserving a single-line reply", async () => {
  const sent: string[] = [];

  await sendWechatReplyLines(
    "第一行\n\n第二行\r\n\r\n第三行",
    async (payload) => {
      sent.push(payload);
    },
  );

  assert.deepEqual(sent, [
    "DXbot: 第一行",
    "DXbot: 第二行",
    "DXbot: 第三行",
  ]);
});

test("sends a single-line reply once", async () => {
  const sent: string[] = [];

  await sendWechatReplyLines("只有一行", async (payload) => {
    sent.push(payload);
  });

  assert.deepEqual(sent, ["DXbot: 只有一行"]);
});
