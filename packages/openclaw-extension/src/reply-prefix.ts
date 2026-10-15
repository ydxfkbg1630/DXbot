export const WECHAT_REPLY_PREFIX = "DXbot:";

export function prefixWechatReply(payload: string): string {
  if (!payload || payload.startsWith(WECHAT_REPLY_PREFIX)) {
    return payload;
  }
  return `${WECHAT_REPLY_PREFIX} ${payload}`;
}
