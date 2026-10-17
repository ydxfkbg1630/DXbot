# 第三方来源与许可声明

本清单记录已识别的重要来源和许可范围。依赖及镜像分发还应附随实际采用版本的完整许可清单。

## agent-wechat

- 来源：<https://github.com/thisnick/agent-wechat>
- 继承范围：微信客户端控制、Rust 服务、CLI、OpenClaw 扩展基础代码、Wechaty 集成、构建脚本、Docker 工具和相应文档。
- 版本线索：继承的分包版本为 `0.11.9`，相关上游版本为 `v0.11.9`。
- 权利归属：原作者及各自贡献者保留其作品的版权。
- 授权状态：完整许可授予范围待上游权利人确认。

2026-10-17 核查的上游 `v0.11.9` 与当前仓库快照中，完整授权条款仍待确认。DXbot 先前的 `packages/openclaw-extension/package.json` 曾包含 `ISC` 字段；本次对照上游仓库和对应 npm 包的结果使该字段的授权来源进入待核实范围。因此，当前包元数据改为指向明确的许可范围说明。

DXbot 根目录的 AGPL 授权仅覆盖维护者有权授权的原创材料。继承代码的再分发、商用和衍生授权应通过上游权利人确认。

## 抖音发送引擎与桥接

- 来源：<https://github.com/unmev/douyin-auto-fire>
- 基准提交：`af0035f764d3a1adac5884bc3d73adcf031a3dd6`
- 范围：整个 `integrations/douyin/` 目录。
- 许可：PolyForm Noncommercial License 1.0.0。
- 版权声明：`Required Notice: Copyright (c) 2026 unmev`。
- 许可与适配说明：[LICENSE](integrations/douyin/LICENSE)、[NOTICE.md](integrations/douyin/NOTICE.md)。

该目录维持独立许可范围，使用及分发应符合其随附条款。其使用范围与 DXbot 原创 AGPL 材料的使用范围分别判断。

## 媒体处理来源

`docker/tools/media-convert.py` 中的 `find_data_partitions` 相关逻辑注明参考了 chatlog 的 `wxgf.go` 实现。该来源的具体版本、版权声明和适用许可属于待核实项目，应在分发相关组件前完成来源核验并附上所需声明。

## 镜像与依赖组件

构建镜像及二进制可能包含或引用以下组件：

- noVNC 和相关远程桌面组件。
- SQLCipher、SQLite、OpenSSL 及相应构建依赖。
- 微信客户端及其随附材料。
- Node.js、npm、Cargo 和 Python 依赖。

各组件的版权、许可证、商标和使用条款由各权利人提供。发布镜像、二进制或组合包时，应根据实际构建版本保留并交付相应声明。

## 来源修正

权利人和贡献者可通过仓库 Issue 或 Pull Request 提交具体文件、来源版本及许可依据，协助补充准确归属和授权说明。涉及个人信息或凭据的材料请通过事先协商的私密渠道提供。
