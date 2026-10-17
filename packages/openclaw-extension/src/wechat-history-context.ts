import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const HISTORY_STORE = "/data/agent-wechat/home/.openclaw/workspace/scripts/wechat_history_store.py";
const MAX_CHARS = 200000;

export async function buildWeChatHistoryContext(
  chatId: string,
  rawBody: string,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<string> {
  if (typeof chatId !== "string" || !chatId.trim() || chatId.includes("\0") ||
      typeof rawBody !== "string" || rawBody.includes("\0")) {
    throw new Error("WeChat history input validation failed");
  }

  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile("python3", [
        HISTORY_STORE, "context", chatId, "--query-env", "--max-chars", String(MAX_CHARS),
      ], {
        encoding: "utf8",
        shell: false,
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WECHAT_HISTORY_QUERY: rawBody },
      }, (error, output) => {
        if (error) reject(error);
        else resolve(output);
      });
    });
  } catch {
    // Child errors may carry stdout, stderr, and environment details.
    throw new Error("WeChat history context process failed");
  }

  let result: any;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("WeChat history JSON validation failed");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("WeChat history response validation failed");
  }

  const { text, totalMessages, selectedMessages, mode, sha256 } = result;
  if (!Number.isSafeInteger(totalMessages) || totalMessages < 0 ||
      !Number.isSafeInteger(selectedMessages) || selectedMessages < 0 ||
      selectedMessages > totalMessages) {
    throw new Error("WeChat history counts validation failed");
  }
  if (typeof text !== "string" || [...text].length > MAX_CHARS) {
    throw new Error("WeChat history text validation failed");
  }

  if (totalMessages === 0) {
    if (selectedMessages !== 0 || mode !== "empty") {
      throw new Error("WeChat history empty mode validation failed");
    }
  } else if (selectedMessages === 0 || !text.trim() ||
      (mode !== "full" && mode !== "recent+relevant") ||
      (mode === "full" && selectedMessages !== totalMessages)) {
    throw new Error("WeChat history selection mode validation failed");
  }

  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256) ||
      sha256.toLowerCase() !== hash) {
    throw new Error("WeChat history hash validation failed");
  }
  const context = text.trim() ? text : "[WeChat history context: 0 archived messages]";
  const contextHash = context === text
    ? hash
    : createHash("sha256").update(context, "utf8").digest("hex");
  log?.info?.(
    `[wechat-history-context] chatId=${chatId} totalMessages=${totalMessages} selectedMessages=${selectedMessages} mode=${mode} sha256=${contextHash}`,
  );
  return context;
}
