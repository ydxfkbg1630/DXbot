import { prefixWechatReply } from "./reply-prefix.ts";

export async function sendWechatReplyLines(
  text: string,
  send: (payload: string) => Promise<void>,
  onSent?: (index: number, total: number) => void,
): Promise<void> {
  const parts = text.split(/\r?\n/).filter((part) => part.length > 0);
  const lines = parts.length > 0 ? parts : [text];
  const payloads = lines.map((line) => prefixWechatReply(line));

  for (const [index, payload] of payloads.entries()) {
    await send(payload);
    onSent?.(index + 1, payloads.length);
  }
}
