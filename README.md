# Agent Transport

面向云端 AI 与现有桌面聊天客户端的可靠消息传输工具。

目标体验：

```bash
# 首次启动只传一次 exact 模型名
npm run agent -- --model <exact-original-model-name>

# 后续启动自动恢复当前会话
npm run agent
```

工具负责文本、图片、能力调用、可靠队列、交付确认、断线恢复和在线性；用户电脑仍只运行现有桌面聊天客户端，不新增第二个界面或执行程序。

当前阶段只落架构与协议方案，尚未开始实现。完整方案见 [`docs/architecture.md`](docs/architecture.md)。

安全约定：真实密钥只写部署机上的 `config/runtime.local.json`，该文件不进入 Git；仓库只提供无密钥的配置模板。
