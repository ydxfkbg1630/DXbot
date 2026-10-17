# 抖音私信桥接

通过 Playwright 打开抖音网页私信，定位 `bridge.json` 中的好友，读取最近一条可识别的对方文本，调用 OpenClaw 生成回复并在发送时添加 `DXbot: `。

## 当前能力

| 功能 | 实现 |
|------|------|
| 好友范围 | 按昵称精确定位 `targets` 中的好友，按配置顺序轮询 |
| 自动回复输入 | 当前页面最近一条可识别的对方文本，每次检查最多扫描 40 行 |
| 发送者信息 | 模型输入包含抖音私信渠道、对方昵称和消息正文 |
| 模型与风格 | 使用现有 OpenClaw CLI、供应商配置和 `SOUL.md` 等工作区规则 |
| 会话 ID | `douyin-direct-<昵称 SHA-256 前 16 位>`，使用 ASCII 字符 |
| 状态 | 指纹包含目标、页面行索引和正文，保存在 `state_path` |
| 启动基线 | `mark_seen` 为首次出现的目标建立基线；已有状态的目标会处理重启期间的变化 |
| 回复解析 | 处理完整 JSON、日志夹带 JSON、多行 JSON 和多个文本 payload |
| 静默 | 空文本和 `NO_REPLY` 进入静默分支 |
| 额外发送能力 | 上游 `run.py` 支持定时发送文字、图片和抖音原生表情 |

当前适配采用独立 Python 桥接进程。OpenClaw 原生频道注册、群聊、媒体入模、完整消息队列和逐条补齐密集消息属于后续扩展范围。轮询和指纹依赖网页当前渲染内容，页面版本与虚拟列表变化可能影响识别结果。

## 运行要求

- Linux 服务器、Python 3.11+ 和 Playwright Chromium。
- 已配置模型供应商且可正常调用的 OpenClaw CLI 和网关。
- `node`、`openclaw` 所在目录位于运行进程的 `PATH`。
- 有图形界面的电脑用于首次扫码登录。

抖音桥接和微信扩展使用各自的消息处理入口。抖音读取自身会话记录并共用 OpenClaw 工作区规则；微信历史预加载由微信扩展负责。

## 安装

从 DXbot 仓库根目录进入：

```bash
cd integrations/douyin
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m playwright install --with-deps chromium
```

`--with-deps` 会安装系统浏览器依赖，请在具备相应管理权限的安装终端执行。

## 扫码登录

在有图形界面的 Windows 电脑上进入本目录：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe scripts\login.py
```

在打开的浏览器中完成扫码登录，回到终端按 Enter。脚本会校验登录结果并生成 `storage-state.json`。

通过 SCP 将该文件传到服务器的私有运行目录，例如：

```powershell
scp .\storage-state.json user@example.org:/srv/dxbot-private/douyin/storage-state.json
```

服务器端提前创建目标目录，随后设置该文件权限为 `600`，并把绝对路径填入 `DOUYIN_STORAGE_STATE`。登录态属于账号凭证，应与聊天记录、日志一起保存在部署环境。

## 配置

```bash
cp bridge.example.json bridge.json
cp .env.bridge.example .env.bridge
```

编辑 `bridge.json`：

```json
{
  "targets": ["抖音好友昵称"],
  "poll_interval_seconds": 5,
  "state_path": "artifacts/bridge-state.json",
  "reply_prefix": "DXbot: ",
  "initial_message_policy": "mark_seen",
  "openclaw_timeout_seconds": 180
}
```

`targets` 填写好友当前完整昵称。相对 `state_path` 以配置文件所在目录为基准。每轮依次执行好友定位和模型调用，完成整轮后再等待 `poll_interval_seconds`。因此该值表示轮次之间的等待时间，实际处理间隔还包含页面操作和模型响应耗时。

编辑 `.env.bridge`，填写实际安装位置：

```dotenv
DOUYIN_STORAGE_STATE=/srv/dxbot-private/douyin/storage-state.json
HEADLESS=true
TRACE=false
OPENCLAW_BIN=/usr/local/bin/openclaw
OPENCLAW_HOME=/home/dxbot
```

`OPENCLAW_BIN` 可通过 `command -v openclaw` 查询。`OPENCLAW_HOME` 是 OpenClaw 网关进程使用的用户主目录，其下通常包含 `.openclaw/openclaw.json`；该值与 `.openclaw` 目录本身是两种路径。

配置中的环境变量沿用 `python-dotenv` 的优先级：进程已经设置的值优先于 `.env.bridge`。

## 启动

在 `integrations/douyin` 中执行：

```bash
.venv/bin/python -m app.douyin_bridge --config bridge.json --env-file .env.bridge
```

使用 `-m app.douyin_bridge` 模块入口，使 Python 标准库和项目包按正确顺序加载。

后台运行并保存日志：

```bash
mkdir -p artifacts
nohup .venv/bin/python -u -m app.douyin_bridge \
  --config bridge.json --env-file .env.bridge \
  > artifacts/douyin-bridge.log 2>&1 &
echo $! > artifacts/douyin-bridge.pid

tail -f artifacts/douyin-bridge.log
```

每个账号运行一个桥接实例。日志包含好友昵称、消息指纹片段、模型返回字数和发送结果，应与账号运行数据一同管理。

首次启动日志出现“已建立初始消息基线”后，让目标好友发送测试文本。完整链路的阶段日志依次为：

```text
检测到目标消息
OpenClaw 已返回
抖音回复已发送
已记录消息状态
```

空文本或 `NO_REPLY` 会进入“OpenClaw 请求静默回复”分支，再记录处理状态。`state_path` 以最终处理结果更新。

当前错误会向进程顶层传播，持续运行环境可使用现有的进程管理器接管重启，并保留同一份状态文件。

## 定时发送引擎

本目录同时保留上游发送引擎。`run.py` 使用 `config.json` 或 `config/accounts.json` 进行任务发送，与 `bridge.json` 对应的实时私信桥接各有独立入口。

- [上游项目说明](UPSTREAM.md)
- [Windows 定时发送说明](docs/windows.md)
- [Linux 定时发送说明](docs/server.md)
- [Docker 定时发送说明](docs/docker.md)

随附 Docker Compose、`douyin-sender.service` 和 timer 对应上游定时任务；实时桥接使用本页的模块启动命令。

## 测试

在独立测试环境安装开发依赖：

```bash
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m playwright install --with-deps chromium
.venv/bin/python -m pytest -q
```

测试包含浏览器结构模拟和本地 DOM 用例。GitHub Actions 的 `Douyin Tests` 工作流运行相同测试命令。

## 来源

抖音发送引擎来自 `unmev/douyin-auto-fire`，基准提交为 `af0035f764d3a1adac5884bc3d73adcf031a3dd6`。详见 [NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。
