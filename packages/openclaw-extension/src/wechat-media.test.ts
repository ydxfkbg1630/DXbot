import test from "node:test";
import assert from "node:assert/strict";
import {
  inferWechatMediaMimeType,
  resolveWechatMediaPath,
  wechatMediaFilename,
} from "./wechat-media.ts";

test("resolves tilde paths against the server home directory", () => {
  assert.equal(
    resolveWechatMediaPath("~/.openclaw/workspace/generated/g_b.gif"),
    "/data/agent-wechat/home/.openclaw/workspace/generated/g_b.gif",
  );
});

test("recognizes GIF and WebP sticker media", () => {
  assert.equal(
    inferWechatMediaMimeType("~/.openclaw/workspace/generated/g_b.gif"),
    "image/gif",
  );
  assert.equal(inferWechatMediaMimeType("file:///tmp/sticker.webp"), "image/webp");
});

test("uses image content type from a remote media response", () => {
  assert.equal(
    inferWechatMediaMimeType(
      "https://example.test/generated/sticker",
      "image/gif",
    ),
    "image/gif",
  );
});

test("keeps the original filename for local and file URL media", () => {
  assert.equal(
    wechatMediaFilename("~/.openclaw/workspace/generated/g_b.gif"),
    "g_b.gif",
  );
  assert.equal(wechatMediaFilename("file:///tmp/sticker.webp"), "sticker.webp");
});
