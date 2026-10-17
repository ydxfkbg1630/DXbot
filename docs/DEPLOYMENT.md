# DXbot 部署与运维

本指南中的命令默认在 DXbot 仓库根目录执行。项目概览见[首页](../README.md)。

## 部署配套

源码接入时，需要将以下配套脚本与实际部署环境对齐：

| 配套 | 作用 | 调用入口 |
|------|------|----------|
| `wechat_history_store.py` | 提供历史聊天上下文 | [`wechat-history-context.ts`](../packages/openclaw-extension/src/wechat-history-context.ts) |
| `/opt/tools/save-wechat-image` | 微信客户端图片保存 | [`monitor.ts`](../packages/openclaw-extension/src/monitor.ts) |
| 微信容器内 `/opt/tools/send-wechat-text` | 微信文本投递必需脚本 | [`monitor.ts`](../packages/openclaw-extension/src/monitor.ts) |

这些配套由部署环境提供，脚本位置、权限和调用参数应与源码中的配置一致。媒体理解由 OpenClaw、模型及转写或识别服务共同完成。

DXbot 是一个面向服务器部署的微信、抖音自动回复与 OpenClaw 接入项目。微信通过 `agent-server` 提供客户端控制和消息、媒体访问；抖音通过独立 Python + Playwright 桥接进程监听指定好友的私信。两条链路使用 OpenClaw 调用模型，并在发送层添加 `DXbot:` 标识。

本仓库同步自服务器上的实际运行项目，包含微信消息与媒体链路、OpenClaw 微信扩展、历史上下文和回复可靠性模块，以及抖音私信文本自动回复适配。当前同步日期：2026-10-17。

**许可范围：** DXbot 原创贡献采用 **AGPL-3.0-only**；抖音目录采用 **PolyForm Noncommercial 1.0.0**；微信继承代码的授权范围以原作者明确授予的条款为准。完整说明见 [LICENSING.md](../LICENSING.md) 和[第三方声明](../THIRD_PARTY_NOTICES.md)。

## 平台入口

| 平台 | 接入方式 | 文档 |
|------|----------|------|
| 微信 | Rust 服务 + OpenClaw 微信频道扩展 | 本页微信部署和 OpenClaw 接入章节 |
| 抖音 | Python + Playwright 私信桥接 | [抖音配置、登录、启动与日志](../integrations/douyin/README.md) |

## 核心能力

- 微信私聊和群聊消息轮询
- 群聊 @ 提及、白名单和会话策略
- 消息水位持久化与消息间隙补偿
- 轮询门控，过滤系统会话、公众号和策略关闭的聊天
- 图片、语音、视频、文件和表情消息处理
- 微信客户端媒体保存、远程媒体下载和 MIME 类型推断
- 历史消息与会话记忆上下文接入
- 历史上下文数量、模式和 SHA-256 校验
- OpenClaw 微信频道扩展
- 抖音指定好友私信文本监听与自动回复
- 抖音好友级 ASCII 哈希会话 ID、消息指纹持久化和启动基线
- OpenClaw 单行、多行 JSON 回复解析
- 模型回复超时看门狗与空投递重试
- 多行回复逐行发送与发送进度记录
- 机器人发送层固定添加 `DXbot:` 前缀
- Docker、Rust/Axum、TypeScript、SQLite 和确定性 FSM

## 微信回复流程

```text
微信客户端
    │
    ▼
agent-server（Rust/Axum，端口 6174）
    │ 读取消息、保存水位、下载媒体、保存会话状态
    ▼
OpenClaw 微信扩展
    │ 轮询门控、消息补偿、历史上下文、媒体路径和发送者标签
    ▼
模型供应商
    │ 生成原始回复
    ▼
回复看门狗与发送器
    │ 超时重试、逐行发送、统一添加 DXbot:
    ▼
微信客户端发送
```

`DXbot:` 位于最终发送层，模型收到的系统规则、历史会话和记忆内容保持原始形态。相关实现位于：

```text
packages/openclaw-extension/src/reply-prefix.ts
packages/openclaw-extension/src/reply-sender.ts
packages/openclaw-extension/src/monitor.ts
```

发送结果示例：

```text
DXbot: 这是模型生成的回复
```

## 可靠性模块

OpenClaw 微信扩展的主要可靠性模块如下：

| 模块 | 作用 |
|------|------|
| `message-watermark.ts` | 记录聊天水位、消息指纹和消息间隙重试状态 |
| `message-fallback.ts` | 在消息索引延迟期间使用聊天预览构造可处理消息 |
| `poll-gate.ts` | 按私聊、群聊、白名单和系统会话策略控制轮询 |
| `reply-watchdog.ts` | 为模型回复设置超时、取消信号和空投递重试 |
| `reply-sender.ts` | 拆分多行回复，逐行加前缀并发送 |
| `wechat-history-context.ts` | 读取历史上下文并验证数量、模式和哈希 |
| `wechat-media.ts` | 加载本地路径或 HTTP 媒体并推断 MIME 类型 |
| `wechat-sender-label.ts` | 为模型输入添加发送者名称或 ID |
| `chat-work-queue.ts` | 按聊天维度管理并发任务与 UI 操作 |

## 项目结构

```text
packages/
├── agent-server-rust/    Rust/Axum 服务、微信 UI 自动化和媒体访问
├── openclaw-extension/   OpenClaw 微信频道扩展
├── shared/               Rust 与 TypeScript 共用类型
├── cli/                  命令行工具
├── wechaty-gateway/      Wechaty 网关
└── wechaty-puppet/       Wechaty Puppet

docker/                   Docker 镜像和微信客户端工具
docs/                     项目文档
scripts/                  构建、部署和类型生成脚本
integrations/douyin/       抖音桥接、发送引擎、登录脚本和 Python 测试
```

## 环境要求

- Linux 服务器或具备完整 Docker 能力的主机
- Docker 和 Docker Compose
- Node.js 22 或更高版本
- pnpm 9.15.4
- Rust stable 工具链
- 微信账号登录所需的二维码扫描设备
- `SYS_PTRACE` 和 `seccomp=unconfined` 容器能力

微信运行在 Docker 容器中的图形环境内，服务器需要保留持久化数据卷。

## 从源码构建

```bash
git clone https://github.com/ydxfkbg1630/DXbot.git
cd DXbot

corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile

pnpm build
pnpm typecheck
pnpm -r --if-present test
```

Rust 服务检查：

```bash
cargo check --manifest-path packages/agent-server-rust/Cargo.toml
cargo test --manifest-path packages/agent-server-rust/Cargo.toml
```

## Docker 启动

先创建认证令牌：

```bash
mkdir -p ~/.config/agent-wechat
openssl rand -hex 32 > ~/.config/agent-wechat/token
chmod 600 ~/.config/agent-wechat/token
```

启动容器：

```bash
docker compose up -d
docker compose logs -f agent-wechat
```

仓库中的 Compose 示例使用上游基础镜像。采用本仓库的 Rust 服务端修改时，可在 Linux amd64 主机上构建源码，并将本地镜像标签与 Compose 对齐：

```bash
pnpm build:image:amd64
docker tag agent-wechat:amd64 ghcr.io/thisnick/agent-wechat:latest
docker compose up -d --pull never
curl --fail http://127.0.0.1:6174/health
```

Linux arm64 主机使用 `pnpm build:image:arm64`，并将标签来源改为 `agent-wechat:arm64`。实际部署还需对齐上文列出的配套脚本。

服务默认端口：

| 端口 | 用途 |
|------|------|
| `6174` | agent-server REST API、WebSocket 和 VNC |

本地镜像构建：

```bash
pnpm build:image:amd64
pnpm build:image:arm64
pnpm build:image:all
```

## OpenClaw 接入

构建微信扩展：

```bash
pnpm --filter @agent-wechat/wechat build
```

本地开发安装：

```bash
openclaw plugins install -l ./packages/openclaw-extension
```

微信频道配置示例：

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "serverUrl": "http://127.0.0.1:6174",
      "token": "${AGENT_WECHAT_TOKEN}",
      "dmPolicy": "allowlist",
      "allowFrom": ["wxid_example"],
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["wxid_example"],
      "pollIntervalMs": 1000,
      "authPollIntervalMs": 30000
    }
  }
}
```

服务器地址、令牌、模型 API Key 和白名单属于部署配置，推荐通过环境变量、OpenClaw 配置目录或服务器密钥管理服务注入。

## 抖音接入

抖音适配位于 [`integrations/douyin`](../integrations/douyin/README.md)，以独立进程调用现有 OpenClaw CLI。模型供应商和 `SOUL.md` 等工作区规则由 OpenClaw 管理。

```text
抖音网页私信
  → Playwright 定位配置中的好友
  → 读取最近一条可识别的对方文本并比较消息指纹
  → OpenClaw 独立会话 ID：douyin-direct-<好友昵称 SHA-256 前 16 位>
  → 解析模型 JSON 回复
  → 发送层添加 DXbot: 并通过抖音网页发送
  → 保存处理指纹
```

Linux 服务器安装和启动：

```bash
cd integrations/douyin
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m playwright install --with-deps chromium

cp bridge.example.json bridge.json
cp .env.bridge.example .env.bridge
# 在 bridge.json 填写目标好友昵称，在 .env.bridge 填写登录态和 OpenClaw 路径
# storage-state.json 由 scripts/login.py 在有图形界面的电脑上扫码生成后传入

.venv/bin/python -m app.douyin_bridge --config bridge.json --env-file .env.bridge
```

当前自动回复范围为指定好友的私信文本，轮询以页面可识别的最近一条对方文本为单位。图片和抖音原生表情的定时发送由随附的上游发送引擎提供，使用 `run.py` 和任务配置。详细登录步骤、后台运行、日志和能力范围见[抖音文档](../integrations/douyin/README.md)。

## 微信媒体链路

媒体消息经过以下步骤进入模型：

1. agent-server 识别微信消息类型
2. 微信客户端保存原始媒体，服务端读取客户端保存结果
3. 服务端验证文件格式并保存到 OpenClaw 媒体目录
4. OpenClaw 解析本地路径、HTTP 地址、文件名和 MIME 类型
5. 历史上下文与当前媒体消息一起进入回复会话
6. 模型根据图片、语音、文件或表情内容生成回复
7. 媒体回复与文本说明经过统一发送层发回微信

图片、语音和文件数据属于运行时数据，存储在部署服务器的数据卷中。公开仓库只保存源码和测试。

## 消息接收与补偿

扩展保存两类消息水位：

- 聊天级 `lastMsgLocalId`
- 当前消息的时间、发送者和预览指纹

当微信聊天列表已经出现新消息，而消息索引仍处于同步阶段时，扩展会按递增间隔重试；聊天预览具备有效内容时，会构造消息补偿对象进入正常回复链路。机器人自身以 `DXbot:` 开头的预览会被识别为机器人消息，避免重复处理。

## 常用命令

```bash
# 启动和停止通过 Compose 部署的微信容器
docker compose start
docker compose stop

# 查看状态和日志
pnpm cli status
pnpm cli logs

# 登录微信
pnpm cli auth login

# 查询聊天和消息
pnpm cli chats list
pnpm cli chats find "群聊名称"
pnpm cli messages list <chat-id>

# 发送文本或图片
pnpm cli messages send <chat-id> --text "你好"
pnpm cli messages send <chat-id> --image ./example.png
```

## 安全配置

- 认证令牌保存于 `~/.config/agent-wechat/token` 或 `AGENT_WECHAT_TOKEN`
- 远程访问使用 HTTPS、网络访问控制和最小权限令牌
- API Key、微信数据库、媒体文件和会话记忆保存在部署环境
- 公开仓库只包含源码、文档、测试和构建配置
- 日志、备份、运行时数据库、依赖目录和本地环境文件保存在部署环境

提交代码前请检查令牌、密码、私钥、微信数据文件和服务器地址。

## 开发与测试

```bash
pnpm build
pnpm typecheck
pnpm -r --if-present test
pnpm dev:deploy
```

OpenClaw 扩展的局部测试：

```bash
pnpm --filter @agent-wechat/wechat test
```

抖音适配测试在独立 Python 环境中运行：

```bash
cd integrations/douyin
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m playwright install --with-deps chromium
.venv/bin/python -m pytest -q
```

微信 UI 操作由确定性 FSM 驱动，主要流程位于：

```text
packages/agent-server-rust/src/ia/
packages/agent-server-rust/src/plans/
packages/agent-server-rust/src/execution/
```

OpenClaw 微信回复流程位于：

```text
packages/openclaw-extension/src/monitor.ts
packages/openclaw-extension/src/access-control.ts
packages/openclaw-extension/src/chat-work-queue.ts
packages/openclaw-extension/src/message-watermark.ts
packages/openclaw-extension/src/reply-watchdog.ts
```

## 上游项目

DXbot 基于 `agent-wechat` 的微信自动化能力扩展而来，保留原项目的 Docker、Rust 服务、CLI、Wechaty 和文档结构，并加入服务器部署场景所需的消息、媒体、会话、补偿和 OpenClaw 适配。

抖音发送引擎来自 [unmev/douyin-auto-fire](https://github.com/unmev/douyin-auto-fire)，基准提交为 `af0035f764d3a1adac5884bc3d73adcf031a3dd6`。适配目录保留上游源码、原始说明和许可声明，来源详见 [NOTICE.md](../integrations/douyin/NOTICE.md)。

## 贡献

欢迎提交 Issue、Pull Request、测试用例和文档改进。提交前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)，运行构建、类型检查和相关测试，并在描述中说明验证命令和运行环境。

## 许可证说明

Copyright (c) 2026 **ydxfkbg1630**，限 DXbot 原创贡献。上游作者和其他贡献者保留其各自作品的版权。

| 范围 | 许可与权利来源 |
|------|----------------|
| DXbot 维护者有权授权的原创代码、原创修改和原创文档 | [GNU AGPL v3，仅版本 3](../LICENSE)，SPDX：`AGPL-3.0-only` |
| `integrations/douyin/`，含发送引擎及桥接 | 维持该目录的 [PolyForm Noncommercial 1.0.0](../integrations/douyin/LICENSE) 及[来源声明](../integrations/douyin/NOTICE.md) |
| 继承自 `thisnick/agent-wechat` 的代码和修改文件中的上游部分 | 保留原作者权利；完整授权依据按[第三方声明](../THIRD_PARTY_NOTICES.md)核实 |
| 第三方依赖、镜像组件、客户端和素材 | 各权利人提供的适用条款 |

AGPL 覆盖部分允许按条款使用、修改和商业分发，要求保留版权和许可证，分发修改版时标注修改并提供相应源码。修改版通过网络与用户交互时，应按第 13 条向相关用户提供该版本完整对应源码的获取入口。抖音目录的使用范围按其非商业许可另行判断。

完整许可范围、既有版本授权和源码交付说明见 [LICENSING.md](../LICENSING.md)。署名信息见 [NOTICE.md](../NOTICE.md)，项目名称和标识的使用说明见 [BRANDING.md](../BRANDING.md)。
