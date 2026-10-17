export function labelWeChatMessage(
  senderName: string | undefined,
  senderId: string | undefined,
  body: string,
): string {
  const sender = senderName?.trim() || senderId?.trim();
  return sender ? `${sender}: ${body}` : body;
}
