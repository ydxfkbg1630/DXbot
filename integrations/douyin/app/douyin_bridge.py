from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

from app.bridge_core import (
    InboundMessage,
    build_openclaw_prompt,
    parse_openclaw_json_output,
    should_send_reply,
)
from app.browser import open_douyin, open_private_messages, verify_login
from app.config import ConfigError, load_settings
from app.douyin import DouyinChat
from app.sender import send_text


LOGGER = logging.getLogger("douyin_bridge")
MESSAGE_ROWS = ".messageMessageListlist [data-index]"
CONTENT_SELECTOR = '[data-e2e="msg-item-content"]'
SELF_MARKER = ".messageMessageBoxisFromMe"


def load_bridge_config(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ConfigError("抖音桥接配置必须是对象")
    targets = raw.get("targets")
    if not isinstance(targets, list) or not all(isinstance(item, str) and item.strip() for item in targets):
        raise ConfigError("抖音桥接配置 targets 必须是非空字符串数组")
    return {
        "targets": [item.strip() for item in targets],
        "poll_interval_seconds": max(2, float(raw.get("poll_interval_seconds", 5))),
        "state_path": Path(raw.get("state_path", "artifacts/bridge-state.json")).expanduser(),
        "reply_prefix": str(raw.get("reply_prefix", "DXbot: ")),
        "initial_message_policy": str(raw.get("initial_message_policy", "mark_seen")),
        "openclaw_timeout_seconds": max(30, int(raw.get("openclaw_timeout_seconds", 180))),
    }


def load_state(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return raw if isinstance(raw, dict) else {}


def save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


async def latest_inbound_message(page: Any, target: str) -> InboundMessage | None:
    rows = page.locator(MESSAGE_ROWS)
    count = await rows.count()
    for position in range(min(count, 40)):
        row = rows.nth(position)
        if await row.locator(SELF_MARKER).count():
            continue
        content = row.locator(CONTENT_SELECTOR).first
        if not await content.count():
            content = row
        text = (await content.inner_text()).strip()
        if not text:
            continue
        index = await row.get_attribute("data-index") or str(position)
        return InboundMessage(target=target, index=index, text=text)
    return None


async def invoke_openclaw(message: InboundMessage, timeout_seconds: int) -> str:
    binary = os.getenv("OPENCLAW_BIN", "/data/agent-wechat/npm-global/bin/openclaw")
    home = os.getenv("OPENCLAW_HOME", "/data/agent-wechat/home")
    target_key = hashlib.sha256(message.target.encode("utf-8")).hexdigest()[:16]
    session_id = f"douyin-direct-{target_key}"
    env = {
        **os.environ,
        "HOME": home,
        "PATH": f"/data/agent-wechat/node/bin:/data/agent-wechat/npm-global/bin:{os.environ.get('PATH', '')}",
    }
    process = await asyncio.create_subprocess_exec(
        binary,
        "agent",
        "--session-id",
        session_id,
        "--message",
        build_openclaw_prompt(message),
        "--json",
        "--timeout",
        str(timeout_seconds),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, stderr = await asyncio.wait_for(
        process.communicate(),
        timeout=timeout_seconds + 30,
    )
    if process.returncode != 0:
        raise RuntimeError(f"OpenClaw agent failed with code {process.returncode}: {stderr.decode(errors='replace')[-500:]}")
    return parse_openclaw_json_output(stdout.decode(errors="replace"))


async def run_bridge(config_path: Path, env_file: str | None = None) -> None:
    config = load_bridge_config(config_path)
    state_path = config["state_path"]
    if not state_path.is_absolute():
        state_path = config_path.parent / state_path
    state = load_state(state_path)
    settings = load_settings(env_file)
    if not settings.storage_state and not settings.cookie:
        raise ConfigError("抖音桥接需要 DOUYIN_STORAGE_STATE 或 DOUYIN_COOKIE")

    async with open_douyin(settings) as session:
        page = session.page
        await open_private_messages(page)
        await verify_login(page)
        chat = DouyinChat(page)
        initialized: set[str] = set()
        while True:
            for target in config["targets"]:
                await chat.open_target(target)
                inbound = await latest_inbound_message(page, target)
                if inbound is None:
                    continue
                LOGGER.info("检测到目标消息: target=%s fingerprint=%s", target, inbound.fingerprint[:12])
                if target not in initialized:
                    initialized.add(target)
                    if config["initial_message_policy"] == "mark_seen" and target not in state:
                        state[target] = inbound.fingerprint
                        save_state(state_path, state)
                        LOGGER.info("已建立初始消息基线: target=%s", target)
                        continue
                if state.get(target) == inbound.fingerprint:
                    continue
                reply = await invoke_openclaw(inbound, config["openclaw_timeout_seconds"])
                LOGGER.info("OpenClaw 已返回: target=%s reply_chars=%d", target, len(reply))
                if should_send_reply(reply):
                    await send_text(chat, f"{config['reply_prefix']}{reply}")
                    LOGGER.info("抖音回复已发送: target=%s", target)
                else:
                    LOGGER.info("OpenClaw 请求静默回复: target=%s", target)
                state[target] = inbound.fingerprint
                save_state(state_path, state)
                LOGGER.info("已记录消息状态: target=%s", target)
            await asyncio.sleep(config["poll_interval_seconds"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="bridge.json")
    parser.add_argument("--env-file")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(run_bridge(Path(args.config), args.env_file))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
