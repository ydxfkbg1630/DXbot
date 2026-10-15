import test from "node:test";
import assert from "node:assert/strict";
import { prefixWechatReply } from "./reply-prefix.ts";

test("prefixes a plain WeChat reply with DXbot", () => {
  assert.equal(prefixWechatReply("你好"), "DXbot: 你好");
});

test("preserves a reply that already has the DXbot prefix", () => {
  assert.equal(prefixWechatReply("DXbot: 你好"), "DXbot: 你好");
});

test("preserves newlines after adding the prefix", () => {
  assert.equal(prefixWechatReply("第一行\n第二行"), "DXbot: 第一行\n第二行");
});

test("keeps an empty payload empty", () => {
  assert.equal(prefixWechatReply(""), "");
});
