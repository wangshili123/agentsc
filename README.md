# Agent Transport

面向云端 AI 与现有桌面聊天客户端的可靠消息传输工具。

clone 后先安装锁定依赖，再启动：

```bash
corepack pnpm install --frozen-lockfile

# 首次启动只传一次 exact 模型名
npm run agent -- --model <exact-original-model-name>

# 同一工作区后续自动恢复当前会话
npm run agent
```

工具负责文本、图片、能力调用、可靠队列、交付确认、断线恢复和在线性；用户电脑仍只运行现有桌面聊天客户端，不新增第二个界面或执行程序。

当前已实现协议、持久 Hub、Cloud CLI、桌面 SDK、文本/图片、ACK/幂等、能力旁带 inbox、变更前消息闸和长命令让出/取消。完整方案与验收见 [`docs/architecture.md`](docs/architecture.md)。

配置约定：按操作者决定，`config/runtime.json` 连同真实内部密钥提交到**私有仓库**，让 Cloud clone 后首次只需传模型名。仓库一旦误设公开或密钥泄露，必须立即轮换 `internalKey` 并吊销全部恢复令牌。
