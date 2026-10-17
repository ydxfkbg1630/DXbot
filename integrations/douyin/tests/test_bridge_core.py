import json

from app.bridge_core import (
    InboundMessage,
    build_openclaw_prompt,
    parse_openclaw_json_output,
    should_send_reply,
)


def test_inbound_fingerprint_changes_when_message_changes() -> None:
    first = InboundMessage("测试好友", "0", "你好")
    second = InboundMessage("测试好友", "0", "在吗")
    assert first.fingerprint != second.fingerprint


def test_openclaw_prompt_contains_target_and_message() -> None:
    prompt = build_openclaw_prompt(InboundMessage("测试好友", "1", "你好"))
    assert "测试好友" in prompt
    assert "你好" in prompt
    assert "抖音私信" in prompt


def test_parse_openclaw_json_payloads() -> None:
    stdout = 'info\n{"payloads":[{"text":"第一句"},{"text":"第二句"}]}\n'
    assert parse_openclaw_json_output(stdout) == "第一句\n第二句"


def test_parse_multiline_gateway_response() -> None:
    payload = {
        "status": "ok",
        "result": {"payloads": [{"text": "第一句"}, {"text": "第二句"}]},
    }
    assert parse_openclaw_json_output(json.dumps(payload, indent=2)) == "第一句\n第二句"


def test_parse_multiline_gateway_response_after_log_prefix() -> None:
    payload = {"result": {"payloads": [{"text": "回复内容"}]}}
    stdout = "info: gateway ready\n" + json.dumps(payload, indent=2)
    assert parse_openclaw_json_output(stdout) == "回复内容"


def test_no_reply_sentinel_is_suppressed() -> None:
    assert should_send_reply("NO_REPLY") is False
    assert should_send_reply("可以") is True
