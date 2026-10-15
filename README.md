# DXbot

DXbot 是一个面向服务器部署的微信自动化与 OpenClaw 接入项目。它以 `agent-server` 作为微信客户端控制层，通过 REST/WebSocket 提供聊天、消息、媒体、登录和发送能力，再由 OpenClaw 负责会话路由、模型调用和自动回复。

当前仓库是在 `agent-wechat` 基础上的 DXbot 部署版本，包含微信消息接收、图片/语音/文件/表情媒体链路、OpenClaw 微信扩展、会话上下文和机器人回复发送层改动。

## 核心能力

- 微信私聊和群聊消息轮询
- 群聊 @ 提及、白名单和会话策略
- 图片、语音、视频、文件和表情消息处理
- 客户端媒体下载链路，媒体文件保存后传入模型上下文
- 历史消息与会话记忆上下文接入
- OpenClaw 微信频道扩展
- DeepSeek 等模型供应商的 OpenClaw 路由配置
- 机器人发送层固定添加 `DXbot:` 前缀
- Docker、Rust/Axum、TypeScript、SQLite 和确定性 FSM

## 回复流程

```text
微信客户端
    │
    ▼
agent-server（Rust/Axum，端口 6174）
    │ 读取消息、下载媒体、保存会话状态
    ▼
OpenClaw 微信扩展
    │ 组装当前消息、历史上下文和媒体路径
    ▼
模型供应商
    │ 生成原始回复
    ▼
最终发送层
    │ 自动添加 DXbot:
    ▼
微信客户端发送
```

`DXbot:` 位于最终发送层，模型收到的系统规则、历史会话和记忆内容保持原始形态。相关实现位于：

```text
packages/openclaw-extension/src/reply-prefix.ts
packages/openclaw-extension/src/monitor.ts
```

发送结果示例：

```text
DXbot: 这是模型生成的回复
```

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

服务默认端口：

| 端口 | 用途 |
|------|------|
| `6174` | agent-server REST API、WebSocket 和 VNC |

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

## 媒体处理链路

媒体消息经过以下步骤进入模型：

1. agent-server 识别微信消息类型
2. 微信客户端下载或保存原始媒体
3. 服务端验证文件格式并保存到本地媒体目录
4. OpenClaw 将媒体路径、MIME 类型和当前消息传入回复会话
5. 模型根据图片、语音、文件或表情内容生成回复
6. 文本说明和媒体回复经过统一发送层发回微信

图片、语音和文件数据属于运行时数据，存储在部署服务器的数据卷中。

## 常用命令

```bash
# 启动和停止微信容器
pnpm cli up
pnpm cli down

# 查看状态和日志
pnpm cli status
pnpm cli logs

# 登录微信
pnpm cli auth login

# 查询聊天和消息
pnpm cli chats list
pnpm cli find "群聊名称"
pnpm cli messages list <chat-id>

# 发送文本或图片
pnpm cli messages send <chat-id> --text "你好"
pnpm cli messages send <chat-id> --image ./example.png
```

## 安全配置

- 认证令牌保存于 `~/.config/agent-wechat/token` 或 `AGENT_WECHAT_TOKEN`
- 远程访问使用 HTTPS、网络访问控制和最小权限令牌
- API Key、微信数据库、媒体文件和会话记忆保存在部署环境
- 公开仓库仅包含源码、文档、测试和构建配置
- 日志、备份、运行时数据库、依赖目录和本地环境文件保存在部署环境

提交代码前请检查令牌、密码、私钥、微信数据文件和服务器地址。

## 开发约定

```bash
pnpm build
pnpm typecheck
pnpm -r --if-present test
pnpm dev:deploy
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
```

## 上游项目

DXbot 基于 `agent-wechat` 的微信自动化能力扩展而来，保留原项目的 Docker、Rust 服务、CLI、Wechaty 和文档结构，并加入服务器部署场景所需的消息、媒体、会话和 OpenClaw 适配。

## 贡献

欢迎提交 Issue、Pull Request、测试用例和文档改进。提交前请运行构建、类型检查和相关测试，并在描述中说明验证命令和运行环境。

## 许可证说明

仓库内各组件沿用对应目录的包元数据和上游项目许可信息。使用或再发布前，请检查相关包的 `package.json`、Rust `Cargo.toml` 和上游项目许可条款。
