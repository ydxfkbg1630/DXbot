import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectMessageFallback } from "./message-fallback.ts";

const baseChat = {
  id: "wxid_test",
  username: "wxid_test",
  name: "测试好友",
  unreadCount: 1,
  isGroup: false,
  lastMsgLocalId: 12,
  lastMessagePreview: "刚刚发来的消息",
  lastActivityAt: "2026-10-15T07:00:00+00:00",
};

test("builds a direct-message fallback when the chat index is ahead", () => {
  assert.deepEqual(
    buildDirectMessageFallback(baseChat, 11),
    {
      localId: 12,
      serverId: 0,
      chatId: "wxid_test",
      sender: "wxid_test",
      senderName: "测试好友",
      type: 1,
      content: "刚刚发来的消息",
      timestamp: "2026-10-15T07:00:00+00:00",
      isSelf: false,
    },
  );
});

test("does not synthesize a message when the index is caught up", () => {
  assert.equal(buildDirectMessageFallback(baseChat, 12), null);
});

test("does not synthesize a direct message with no unread state", () => {
  assert.equal(
    buildDirectMessageFallback({ ...baseChat, unreadCount: 0 }, 11),
    null,
  );
});

test("does not synthesize a robot message", () => {
  assert.equal(
    buildDirectMessageFallback({ ...baseChat, lastMessagePreview: "DXbot: 已回复" }, 11),
    null,
  );
});

test("does not synthesize group messages", () => {
  assert.equal(
    buildDirectMessageFallback({ ...baseChat, isGroup: true }, 11),
    null,
  );
});
