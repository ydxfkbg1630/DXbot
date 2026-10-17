import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function resolveWechatMediaPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("file://")) {
    return fileURLToPath(trimmed);
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith("$HOME/")) {
    return path.join(process.env.HOME ?? os.homedir(), trimmed.slice("$HOME/".length));
  }
  return trimmed;
}

export function inferWechatMediaMimeType(
  reference: string,
  declaredMimeType?: string | null,
): string {
  if (declaredMimeType?.startsWith("image/")) return declaredMimeType;
  const pathname = reference.startsWith("http://") || reference.startsWith("https://")
    ? new URL(reference).pathname
    : resolveWechatMediaPath(reference);
  const ext = path.extname(pathname).toLowerCase().replace(".", "");
  return MIME_BY_EXTENSION[ext] ?? declaredMimeType ?? "application/octet-stream";
}

export function wechatMediaFilename(reference: string): string {
  const pathname = reference.startsWith("http://") || reference.startsWith("https://")
    ? new URL(reference).pathname
    : resolveWechatMediaPath(reference);
  return path.basename(pathname) || "wechat-media";
}

export async function loadWechatMedia(reference: string): Promise<{
  base64: string;
  filename: string;
  mimeType: string;
}> {
  let bytes: Uint8Array;
  let declaredMimeType: string | null = null;

  if (reference.startsWith("http://") || reference.startsWith("https://")) {
    const response = await fetch(reference);
    if (!response.ok) {
      throw new Error(`Media download failed: HTTP ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
    declaredMimeType = response.headers.get("content-type");
  } else {
    bytes = await fs.readFile(resolveWechatMediaPath(reference));
  }

  return {
    base64: Buffer.from(bytes).toString("base64"),
    filename: wechatMediaFilename(reference),
    mimeType: inferWechatMediaMimeType(reference, declaredMimeType),
  };
}
