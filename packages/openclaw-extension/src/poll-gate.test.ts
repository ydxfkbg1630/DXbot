import test from "node:test";
import assert from "node:assert/strict";
import type { Chat } from "@agent-wechat/shared";
import type { ResolvedWeChatAccount } from "./types.ts";
import { shouldPollWeChatChat } from "./poll-gate.ts";

function account(overrides: Partial<ResolvedWeChatAccount> = {}): ResolvedWeChatAccount {
  return {
    accountId: "default",
    enabled: true,
    serverUrl: "http://localhost:6174",
    dmPolicy: "allowlist",
    allowFrom: ["wxid_allowed"],
    groupPolicy: "allowlist",
    groupAllowFrom: [],
    groups: { "room_allowed@chatroom": { enabled: true } },
    pollIntervalMs: 1000,
    authPollIntervalMs: 30000,
    ...overrides,
  };
}

function chat(id: string, isGroup: boolean): Chat {
  return { id, username: id, name: id, unreadCount: 1, isGroup, lastMsgLocalId: 1 };
}

test("polls an allowlisted group", () => {
  assert.equal(shouldPollWeChatChat(chat("room_allowed@chatroom", true), account()), true);
});

test("skips a group outside the group allowlist", () => {
  assert.equal(shouldPollWeChatChat(chat("room_other@chatroom", true), account()), false);
});

test("skips system holder chats", () => {
  assert.equal(shouldPollWeChatChat(chat("brandsessionholder", false), account({ dmPolicy: "open" })), false);
});

test("polls an allowlisted direct message", () => {
  assert.equal(shouldPollWeChatChat(chat("wxid_allowed", false), account()), true);
});

test("skips a direct message outside the allowlist", () => {
  assert.equal(shouldPollWeChatChat(chat("wxid_other", false), account()), false);
});
