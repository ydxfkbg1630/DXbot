import type { Chat, Message } from "@agent-wechat/shared";

export function buildMessageFallback(chat: Chat, previousLastSeen: number): Message | null {
  if (chat.unreadCount <= 0 || !chat.lastMsgLocalId || chat.lastMsgLocalId <= previousLastSeen) {
    return null;
  }
  const content = chat.lastMessagePreview?.trim();
  if (!content || content.startsWith("DXbot:")) {
    return null;
  }
  return {
    localId: chat.lastMsgLocalId,
    serverId: 0,
    chatId: chat.username ?? chat.id,
    sender: chat.isGroup ? (chat.lastMessageSender ?? chat.username ?? chat.id) : (chat.username ?? chat.id),
    senderName: chat.isGroup ? (chat.lastMessageSender ?? chat.name) : chat.name,
    type: 1,
    content,
    timestamp: chat.lastActivityAt ?? new Date().toISOString(),
    isSelf: false,
    isMentioned: chat.isGroup ? content.includes("@") : undefined,
  };
}

export const buildDirectMessageFallback = buildMessageFallback;
