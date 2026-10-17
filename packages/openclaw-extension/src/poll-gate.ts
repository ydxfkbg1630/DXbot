import type { Chat } from "@agent-wechat/shared";
import type { ResolvedWeChatAccount } from "./types.js";

const SYSTEM_CHAT_IDS = new Set([
  "brandsessionholder",
  "brandservicesessionholder",
  "@placeholder_foldgroup",
]);

function normalizeId(value: string): string {
  return value.trim().replace(/^wechat:/i, "");
}

function groupEntry(account: ResolvedWeChatAccount, chatId: string) {
  const groups = account.groups ?? {};
  return groups[chatId] ?? groups[`wechat:${chatId}`] ?? groups["*"];
}

export function shouldPollWeChatChat(chat: Chat, account: ResolvedWeChatAccount): boolean {
  const chatId = normalizeId(chat.username ?? chat.id);
  if (!chatId || SYSTEM_CHAT_IDS.has(chatId) || chatId.startsWith("gh_")) {
    return false;
  }

  if (chat.isGroup) {
    if (account.groupPolicy === "disabled") return false;
    if (account.groupPolicy === "allowlist") {
      const entry = groupEntry(account, chatId);
      return Boolean(entry) && entry?.enabled !== false;
    }
    return groupEntry(account, chatId)?.enabled !== false;
  }

  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "allowlist") {
    const allowFrom = account.allowFrom.map(normalizeId);
    return allowFrom.includes("*") || allowFrom.includes(chatId);
  }
  return true;
}
