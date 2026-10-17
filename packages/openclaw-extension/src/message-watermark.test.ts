import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatMessageKey,
  getEffectivePreviousLastSeen,
  hasUnreadChatChanged,
  isRobotMessagePreview,
  scheduleMessageGapRetry,
  shouldThrottleMessageGap,
} from "./message-watermark.ts";

const previousChat = {
  lastMsgLocalId: 359,
  lastActivityAt: "2026-10-16T13:15:37+00:00",
  lastMessageSender: "wxid_gtfnf8uexcg929",
  lastMessagePreview: "？",
  unreadCount: 1,
};

test("detects a new unread message when WeChat reuses the local ID", () => {
  const currentChat = {
    ...previousChat,
    lastActivityAt: "2026-10-16T13:16:29+00:00",
    lastMessagePreview: "傻逼",
  };
  const previousKey = buildChatMessageKey(previousChat) ?? undefined;

  assert.equal(hasUnreadChatChanged(currentChat, 359, previousKey), true);
  assert.equal(
    getEffectivePreviousLastSeen(currentChat, 359, 359, previousKey),
    358,
  );
});

test("does not revisit the same unread message after its fingerprint is recorded", () => {
  const key = buildChatMessageKey(previousChat) ?? undefined;

  assert.equal(hasUnreadChatChanged(previousChat, 359, key), false);
  assert.equal(
    getEffectivePreviousLastSeen(previousChat, 359, 359, key),
    359,
  );
});

test("backs off when an indexed message is temporarily absent from the message list", () => {
  const gap = scheduleMessageGapRetry(previousChat, undefined, 1_000);

  assert.equal(shouldThrottleMessageGap(previousChat, gap, 2_000), true);
  assert.equal(shouldThrottleMessageGap(previousChat, gap, 6_000), false);
});

test("recognizes an already delivered DXbot preview as a robot message", () => {
  assert.equal(
    isRobotMessagePreview({
      ...previousChat,
      unreadCount: 0,
      lastMessagePreview: "DXbot: 已回复",
    }),
    true,
  );
});
