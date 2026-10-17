import test from "node:test";
import assert from "node:assert/strict";
import { labelWeChatMessage } from "./wechat-sender-label.ts";

test("labels a direct message with the sender name", () => {
  assert.equal(
    labelWeChatMessage("测试用小号", "wxid_test", "你好"),
    "测试用小号: 你好",
  );
});

test("falls back to sender id when the display name is empty", () => {
  assert.equal(
    labelWeChatMessage("", "wxid_test", "你好"),
    "wxid_test: 你好",
  );
});
