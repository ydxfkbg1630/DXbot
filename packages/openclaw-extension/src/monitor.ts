import * as fs from "node:fs";
import { WeChatClient } from "@agent-wechat/shared";
import type { Chat, Message, MediaResult, AuthStatus } from "@agent-wechat/shared";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { ResolvedWeChatAccount } from "./types.js";
import { getWeChatRuntime } from "./runtime.js";
import { resolveWeChatAccount } from "./types.js";
import { createChatWorkQueue, withWeChatUi, withWeChatSession } from "./chat-work-queue.js";
import {
  normalizeWeChatCommandBody,
  resolveWeChatCommandAuthorization,
  resolveWeChatInboundAccessDecision,
  resolveWeChatMentionGate,
  resolveWeChatPolicyContext,
  type WeChatPolicyContext,
} from "./access-control.js";
import { buildMessageFallback } from "./message-fallback.js";
import { shouldPollWeChatChat } from "./poll-gate.js";
import { sendWechatReplyLines } from "./reply-sender.js";
import { buildWeChatHistoryContext } from "./wechat-history-context.js";
import { loadWechatMedia } from "./wechat-media.js";
import { labelWeChatMessage } from "./wechat-sender-label.js";
import {
  ReplyWatchdogTimeoutError,
  runWithReplyWatchdog,
} from "./reply-watchdog.js";
import {
  buildChatMessageKey,
  getEffectivePreviousLastSeen,
  hasUnreadChatChanged,
  isRobotMessagePreview,
  scheduleMessageGapRetry,
  shouldThrottleMessageGap,
  type PendingMessageGap,
} from "./message-watermark.js";

// Message types that may have downloadable media
const MEDIA_TYPES = new Set([3, 34, 43, 47]); // image, voice, video, emoji

// History context markers (match openclaw's built-in markers)
const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

export interface WeChatMonitorOptions {
  account: ResolvedWeChatAccount;
  abortSignal: AbortSignal;
  runtime: any; // PluginRuntime
  setStatus: (next: any) => void;
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void };
  cfg: any; // OpenClawConfig
}

type ProcessedMessage = {
  msg: Message;
  rawBody: string;
  commandBody: string;
  mediaPath?: string;
  mediaMime?: string;
  senderName: string;
  senderId: string;
  isGroup: boolean;
  timestamp: number;
  hasMedia: boolean;
  isMentioned: boolean;
};

/** Official/service accounts have IDs starting with gh_ */
function isOfficialAccount(chatId: string): boolean {
  return chatId.startsWith("gh_");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Poll for media data, retrying until data is available or max attempts reached.
 */
async function pollMedia(
  client: WeChatClient,
  chatId: string,
  localId: number,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
  maxAttempts = 2,
  intervalMs = 500,
): Promise<MediaResult | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.getMedia(chatId, localId);
    if (result.type === "unsupported") {
      // Server knows this message type has no media — no point retrying
      return null;
    }
    if (result.data || result.url) {
      return result;
    }
    if (attempt === maxAttempts) {
      return result;
    }
    if (attempt < maxAttempts) {
      log?.info?.(`[media] Attempt ${attempt}/${maxAttempts} for ${chatId}:${localId} returned no data, retrying...`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return null;
}

async function saveOriginalImage(
  chatId: string,
  localId: number,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<MediaResult | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createHash } = await import("node:crypto");
  const execute = promisify(execFile);
  const scope = createHash("sha256").update(chatId).digest("hex");
  const directory = `/home/wechat/agent-media/${scope}`;
  const cachePath = `${directory}/msg_${localId}.jpg`;
  try {
    let path: string | undefined;
    try {
      await execute("docker", ["exec", "agent-wechat", "test", "-s", cachePath], {
        timeout: 5000,
      });
      path = cachePath;
    } catch {
      const saved = await execute("docker", [
        "exec", "agent-wechat", "python3", "/opt/tools/save-wechat-image",
        chatId, String(localId), "--outdir", directory, "--max-try", "8",
      ], { timeout: 100_000, maxBuffer: 1024 * 1024 });
      path = saved.stdout.trim().split(/\r?\n/).at(-1);
    }
    if (!path?.startsWith(`${directory}/`) || path.includes("/../")) {
      throw new Error("Client save returned an unexpected path");
    }
    const file = await execute("docker", ["exec", "agent-wechat", "cat", path], {
      encoding: "buffer", timeout: 15_000, maxBuffer: 25 * 1024 * 1024,
    });
    const bytes = file.stdout;
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("Client save returned an unexpected image format");
    }
    const sharpModule = await import("sharp");
    const sharp = (sharpModule as any).default ?? sharpModule;
    await sharp(bytes, { failOn: "error" }).raw().toBuffer();
    log?.info?.(`[wechat] Original image ready for ${chatId}:${localId}: ${bytes.length} bytes`);
    return {
      type: "image", format: "jpeg", filename: `msg_${localId}.jpg`,
      data: bytes.toString("base64"),
    } as MediaResult;
  } catch (error) {
    log?.error?.(`[wechat] Original image save for ${chatId}:${localId}: ${String(error)}`);
    return null;
  }
}

function enqueueWeChatSystemEvent(text: string, contextKey: string): void {
  try {
    const core = getWeChatRuntime();
    core.system.enqueueSystemEvent(text, {
      sessionKey: "agent:main:main",
      contextKey,
    });
  } catch {
    // Don't crash the monitor if system event fails
  }
}

export async function startWeChatMonitor(
  opts: WeChatMonitorOptions,
): Promise<void> {
  const { account, abortSignal, setStatus, log } = opts;
  const client = new WeChatClient({ baseUrl: account.serverUrl, token: account.token });

  // Track last-seen message ID per chat
  const lastSeenId = new Map<string, number>();
  const lastSeenFile =
    process.env.WECHAT_LAST_SEEN_FILE ||
    "/data/agent-wechat/home/.openclaw/wechat-last-seen.json";
  const lastSeenMessageFile =
    process.env.WECHAT_LAST_SEEN_MESSAGE_FILE ||
    "/data/agent-wechat/home/.openclaw/wechat-last-seen-message.json";
  const loadLastSeen = (): void => {
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(lastSeenFile, "utf8"));
      if (saved === null || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("Watermark JSON must be an object");
      }
      let restored = 0;
      for (const [chatId, value] of Object.entries(saved)) {
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
          lastSeenId.set(chatId, value);
          restored++;
        }
      }
      log?.info?.(
        `[wechat:${account.accountId}] Restored watermark for ${restored} chats from ${lastSeenFile}`,
      );
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Watermark read error (${lastSeenFile}): ${String(err)}`,
      );
    }
  };
  let lastWrittenWatermarks = "";
  const saveLastSeen = (): void => {
    try {
      const serialized = JSON.stringify(Object.fromEntries(lastSeenId));
      if (serialized === lastWrittenWatermarks) return;
      const tmpPath = `${lastSeenFile}.tmp`;
      fs.writeFileSync(tmpPath, serialized, "utf8");
      fs.renameSync(tmpPath, lastSeenFile);
      lastWrittenWatermarks = serialized;
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Watermark write error (${lastSeenFile}): ${String(err)}`,
      );
    }
  };
  const lastSeenMessageKey = new Map<string, string>();
  const loadLastSeenMessageKeys = (): void => {
    try {
      if (!fs.existsSync(lastSeenMessageFile)) return;
      const saved: unknown = JSON.parse(fs.readFileSync(lastSeenMessageFile, "utf8"));
      if (saved === null || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("Message watermark JSON must be an object");
      }
      for (const [chatId, value] of Object.entries(saved)) {
        if (typeof value === "string" && value.length > 0) {
          lastSeenMessageKey.set(chatId, value);
        }
      }
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Message watermark read error (${lastSeenMessageFile}): ${String(err)}`,
      );
    }
  };
  let lastWrittenMessageKeys = "";
  const saveLastSeenMessageKeys = (): void => {
    try {
      const serialized = JSON.stringify(Object.fromEntries(lastSeenMessageKey));
      if (serialized === lastWrittenMessageKeys) return;
      const tmpPath = `${lastSeenMessageFile}.tmp`;
      fs.writeFileSync(tmpPath, serialized, "utf8");
      fs.renameSync(tmpPath, lastSeenMessageFile);
      lastWrittenMessageKeys = serialized;
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Message watermark write error (${lastSeenMessageFile}): ${String(err)}`,
      );
    }
  };
  loadLastSeen();
  loadLastSeenMessageKeys();

  // Buffer non-mentioned group messages for catch-up context
  const groupHistory = new Map<string, ProcessedMessage[]>();
  const fallbackSeenId = new Map<string, number>();
  const pendingMessageGaps = new Map<string, PendingMessageGap>();
  const GROUP_HISTORY_LIMIT = 50;
  const lastProbe = new Map<string, number>();
  const catchUpProbe = new Map<string, { localId: number; at: number; delayMs: number }>();
  const workQueue = createChatWorkQueue(4, (error) => {
    log?.error?.(`[wechat:${account.accountId}] Chat worker failed: ${String(error)}`);
  });
  let lastAuthCheck = 0;
  let prevStatus: AuthStatus["status"] | undefined = undefined;

  // Report initial status as running
  setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    linked: true,
  });

  while (!abortSignal.aborted) {
    try {
      // Reload config each iteration so hot-reloads take effect
      const cfg = getWeChatRuntime().config.loadConfig();
      const pollAccount =
        resolveWeChatAccount(cfg as Record<string, unknown>, account.accountId) ?? account;

      // ---- Auth polling (every authPollIntervalMs) ----
      const now = Date.now();
      if (now - lastAuthCheck >= account.authPollIntervalMs) {
        lastAuthCheck = now;
        try {
          const auth = await client.authStatus();
          const isLinked = auth.status === "logged_in";
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            linked: isLinked,
            authStatus: auth.status,
          });

          prevStatus = auth.status;

          if (!isLinked) {
            await sleep(account.pollIntervalMs, abortSignal);
            continue;
          }
        } catch (err) {
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: false,
            linked: false,
            lastError: String(err),
          });
          if (prevStatus === "logged_in") {
            enqueueWeChatSystemEvent(
              "[WeChat] Cannot reach agent-wechat server. The container may have stopped.",
              "wechat:server_unreachable",
            );
          }
          prevStatus = undefined;
          log?.error?.(
            `[wechat:${account.accountId}] Auth check failed: ${err}`,
          );
          await sleep(account.pollIntervalMs, abortSignal);
          continue;
        }
      }

      if (prevStatus !== "logged_in") {
        await sleep(account.pollIntervalMs, abortSignal);
        continue;
      }

      // ---- Message polling ----
      let chats: Chat[];
      try {
        chats = await client.listChats(50);
      } catch (err) {
        log?.error?.(
          `[wechat:${account.accountId}] Failed to list chats: ${err}`,
        );
        await sleep(account.pollIntervalMs, abortSignal);
        continue;
      }

      // Track chats with zero unread messages as well. WeChat can mark an
      // incoming message read on another device, leaving unreadCount at zero;
      // lastMsgLocalId is then the reliable catch-up signal.
      for (const chat of chats) {
        const chatId = chat.username ?? chat.id;
        if (!shouldPollWeChatChat(chat, pollAccount)) {
          if (chat.lastMsgLocalId) lastSeenId.set(chatId, chat.lastMsgLocalId);
          continue;
        }
        if (isRobotMessagePreview(chat)) {
          if (chat.lastMsgLocalId) lastSeenId.set(chatId, chat.lastMsgLocalId);
          const messageKey = buildChatMessageKey(chat);
          if (messageKey) lastSeenMessageKey.set(chatId, messageKey);
          pendingMessageGaps.delete(chatId);
          continue;
        }
        if (chat.unreadCount > 0) continue;
        if (!lastSeenId.has(chatId) && chat.lastMsgLocalId) {
          lastSeenId.set(chatId, chat.lastMsgLocalId);
        }
      }

      // Filter to chats with unreads (skip official accounts)
      const unreadChats = chats.filter(
        (c) => {
          const id = c.username ?? c.id;
          if (!shouldPollWeChatChat(c, pollAccount) || c.unreadCount <= 0 || workQueue.has(id)) return false;
          const nowForChat = Date.now();
          if (shouldThrottleMessageGap(c, pendingMessageGaps.get(id), nowForChat)) {
            return false;
          }
          const seen = lastSeenId.get(id);
          const fallbackDone = fallbackSeenId.get(id) === c.lastMsgLocalId;
          const messageChanged = hasUnreadChatChanged(
            c,
            seen,
            lastSeenMessageKey.get(id),
          );
          if (
            fallbackDone &&
            c.lastMsgLocalId !== undefined &&
            c.lastMsgLocalId <= (seen ?? 0) &&
            !messageChanged
          ) {
            return false;
          }
          return seen === undefined || !c.lastMsgLocalId ||
            c.lastMsgLocalId > seen ||
            messageChanged ||
            (!fallbackDone && now - (lastProbe.get(id) ?? 0) >= 10_000);
        },
      );

      const scheduleChat = (chat: Chat): void => {
        const id = chat.username ?? chat.id;
        lastProbe.set(id, now);
        const accepted = workQueue.enqueue(id, async () => {
          try {
            const handled = await processUnreadChat(
              client, chat, lastSeenId, account, getWeChatRuntime().config.loadConfig(), log, true,
              groupHistory, GROUP_HISTORY_LIMIT, fallbackSeenId,
              lastSeenMessageKey, pendingMessageGaps,
            );
            if (handled) {
              const messageKey = buildChatMessageKey(chat);
              if (messageKey) lastSeenMessageKey.set(id, messageKey);
              pendingMessageGaps.delete(id);
            }
          } finally {
            saveLastSeen();
            saveLastSeenMessageKeys();
          }
        });
        if (!accepted) {
          log?.info?.(`[wechat:${account.accountId}] Queue busy; deferring ${id}`);
        }
      };

      if (unreadChats.length > 0) {
        for (const chat of unreadChats) {
          if (abortSignal.aborted) break;
          scheduleChat(chat);
        }
      }

      // ---- Catch-up: check tracked chats where lastMsgLocalId advanced past lastSeenId ----
      for (const chat of chats) {
        if (abortSignal.aborted) break;
        const chatId = chat.username ?? chat.id;
        if (!shouldPollWeChatChat(chat, pollAccount)) continue;
        if (workQueue.has(chatId)) continue;
        if (shouldThrottleMessageGap(chat, pendingMessageGaps.get(chatId), now)) continue;
        const prevSeen = lastSeenId.get(chatId);
        if (prevSeen === undefined) continue; // not tracked yet
        if (unreadChats.some((c) => (c.username ?? c.id) === chatId)) continue; // already processed
        if (!chat.lastMsgLocalId || chat.lastMsgLocalId <= prevSeen) continue; // nothing new
        const previousProbe = catchUpProbe.get(chatId);
        if (
          previousProbe &&
          previousProbe.localId === chat.lastMsgLocalId &&
          now - previousProbe.at < previousProbe.delayMs
        ) {
          continue;
        }

        log?.info?.(
          `[wechat:${account.accountId}] Catch-up: ${chatId} lastMsgLocalId=${chat.lastMsgLocalId} > lastSeenId=${prevSeen}`,
        );
        scheduleChat(chat);
        catchUpProbe.set(chatId, {
          localId: chat.lastMsgLocalId,
          at: now,
          delayMs: previousProbe?.localId === chat.lastMsgLocalId
            ? Math.min(previousProbe.delayMs * 2, 60_000)
            : 10_000,
        });
      }
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Monitor error: ${err}`,
      );
    } finally {
      saveLastSeen();
      saveLastSeenMessageKeys();
    }

    await sleep(account.pollIntervalMs, abortSignal);
  }

  await workQueue.drain();
  setStatus({
    accountId: account.accountId,
    running: false,
    connected: false,
  });
}

/**
 * Pre-process a single message: download media, build rawBody, resolve sender info.
 */
async function prepareMessage(
  client: WeChatClient,
  msg: Message,
  chatId: string,
  chat: Chat,
  liveAccount: ResolvedWeChatAccount,
  policy: WeChatPolicyContext,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<ProcessedMessage | null> {
  const core = getWeChatRuntime();

  // Skip self-sent messages
  if (msg.isSelf) {
    log?.info?.(`[wechat:${liveAccount.accountId}] Skipping self-sent msg ${msg.localId}`);
    return null;
  }

  const isGroup = chatId.includes("@chatroom");
  const senderId = msg.sender ?? chatId;
  const senderName = msg.senderName ?? msg.sender ?? chat.name;
  const wasMentioned = isGroup && (msg.isMentioned === true);

  const access = resolveWeChatInboundAccessDecision({
    isGroup,
    senderId,
    policy,
  });
  if (!access.allowed) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Blocked by policy (${access.reason}) from ${senderId}`,
    );
    return null;
  }

  // Attempt media download for supported types
  let mediaPath: string | undefined;
  let mediaMime: string | undefined;
  let hasMedia = false;

  const baseType = msg.type & 0x7fffffff;
  // Type 49 (appmsg) may contain file attachments — the server resolves subtypes
  // and returns type="file" for subtype 6. Try fetching media for type 49 as well.
  const mayHaveMedia = MEDIA_TYPES.has(baseType) || baseType === 49;

  if (mayHaveMedia) {
    log?.info?.(`[wechat:${liveAccount.accountId}] Checking media for msg ${msg.localId} (type ${baseType})`);
    try {
      // Ask the client to save the exact message before using API fallbacks.
      const mediaPollAttempts = baseType === 34 ? 15 : 2;
      const mediaPollIntervalMs = baseType === 34 ? 1000 : baseType === 3 ? 500 : 500;
      let result = baseType === 3
        ? await withWeChatUi(() => saveOriginalImage(chatId, msg.localId, log))
        : null;
      if (!result?.data && !result?.url) {
        result = await pollMedia(client, chatId, msg.localId, log, mediaPollAttempts, mediaPollIntervalMs);
      }
      if (result && (result.data || result.url) && result.type !== "unsupported") {
        hasMedia = true;
        log?.info?.(`[wechat:${liveAccount.accountId}] Media result: type=${result.type}, format=${result.format}, hasData=${!!result.data}, filename=${result.filename}`);
        const mimeMap: Record<string, string> = {
          jpeg: "image/jpeg",
          jpg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          mp3: "audio/mpeg",
          silk: "audio/silk",
          ogg: "audio/ogg",
          wav: "audio/wav",
          mp4: "video/mp4",
          webm: "video/webm",
          pdf: "application/pdf",
          doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ppt: "application/vnd.ms-powerpoint",
          pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          zip: "application/zip",
          txt: "text/plain",
        };
        mediaMime = mimeMap[result.format] ?? `application/${result.format || "octet-stream"}`;
        let buf: Buffer;
        if (result.data) {
          buf = Buffer.from(result.data, "base64");
        } else {
          const mediaResponse = await fetch(result.url!);
          if (!mediaResponse.ok) {
            throw new Error(`media URL returned HTTP ${mediaResponse.status}`);
          }
          buf = Buffer.from(await mediaResponse.arrayBuffer());
          const remoteMime = mediaResponse.headers.get("content-type")?.split(";")[0];
          if (remoteMime && remoteMime !== "application/octet-stream") {
            mediaMime = remoteMime;
          } else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            mediaMime = "image/png";
          } else if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
            mediaMime = "image/jpeg";
          } else if (buf.subarray(0, 6).toString() === "GIF89a" || buf.subarray(0, 6).toString() === "GIF87a") {
            mediaMime = "image/gif";
          }
        }
        const saved = await core.channel.media.saveMediaBuffer(
          buf,
          mediaMime,
          "inbound",
          baseType === 3 ? 25 * 1024 * 1024 : undefined,
          result.filename,
        );
        mediaPath = saved?.path;
        log?.info?.(`[wechat:${liveAccount.accountId}] Saved media to ${mediaPath}`);
      } else if (MEDIA_TYPES.has(baseType)) {
        if (baseType === 3) {
          try {
            await withWeChatUi(async () => {
            const a11y = await client.a11y("json");
            let correctChat = false;
            const verifyChat = (node: any): void => {
              if (node?.role === "text" && node?.name === chat.name &&
                  node?.states?.includes("EDITABLE") && node?.bounds?.height >= 40) {
                correctChat = true;
              }
              for (const child of node?.children ?? []) verifyChat(child);
            };
            verifyChat(a11y.tree);
            const newestImage = (await client.listMessages(chatId, 20))
              .filter((item) => !item.isSelf && (item.type & 0x7fffffff) === 3)
              .sort((left, right) => right.localId - left.localId)[0];
            if (!correctChat || newestImage?.localId !== msg.localId) {
              throw new Error("Screenshot fallback requires the exact current chat and latest image");
            }
            const imageNodes: Array<{ x: number; y: number; width: number; height: number }> = [];
            const visit = (node: any): void => {
              if (
                node?.role === "list-item" &&
                node?.name === "Image" &&
                node?.bounds &&
                node.bounds.width > 0 &&
                node.bounds.height > 0
              ) {
                imageNodes.push(node.bounds);
              }
              for (const child of node?.children ?? []) visit(child);
            };
            visit(a11y.tree);
            const bounds = imageNodes
              .filter((item) => item.y + item.height > 0)
              .sort((left, right) => left.y - right.y)
              .at(-1);
            if (bounds) {
              const screen = await client.screenshot();
              const screenBuf = Buffer.from(screen.base64, "base64");
              const sharpModule = await import("sharp");
              const sharp = (sharpModule as any).default ?? sharpModule;
              const image = sharp(screenBuf);
              const metadata = await image.metadata();
              const scaleX = 1;
              const scaleY = 1;
              const left = Math.max(0, Math.floor(bounds.x * scaleX));
              const top = Math.max(0, Math.floor(bounds.y * scaleY));
              const width = Math.min(
                (metadata.width ?? 0) - left,
                Math.max(1, Math.floor(bounds.width * scaleX)),
              );
              const height = Math.min(
                (metadata.height ?? 0) - top,
                Math.max(1, Math.floor(bounds.height * scaleY)),
              );
              if (width > 0 && height > 0) {
                const cropped = await image.extract({ left, top, width, height }).png().toBuffer();
                const saved = await core.channel.media.saveMediaBuffer(
                  cropped,
                  "image/png",
                  "inbound",
                  undefined,
                  `wechat-image-${msg.localId}.png`,
                );
                mediaPath = saved?.path;
                mediaMime = "image/png";
                hasMedia = Boolean(mediaPath);
                log?.info?.(`[wechat:${liveAccount.accountId}] Saved cropped WeChat image to ${mediaPath}`);
              }
            }
            });
          } catch (fallbackErr) {
            log?.error?.(`[wechat:${liveAccount.accountId}] Cropped WeChat image fallback failed: ${fallbackErr}`);
          }
        }
        if (mediaPath) {
          log?.info?.(`[wechat:${liveAccount.accountId}] Using WeChat-rendered image fallback for msg ${msg.localId}`);
        } else {
          // Keep the message flowing when WeChat media decryption is unavailable.
          hasMedia = true;
          mediaMime = baseType === 34
            ? "audio/silk"
            : baseType === 43
              ? "video/mp4"
              : "image/jpeg";
          log?.info?.(`[wechat:${liveAccount.accountId}] Media unavailable; dispatching marker for msg ${msg.localId}`);
        }
      }
    } catch (err) {
      log?.error?.(`[wechat:${liveAccount.accountId}] Media download failed: ${err}`);
    }
  }

  const timestamp = new Date(msg.timestamp).getTime();
  let rawBody = msg.content || "";
  if (mediaPath && mediaMime) {
    if (!rawBody) {
      if (mediaMime.startsWith("audio/")) {
        rawBody = "<media:audio>";
      } else if (mediaMime.startsWith("image/")) {
        rawBody = "<media:image>";
      } else {
        rawBody = "<media:file>";
      }
    } else if (!mediaMime.startsWith("image/") && !mediaMime.startsWith("audio/")) {
      rawBody = `[File: ${rawBody}]`;
    }
  } else if (hasMedia && !rawBody) {
    rawBody = baseType === 34 ? "<media:audio>" : baseType === 43 ? "<media:video>" : "<media:image>";
  }

  // Append reply context for quote/reply messages
  if (msg.reply) {
    const replySender = msg.reply.sender ?? "unknown sender";
    const quotedBody = msg.reply.content.length > 50
      ? msg.reply.content.slice(0, 50) + "..."
      : msg.reply.content;
    const replyBlock = `[Replying to ${replySender}]\n${quotedBody}\n[/Replying]`;
    rawBody = rawBody ? `${rawBody}\n\n${replyBlock}` : replyBlock;
  }

  return {
    msg,
    rawBody,
    commandBody: normalizeWeChatCommandBody(rawBody, {
      isGroup,
      wasMentioned,
    }),
    mediaPath,
    mediaMime,
    senderName,
    senderId,
    isGroup,
    timestamp,
    hasMedia,
    isMentioned: wasMentioned,
  };
}

/**
 * Split processed messages into batches where each batch has at most one media message.
 * When a second media is encountered, flush the current batch and start a new one.
 */
function buildSegments(processed: ProcessedMessage[]): ProcessedMessage[][] {
  const segments: ProcessedMessage[][] = [];
  let currentBatch: ProcessedMessage[] = [];
  let mediaCount = 0;

  for (const pm of processed) {
    if (pm.hasMedia && mediaCount >= 1) {
      // Second media in this batch — flush and start new batch
      segments.push(currentBatch);
      currentBatch = [pm];
      mediaCount = 1;
    } else {
      if (pm.hasMedia) mediaCount++;
      currentBatch.push(pm);
    }
  }

  if (currentBatch.length > 0) {
    segments.push(currentBatch);
  }

  return segments;
}

/**
 * Dispatch a segment of one or more messages as a single LLM call.
 */
async function sendWechatTextWithFallback(
  client: WeChatClient,
  chatId: string,
  text: string,
  liveAccount: ResolvedWeChatAccount,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<void> {
  log?.info?.(`[wechat:${liveAccount.accountId}] Sending text for ${chatId} via container UI fallback`);

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    await sendWechatReplyLines(
      text,
      async (payload) => {
        await withWeChatUi(() => execFileAsync(
          "docker",
          ["exec", "agent-wechat", "/opt/tools/send-wechat-text", String(chatId), payload],
          { timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
        ));
      },
      (index, total) => {
        log?.info?.(
          `[wechat:${liveAccount.accountId}] Reply line ${index}/${total} confirmed for ${chatId}`,
        );
      },
    );
    log?.info?.(`[wechat:${liveAccount.accountId}] Reply confirmed for ${chatId}`);
  } catch (err) {
    const failure = err as { code?: string | number; signal?: string; killed?: boolean };
    log?.error?.(
      `[wechat:${liveAccount.accountId}] delivery failed for ${chatId}: code=${failure?.code ?? "unknown"}, signal=${failure?.signal ?? "unknown"}, killed=${failure?.killed ?? false}`,
    );
    throw err;
  }
}

async function dispatchSegment(
  segment: ProcessedMessage[],
  client: WeChatClient,
  chatId: string,
  chat: Chat,
  liveAccount: ResolvedWeChatAccount,
  policy: WeChatPolicyContext,
  storeAllowFrom: string[],
  allowTextCommands: boolean,
  cfg: any,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
  remainingSegments?: number,
): Promise<"delivered" | "skipped" | "failed"> {
  const core = getWeChatRuntime();
  const lastMsg = segment[segment.length - 1];
  const { isGroup, senderId, senderName, timestamp, rawBody, commandBody, msg } = lastMsg;

  // Find the media attachment in this batch (at most one per batch)
  const mediaMsg = segment.find((pm) => pm.mediaPath);
  const mediaPath = mediaMsg?.mediaPath;
  const mediaMime = mediaMsg?.mediaMime;

  log?.info?.(
    `[wechat:${liveAccount.accountId}] Dispatching segment: ${segment.length} msg(s), last=${msg.localId}` +
    `${mediaPath ? ` media=${mediaPath}` : ""}`,
  );

  const hasControlCommand =
    allowTextCommands && core.channel.commands.isControlCommandMessage(commandBody, cfg);
  const commandAuthorized = await resolveWeChatCommandAuthorization({
    cfg,
    rawBody: commandBody,
    isGroup,
    senderId,
    dmPolicy: policy.dmPolicy,
    allowFromForCommands: isGroup ? policy.effectiveGroupAllowFrom : policy.effectiveAllowFrom,
    deps: {
      shouldComputeCommandAuthorized: (raw, loadedCfg) =>
        core.channel.commands.shouldComputeCommandAuthorized(raw, loadedCfg),
      resolveCommandAuthorizedFromAuthorizers: (params) =>
        core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
      readAllowFromStore: async () => storeAllowFrom,
    },
  });
  if (isGroup && allowTextCommands && hasControlCommand && commandAuthorized !== true) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Dropping unauthorized group control command from ${senderId} in ${chatId}`,
    );
    return "skipped";
  }

  const mentionGate = resolveWeChatMentionGate({
    isGroup,
    requireMention: policy.requireMention,
    canDetectMention: true,
    wasMentioned: segment.some((pm) => pm.isMentioned),
    allowTextCommands,
    hasControlCommand,
    commandAuthorized: commandAuthorized === true,
  });
  if (isGroup && mentionGate.shouldSkip) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Skipping group segment (mention required) in ${chatId}`,
    );
    return "skipped";
  }

  try {
    // Resolve routing using the last (triggering) message
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      accountId: liveAccount.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? chatId : senderId,
      },
    });

    return await withWeChatSession(route.sessionKey, async () => {
    const historyContext = await buildWeChatHistoryContext(chatId, rawBody, log);
    const fromLabel = isGroup
      ? `group:${chat.name || chatId}`
      : senderName || `user:${senderId}`;
    const currentMessageBody = labelWeChatMessage(senderName, senderId, rawBody);
    const storePath = core.channel.session.resolveStorePath(
      cfg.session?.store,
      { agentId: route.agentId },
    );

    const envelopeOptions =
      core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp =
      core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });

    // Build body — with history context if batching multiple messages
    let body: string;
    let inboundHistory: Array<{ sender: string; body: string; timestamp?: number }> | undefined;

    if (segment.length === 1) {
      // Single message — format as today
      body = core.channel.reply.formatAgentEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: currentMessageBody,
      });
    } else {
      // Multi-message batch: earlier messages become history context
      const historyMessages = segment.slice(0, -1);

      // Format history entries
      const historyLines = historyMessages.map((pm) => {
        const entryBody = labelWeChatMessage(pm.senderName, pm.senderId, pm.rawBody);
        return core.channel.reply.formatAgentEnvelope({
          channel: "WeChat",
          from: fromLabel,
          timestamp: pm.timestamp,
          envelope: envelopeOptions,
          body: entryBody,
        });
      });

      // Format current (last) message
      const currentLine = core.channel.reply.formatAgentEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: currentMessageBody,
      });

      // Combine with history context markers
      body = [
        HISTORY_CONTEXT_MARKER,
        ...historyLines,
        "",
        CURRENT_MESSAGE_MARKER,
        currentLine,
      ].join("\n");

      // Structured history for InboundHistory field
      inboundHistory = historyMessages.map((pm) => ({
        sender: pm.senderName,
        body: pm.rawBody,
        timestamp: pm.timestamp,
      }));
    }

    body = [
      historyContext,
      "",
      ...(segment.length === 1 ? [CURRENT_MESSAGE_MARKER] : []),
      body,
    ].join("\n");

    // For non-final batches, instruct agent to suppress reply (NO_REPLY token)
    if (remainingSegments && remainingSegments > 0) {
      body += `\n\n[More messages incoming — respond only with NO_REPLY]`;
    }

    // Build inbound context
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: rawBody,
      CommandBody: commandBody,
      InboundHistory: inboundHistory,
      From: isGroup ? `wechat:group:${chatId}` : `wechat:${senderId}`,
      To: `wechat:${chatId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderName || undefined,
      SenderId: senderId,
      Provider: "wechat",
      Surface: "wechat",
      MessageSid: `wechat:${chatId}:${msg.localId}`,
      WasMentioned: isGroup ? mentionGate.effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "wechat",
      OriginatingTo: `wechat:${chatId}`,
      ...(mediaPath ? { MediaPath: mediaPath, MediaUrl: mediaPath, MediaType: mediaMime } : {}),
      ...(msg.reply ? {
        ReplyToBody: msg.reply.content.length > 50 ? msg.reply.content.slice(0, 50) + "..." : msg.reply.content,
        ReplyToSender: msg.reply.sender,
      } : {}),
    });

    // Record session
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err: unknown) => {
        log?.error?.(
          `[wechat:${liveAccount.accountId}] Failed updating session meta: ${String(err)}`,
        );
      },
    });

    // Dispatch reply
    const { onModelSelected, ...prefixOptions } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: "wechat",
      accountId: liveAccount.accountId,
    });

      let deliveryFailed = false;
      let deliveredPayloadCount = 0;
      const dispatchReply = (abortSignal: AbortSignal) =>
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            ...prefixOptions,
            deliver: async (payload: any) => {
              deliveredPayloadCount++;
          const mediaList: string[] = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];

          const tableMode = core.channel.text.resolveMarkdownTableMode({
            cfg,
            channel: "wechat",
            accountId: liveAccount.accountId,
          });
          const text = core.channel.text.convertMarkdownTables(
            payload.text ?? "",
            tableMode,
          );

          if (mediaList.length > 0) {
            for (const mediaUrl of mediaList) {
              try {
                const { base64, filename, mimeType } = await loadWechatMedia(mediaUrl);

                const isImage = mimeType.startsWith("image/");
                if (isImage) {
                  await withWeChatUi(() => client.sendMessage({ chatId, image: { data: base64, mimeType } }));
                } else {
                  await withWeChatUi(() => client.sendMessage({ chatId, file: { data: base64, filename } }));
                }
              } catch (err) {
                deliveryFailed = true;
                log?.error?.(`[wechat:${liveAccount.accountId}] Failed to send media: ${err}`);
              }
            }
            // Send text caption separately if present
            if (text) {
              await sendWechatTextWithFallback(client, chatId, text, liveAccount, log);
            }
          } else if (text) {
            await sendWechatTextWithFallback(client, chatId, text, liveAccount, log);
          }
            },
            onError: (err: unknown, info: any) => {
              deliveryFailed = true;
              log?.error?.(
                `[wechat:${liveAccount.accountId}] ${info.kind} reply failed: ${String(err)}`,
              );
            },
          },
          replyOptions: {
            onModelSelected,
            abortSignal,
          },
        });

      await runWithReplyWatchdog(
        (abortSignal) => dispatchReply(abortSignal),
        {
          timeoutMs: 180_000,
          maxAttempts: 2,
          canRetry: () => deliveredPayloadCount === 0,
          onTimeout: (attempt, timeoutMs) => {
            log?.error?.(
              `[wechat:${liveAccount.accountId}] Model reply watchdog timeout: attempt=${attempt}, timeoutMs=${timeoutMs}, deliveredPayloads=${deliveredPayloadCount}`,
            );
          },
        },
      );

    // Record activity
    core.channel.activity?.record?.({
      channel: "wechat",
      accountId: liveAccount.accountId,
      direction: "inbound",
      at: timestamp,
    });

    return deliveryFailed ? "failed" as const : "delivered" as const;
    });
  } catch (err) {
    log?.error?.(
      `[wechat:${liveAccount.accountId}] Failed to dispatch segment (last msg ${msg.localId}): ${err}`,
    );
    return "failed";
  }
}

function bufferGroupHistory(
  groupHistory: Map<string, ProcessedMessage[]>,
  chatId: string,
  pm: ProcessedMessage,
  limit: number,
): void {
  const history = groupHistory.get(chatId) ?? [];
  history.push(pm);
  while (history.length > limit) {
    history.shift();
  }
  // LRU: refresh key insertion order
  groupHistory.delete(chatId);
  groupHistory.set(chatId, history);
  // Evict oldest groups if too many tracked
  if (groupHistory.size > 1000) {
    const first = groupHistory.keys().next().value;
    if (first) groupHistory.delete(first);
  }
}

async function processUnreadChat(
  client: WeChatClient,
  chat: Chat,
  lastSeenId: Map<string, number>,
  account: ResolvedWeChatAccount,
  cfg: any,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
  skipOpen?: boolean,
  groupHistory?: Map<string, ProcessedMessage[]>,
  groupHistoryLimit?: number,
  fallbackSeenId?: Map<string, number>,
  lastSeenMessageKey?: Map<string, string>,
  pendingMessageGaps?: Map<string, PendingMessageGap>,
): Promise<boolean> {
  const core = getWeChatRuntime();
  // Re-resolve account from hot-reloaded config so policy changes take effect
  const liveAccount =
    resolveWeChatAccount(cfg as Record<string, unknown>, account.accountId) ??
    account;
  const chatId = chat.username ?? chat.id;
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore({ channel: "wechat", accountId: liveAccount.accountId, env: process.env })
    .catch(() => [] as string[]);
  const policy = resolveWeChatPolicyContext({
    account: liveAccount,
    cfg: cfg as any,
    chatId,
    storeAllowFrom,
  });
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "wechat",
  });

  // Open the chat (triggers media downloads + clear unreads)
  if (!skipOpen) {
    log?.info?.(`[wechat:${liveAccount.accountId}] Opening chat ${chatId}...`);
    try {
      await client.openChat(chatId, true);
      log?.info?.(`[wechat:${liveAccount.accountId}] Opened chat ${chatId}`);
    } catch (err) {
      log?.error?.(
        `[wechat:${liveAccount.accountId}] Failed to open chat ${chatId}: ${err}`,
      );
    }
  }

  // Determine how many messages to fetch
  const firstPoll = !lastSeenId.has(chatId);
  const prevLastSeen = lastSeenId.get(chatId) ?? 0;
  const fetchLimit = Math.max(chat.unreadCount, 20);

  let messages: Message[];
  try {
    messages = await client.listMessages(chatId, fetchLimit);
  } catch (err) {
    log?.error?.(
      `[wechat:${liveAccount.accountId}] Failed to list messages for ${chatId}: ${err}`,
    );
    return false;
  }

  log?.info?.(
    `[wechat:${liveAccount.accountId}] ${chatId}: fetched ${messages.length} msgs, firstPoll=${firstPoll}, prevLastSeen=${prevLastSeen}, unreadCount=${chat.unreadCount}`,
  );

  if (messages.length === 0) return false;

  // On first poll, only process the last `unreadCount` messages
  // and seed lastSeenId from the rest
  let newMessages: Message[];
  if (firstPoll) {
    messages.sort((a, b) => a.localId - b.localId);
    const unread = chat.unreadCount ?? 0;
    if (unread > 0 && unread < messages.length) {
      newMessages = messages.slice(-unread);
      const seenMax = messages[messages.length - unread - 1].localId;
      lastSeenId.set(chatId, seenMax);
    } else if (unread >= messages.length) {
      // All fetched messages are unread
      newMessages = messages;
    } else {
      // No unreads — just seed lastSeenId, don't process anything
      const maxId = messages[messages.length - 1].localId;
      lastSeenId.set(chatId, maxId);
      return true;
    }
  } else {
    const maxFetchedId = Math.max(...messages.map((m) => m.localId));
    const indexedGap = Boolean(chat.lastMsgLocalId && chat.lastMsgLocalId > maxFetchedId);
    const alreadyUsedFallback = fallbackSeenId?.get(chatId) === chat.lastMsgLocalId;
    const previousMessageKey = lastSeenMessageKey?.get(chatId);
    const effectivePrevLastSeen =
      getEffectivePreviousLastSeen(
        chat,
        indexedGap && chat.unreadCount > 0 && !alreadyUsedFallback
          ? Math.min(prevLastSeen, maxFetchedId)
          : prevLastSeen,
        maxFetchedId,
        previousMessageKey,
      );
    newMessages = messages.filter((m) => m.localId > effectivePrevLastSeen);
    if (newMessages.length === 0) {
      const fallback = buildMessageFallback(chat, effectivePrevLastSeen);
      if (fallback) {
        if (chat.isGroup && fallback.sender && !/^wxid_|^gh_|^filehelper$|@chatroom$/.test(fallback.sender)) {
          try {
            const contacts = await client.findContacts(fallback.sender);
            const exact = contacts.find((contact) =>
              contact.username === fallback.sender ||
              contact.remark === fallback.sender ||
              contact.nickName === fallback.sender ||
              contact.alias === fallback.sender,
            );
            if (exact) {
              fallback.sender = exact.username;
              fallback.senderName = exact.remark || exact.nickName || exact.username;
            }
          } catch (err) {
            log?.error?.(
              `[wechat:${liveAccount.accountId}] Fallback sender resolution failed for ${chatId}: ${err}`,
            );
          }
        }
        newMessages = [fallback];
        fallbackSeenId?.set(chatId, fallback.localId);
        log?.info?.(
          `[wechat:${liveAccount.accountId}] ${chatId}: using message index fallback for localId=${fallback.localId}`,
        );
      } else {
        pendingMessageGaps?.set(
          chatId,
          scheduleMessageGapRetry(
            chat,
            pendingMessageGaps?.get(chatId),
            Date.now(),
          ),
        );
        log?.info?.(
          `[wechat:${liveAccount.accountId}] ${chatId}: indexed localId=${chat.lastMsgLocalId ?? "unknown"} is not available yet; retrying with backoff`,
        );
        return false;
      }
    }
    newMessages.sort((a, b) => a.localId - b.localId);
  }

  log?.info?.(
    `[wechat:${liveAccount.accountId}] ${chatId}: ${newMessages.length} new msg(s) to process`,
  );

  // Pre-process all messages (filter, download media, build rawBody)
  const processed: ProcessedMessage[] = [];
  for (const msg of newMessages) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Processing msg ${msg.localId}: type=${msg.type}, sender=${msg.sender}, isSelf=${msg.isSelf}, content=${(msg.content || "").slice(0, 50)}`,
    );
    const pm = await prepareMessage(client, msg, chatId, chat, liveAccount, policy, log);
    if (pm) {
      processed.push(pm);
    }
  }

  // Group history catch-up: buffer or inject based on mention status
  const isGroup = chatId.includes("@chatroom");
  let clearBufferedHistory = false;
  const hasControlCommandInWindow =
    allowTextCommands &&
    processed.some((pm) => core.channel.commands.isControlCommandMessage(pm.commandBody, cfg));
  if (isGroup && groupHistory) {
    if (policy.requireMention) {
      const hasMention = processed.some(pm => pm.isMentioned);
      if (!hasMention && !hasControlCommandInWindow) {
        // No mention — buffer all messages and skip dispatch
        const limit = groupHistoryLimit ?? 50;
        for (const pm of processed) {
          bufferGroupHistory(groupHistory, chatId, pm, limit);
        }
        log?.info?.(`[wechat:${liveAccount.accountId}] Buffered ${processed.length} msg(s) for group history in ${chatId}`);
        const maxId = Math.max(...newMessages.map((m) => m.localId));
        lastSeenId.set(chatId, maxId);
          return true;
      }

      if (hasMention) {
        clearBufferedHistory = true;
        // Mention found — pull buffered history and prepend
        const buffered = groupHistory.get(chatId) ?? [];
        if (buffered.length > 0) {
          // Mark buffered messages as mentioned so they remain historical context.
          for (const pm of buffered) {
            pm.isMentioned = true;
          }
          processed.unshift(...buffered);
          log?.info?.(
            `[wechat:${liveAccount.accountId}] Injected ${buffered.length} buffered msg(s) as history in ${chatId}`,
          );
        }

        // Strip media from all but the latest message that has it (across entire combined list)
        let latestMediaIdx = -1;
        for (let i = processed.length - 1; i >= 0; i--) {
          if (processed[i].mediaPath) {
            latestMediaIdx = i;
            break;
          }
        }
        for (let i = 0; i < processed.length; i++) {
          if (processed[i].mediaPath && i !== latestMediaIdx) {
            processed[i] = {
              ...processed[i],
              mediaPath: undefined,
              mediaMime: undefined,
              hasMedia: false,
            };
          }
        }
      }
    } else {
      // Mention is disabled for this group; clear stale buffered entries once we reply.
      clearBufferedHistory = true;
    }
  }

  // Split into segments at media boundaries and dispatch each
  if (processed.length > 0) {
    const segments = hasControlCommandInWindow
      ? processed.map((pm) => [pm])
      : buildSegments(processed);
    log?.info?.(
      `[wechat:${liveAccount.accountId}] ${chatId}: ${processed.length} dispatchable msg(s) in ${segments.length} segment(s)`,
    );
    let allDispatched = true;
    for (let i = 0; i < segments.length; i++) {
      const remaining = segments.length - i - 1;
      const dispatched = await dispatchSegment(
        segments[i],
        client,
        chatId,
        chat,
        liveAccount,
        policy,
        storeAllowFrom,
        allowTextCommands,
        cfg,
        log,
        hasControlCommandInWindow ? undefined : remaining,
      );
      if (dispatched === "failed") {
          log?.error?.(`[wechat:${liveAccount.accountId}] Retaining messages for a delivery retry in ${chatId}`);
          return false;
      }
      if (dispatched === "skipped") {
        allDispatched = false;
      } else {
        lastSeenId.set(chatId, Math.max(...segments[i].map((item) => item.msg.localId)));
      }
    }
    if (clearBufferedHistory && allDispatched && groupHistory) {
      groupHistory.set(chatId, []);
    }
  }

  // Update lastSeenId (track all messages including self-sent/filtered)
  const maxId = Math.max(...newMessages.map((m) => m.localId));
  lastSeenId.set(chatId, maxId);
  return true;
}
