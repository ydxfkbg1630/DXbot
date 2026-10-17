from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class InboundMessage:
    target: str
    index: str
    text: str

    @property
    def fingerprint(self) -> str:
        raw = f"{self.target}\n{self.index}\n{self.text}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_openclaw_prompt(message: InboundMessage) -> str:
    return (
        "当前渠道是抖音私信。\n"
        f"对方昵称：{message.target}\n"
        f"对方消息：{message.text}\n\n"
        "请按当前 SOUL.md 和已有回复规则直接生成给对方的回复。"
        "保持自然、简短、像本人聊天。只输出要发送的正文，不要解释过程，"
        "不要添加 DXbot 前缀。需要时可以回复 NO_REPLY。"
    )


def extract_openclaw_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if isinstance(payload, list):
        return "\n".join(filter(None, (extract_openclaw_text(item) for item in payload))).strip()
    if not isinstance(payload, dict):
        return ""
    for key in ("text", "content", "message", "response"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("payloads", "replies", "result", "data"):
        if key in payload:
            value = extract_openclaw_text(payload[key])
            if value:
                return value
    return ""


def parse_openclaw_json_output(stdout: str) -> str:
    stripped = stdout.strip()
    if stripped:
        try:
            text = extract_openclaw_text(json.loads(stripped))
            if text:
                return text
        except json.JSONDecodeError:
            pass

    decoder = json.JSONDecoder()
    for index, char in enumerate(stdout):
        if char not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(stdout, index)
        except json.JSONDecodeError:
            continue
        text = extract_openclaw_text(value)
        if text:
            return text

    for line in reversed([line.strip() for line in stdout.splitlines() if line.strip()]):
        try:
            text = extract_openclaw_text(json.loads(line))
        except json.JSONDecodeError:
            continue
        if text:
            return text
    return ""


def should_send_reply(text: str) -> bool:
    return bool(text.strip()) and text.strip().upper() != "NO_REPLY"
