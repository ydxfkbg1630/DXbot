# Source and Attribution

The browser automation and scheduled sending engine in this directory originate
from [unmev/douyin-auto-fire](https://github.com/unmev/douyin-auto-fire).

- Upstream revision: `af0035f764d3a1adac5884bc3d73adcf031a3dd6`
- Required Notice: Copyright (c) 2026 unmev
- License: PolyForm Noncommercial License 1.0.0, as recorded in [LICENSE](LICENSE)
- Original project overview: [UPSTREAM.md](UPSTREAM.md)

DXbot additions include `app/bridge_core.py`, `app/douyin_bridge.py`,
`bridge.example.json`, `.env.bridge.example`, and bridge regression tests.
The imported login helper also includes the deployed project-root import setup.
These additions connect the browser automation to OpenClaw for private-message
text replies. The upstream license notice is retained with the imported engine.
