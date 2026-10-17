import type { Chat } from "@agent-wechat/shared";

type ChatWatermarkInput = Pick<
  Chat,
  | "lastMsgLocalId"
  | "lastActivityAt"
  | "lastMessageSender"
  | "lastMessagePreview"
  | "unreadCount"
>;

export type PendingMessageGap = {
  localId: number;
  messageKey: string | null;
  attempts: number;
  nextAttemptAt: number;
};

export function buildChatMessageKey(chat: ChatWatermarkInput): string | null {
  if (!chat.lastMsgLocalId) return null;
  return [
    chat.lastMsgLocalId,
    chat.lastActivityAt ?? "",
    chat.lastMessageSender ?? "",
    chat.lastMessagePreview ?? "",
  ].join("\u001f");
}

export function isRobotMessagePreview(chat: ChatWatermarkInput): boolean {
  return (
    chat.unreadCount <= 0 &&
    chat.lastMessagePreview?.startsWith("DXbot:") === true
  );
}

export function hasUnreadChatChanged(
  chat: ChatWatermarkInput,
  previousLastSeen: number | undefined,
  previousMessageKey: string | undefined,
): boolean {
  if (chat.unreadCount <= 0) return false;
  if (
    previousLastSeen === undefined ||
    !chat.lastMsgLocalId ||
    chat.lastMsgLocalId > previousLastSeen
  ) {
    return true;
  }
  const currentKey = buildChatMessageKey(chat);
  return currentKey !== null && currentKey !== previousMessageKey;
}

export function getEffectivePreviousLastSeen(
  chat: ChatWatermarkInput,
  previousLastSeen: number,
  maxFetchedId: number,
  previousMessageKey: string | undefined,
): number {
  if (
    chat.unreadCount > 0 &&
    chat.lastMsgLocalId !== undefined &&
    chat.lastMsgLocalId <= previousLastSeen &&
    hasUnreadChatChanged(chat, previousLastSeen, previousMessageKey)
  ) {
    return Math.max(0, Math.min(previousLastSeen - 1, maxFetchedId));
  }
  return previousLastSeen;
}

export function shouldThrottleMessageGap(
  chat: ChatWatermarkInput,
  gap: PendingMessageGap | undefined,
  now: number,
): boolean {
  return Boolean(
    gap &&
      gap.localId === chat.lastMsgLocalId &&
      gap.messageKey === buildChatMessageKey(chat) &&
      now < gap.nextAttemptAt,
  );
}

export function scheduleMessageGapRetry(
  chat: ChatWatermarkInput,
  previous: PendingMessageGap | undefined,
  now: number,
): PendingMessageGap {
  const messageKey = buildChatMessageKey(chat);
  const sameGap =
    previous?.localId === chat.lastMsgLocalId &&
    previous?.messageKey === messageKey;
  const attempts = sameGap && previous ? previous.attempts + 1 : 1;
  const delayMs = Math.min(5_000 * 2 ** (attempts - 1), 60_000);
  return {
    localId: chat.lastMsgLocalId ?? 0,
    messageKey,
    attempts,
    nextAttemptAt: now + delayMs,
  };
}
