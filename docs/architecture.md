# Agent Transport 架构方案

## 1. 定位

Agent Transport 是一套中性的聊天与能力传输工具，连接云端 AI、传输 Hub 与现有桌面聊天客户端。

它只描述：

- 文本、图片和附件如何可靠到达；
- 云端 AI 如何等待、回复和恢复；
- 现有桌面客户端如何执行用户已授权的文件与命令能力；
- 用户新消息如何随每一次能力调用尽快送到 AI。

项目文案、代码命名、日志和协议字段均不得出现任何交易、计费或资源分配业务术语。

## 2. 目标体验

云端首次启动：

```bash
git clone <repository-url> agent-transport
cd agent-transport
npm ci
npm run agent -- --model <exact-original-model-name>
```

同一工作区后续启动：

```bash
npm run agent
```

要求：

1. 首次只由 AI 显式传入一次 exact 模型名。
2. Hub 地址、内部密钥和本地状态目录来自配置文件，不要求 AI 在聊天中传递。
3. 首次登记成功后，Cloud CLI 保存 `conversationId`、恢复令牌、消息 cursor 和模型名；后续自动恢复。
4. `npm run agent` 在前台等待最长约 9 分 30 秒；收到消息立即返回，空闲到期返回结构化 `idle`。
5. AI 处理消息或完成一步能力调用后，再次执行 `npm run agent` 或下一条能力命令。
6. 用户电脑继续只运行现有桌面聊天客户端，不新增第二个界面或独立执行程序。

## 3. 明确边界

### 3.1 能解决

- MCP 单次约 55 秒等待造成的频繁轮换和空档；
- 等待调用中止、重连后 cursor 丢失；
- 文本和图片缺少统一 delivery / ACK；
- AI 不在 wait 状态时，新消息只能等到下一次显式收信；
- 读、写、搜索、命令等能力结果与消息队列彼此割裂；
- 传输在线与 AI 真正可响应混为一谈。

### 3.2 不能解决

- AI 正在模型推理时强制抢占推理；
- 一个完全不可中断的第三方工具调用正在运行时强行插入自然语言；
- 云端运行环境被平台直接销毁；
- 操作系统或网络断开期间提供实时交互。

本方案采用“能力边界插入”：每次能力执行前后检查 inbox；长命令切成可恢复的输出片段。它显著缩短延迟，但不冒充真正的模型抢占。

## 4. 仓库结构

```text
agent-transport/
  apps/
    hub/                  # HTTP/WS 服务、队列、路由、图片对象与在线性
    cloud-cli/            # 云端 AI 使用的命令行入口
  packages/
    protocol/             # schema、错误码、签名、cursor、envelope
    client-sdk/           # 接入现有桌面客户端 daemon
    policy/               # 路径、命令、确认、大小、输出限制
    testkit/              # 假 Hub、假桌面端、断网与重放场景
  config/
    runtime.example.json  # 无密钥模板
    runtime.json          # 私有仓库正式配置，含 workspaceId 与内部密钥
  docs/
    architecture.md
  package.json
```

技术基线推荐 Node.js 22 + TypeScript。Cloud CLI 与 Hub 共享同一套协议类型；桌面客户端通过 `client-sdk` 接入，不复制 schema。

## 5. 组件职责

### 5.1 Hub

- 会话登记、恢复、冲突检测；
- 每会话有序消息队列；
- 文本、图片元数据、能力请求与结果路由；
- delivery 可见性截止时间、重投与 ACK；
- 回复幂等；
- 图片临时对象存储与过期清理；
- transport / listening / working / stalled / offline 分层在线性；
- 审计事件与端到端延迟指标。

Hub 不读取用户项目文件。文件与命令结果只在当前会话、当前 capability request 范围内转发。

### 5.2 Cloud CLI

- 读取私有仓库内的 `config/runtime.json`；
- 首次登记 exact 模型名；
- 保存和恢复当前会话状态；
- 在前台执行长等待；
- 下载并校验图片；
- 提供聊天、文件、命令、计划、任务等命令；
- 把所有能力返回统一包装，并附带 inbox；
- 断线、中止或认证过期时给出机器可读的下一步。

### 5.3 现有桌面客户端 + client-sdk

现有桌面客户端继续负责：

- 用户登录与界面；
- 本机可访问目录授权；
- 文件读取、写入、精确替换、目录枚举和搜索；
- 命令策略、危险操作确认；
- 长命令进程、输出片段和取消；
- 本地图片与附件选择；
- 与 Hub 的持久连接。

`client-sdk` 只替换其内部传输适配层，不改变用户界面，不启动第二个本机程序。

## 6. 配置与首次登记

建议配置：

```json
{
  "hubUrl": "http://test.cxrry.com:47320/agent-transport",
  "workspaceId": "ws_example",
  "internalKey": "replace-in-private-repository",
  "stateDir": "~/.agent-transport",
  "idleReturnMs": 570000,
  "httpPollMs": 30000,
  "maxInboxPerResult": 10,
  "maxImageBytes": 8388608
}
```

规则：

- 按操作者决定，`runtime.json` 与真实内部密钥提交到私有仓库，Cloud clone 后无需额外注入；仓库必须保持私有，泄露时立即轮换密钥并吊销恢复令牌。
- 内部密钥只用于换取短期会话令牌；Hub 返回的恢复令牌按会话保存并可吊销。
- 模型名不是身份凭证，只用于展示、路由能力与兼容判断。
- 首次命令带 `--model`；若已有有效状态又传不同模型，CLI 返回 `model_conflict`，不得静默覆盖。
- 状态丢失、令牌吊销或 Hub 返回 `registration_required` 时，才要求再次传模型名。
- 任何令牌不得写 stdout、命令行历史或普通日志。

### 6.1 “克隆后只传模型名”的前提

本项目采用私有仓库内置 `runtime.json`：Hub 地址、workspaceId 与内部密钥随 clone 到达，AI首次只显式传 exact 模型名。内部密钥仍是真正凭证，模型名只用于能力与展示。

该便利性换来明确风险：私有仓库成员、Git 凭据或历史泄露会同时泄露 Hub 凭证。因此协议必须从第一版支持 `keyId`、密钥轮换、短期恢复令牌和全会话吊销；不得把内部密钥打印到 stdout、日志或命令行。

## 7. Cloud CLI 命令

用户面对的主入口只有：

```bash
npm run agent -- --model <name>  # 首次
npm run agent                   # 后续等待
```

能力入口统一走一个 CLI：

```bash
npm run cli -- chat reply --delivery <id> --file response.json
npm run cli -- fs read --path <path> --offset 1 --limit 400
npm run cli -- fs list --path <path>
npm run cli -- fs grep --path <path> --pattern <regex>
npm run cli -- fs write --path <path> --file content.txt
npm run cli -- fs edit --path <path> --edits edits.json
npm run cli -- process exec --command-file command.json
npm run cli -- process resume --op <opId>
npm run cli -- process cancel --op <opId>
npm run cli -- plan submit --file plan.json
npm run cli -- plan update --file update.json
npm run cli -- task dispatch --file task.json
npm run cli -- task wait --file wait.json
npm run cli -- doctor
npm run cli -- stop
```

正文与命令优先从文件或 stdin 读取，避免长文本和密钥进入进程参数。

## 8. 统一返回 Envelope

每个命令 stdout 最终只输出一个 JSON 对象；进度与诊断写 stderr 或文件。

```json
{
  "version": 1,
  "requestId": "req_...",
  "conversationId": "cv_...",
  "kind": "capability_result",
  "result": {
    "ok": true,
    "value": {}
  },
  "inbox": [
    {
      "sequence": 42,
      "deliveryId": "dly_...",
      "text": "用户消息",
      "images": [
        {
          "id": "img_...",
          "mime": "image/png",
          "bytes": 12345,
          "sha256": "...",
          "localPath": "~/.agent-transport/sessions/cv_.../inbox/img_....png"
        }
      ]
    }
  ],
  "cursor": "cur_...",
  "presence": "working"
}
```

错误也保持同一外壳：

```json
{
  "kind": "capability_result",
  "result": {
    "ok": false,
    "code": "path_denied",
    "message": "目标不在已授权目录"
  },
  "inbox": [],
  "cursor": "cur_..."
}
```

不得把用户消息拼进文件正文、命令输出或错误字符串；必须放在独立 `inbox` 字段，防止解析混淆。

## 9. 消息旁带策略

### 9.1 只读能力

`read / list / grep / status / context`：

1. 领取调用开始前已排队的消息快照；
2. 执行只读能力；
3. 再领取执行期间新增消息；
4. 返回能力结果和按 sequence 排序的 inbox。

只读能力不会因为已有消息而跳过，避免用户消息导致诊断结果丢失。

### 9.2 变更能力

`write / edit / exec / dispatch / cancel / submit`：

1. 执行前先查 inbox；
2. 如果存在尚未交给 AI 的真实消息，不执行变更，返回 `message_pending` 和 inbox；
3. AI 处理消息后，若仍要继续原操作，使用新的 requestId 重新发起；
4. 执行完成后再查一次 inbox，并旁带执行期间新增消息。

这样用户改口、停止或缩小范围时，不会在消息已到达的情况下继续做旧变更。

### 9.3 长命令

桌面客户端持有真实进程和 `opId`。Cloud CLI 不把一次远端命令阻塞到结束：

- Hub 每 2～5 秒返回一次进程状态和新增输出；
- 无消息且命令未结束时，Cloud CLI 在同一前台命令内部继续；
- 有消息时，Cloud CLI立即返回 `process_yielded`、`opId`、输出片段和 inbox；
- AI处理消息后选择 resume / cancel；
- 进程默认继续运行，危险命令可由策略设为“消息到达即暂停或取消”。

单次输出有行数和字节上限，完整输出写用户电脑的临时文件，只按授权请求读取。

## 10. 等待机制

`npm run agent` 的进程可前台存在约 9 分 30 秒，但内部网络请求保持短周期：

1. 向 Hub 发 30 秒长轮询；
2. 无消息则发送 listening 心跳并继续下一轮；
3. 有消息则下载图片、写当前会话 inbox，输出 `delivery` 并退出；
4. 外层达到 `idleReturnMs` 时输出 `idle` 并退出；
5. 网络瞬断做带抖动退避，状态写盘；
6. 收到 `stop / conflict / auth_expired` 立即结构化退出，不无限重试。

推荐返回：

```json
{ "kind": "delivery", "deliveryId": "dly_...", "text": "...", "images": [] }
{ "kind": "idle", "waitedMs": 570000, "cursor": "cur_..." }
{ "kind": "conflict", "reason": "another_waiter" }
{ "kind": "auth_expired", "action": "register_again" }
{ "kind": "stop", "reason": "conversation_closed" }
```

Hub 必须保证同一 conversation 同时只有一个前台 waiter；第二个返回 `conflict`，不得竞争领取消息。

## 11. delivery、ACK 与回复幂等

- 每条用户消息拥有单调 `sequence` 和唯一 `deliveryId`；
- 被领取后进入不可见期，未 ACK 到期会重投；
- AI回复使用 `deliveryId + responseId`；
- Hub 在一个事务中写入回复并 ACK delivery；
- 相同 `responseId` 重放返回原结果，不重复发送；
- 纯 ACK 仅用于明确不需要回复的系统事件，真实用户消息默认必须通过回复完成 ACK；
- cursor 只代表“已看见到哪里”，不能替代 ACK；
- 图片下载失败不 ACK，返回可重试错误。

交付语义为至少一次；通过 deliveryId / responseId 幂等实现对用户观察上的一次。

## 12. 图片与附件

### 12.1 上传

桌面客户端上传前记录：

- MIME；
- 字节数；
- SHA-256；
- 原始文件名的安全显示名；
- 当前 conversation 与 message 绑定。

Hub 返回一次性对象 ID，不在消息 JSON 内嵌大块 base64。

### 12.2 云端下载

Cloud CLI：

1. 校验消息授权与一次性 URL；
2. 限制 MIME、单文件大小、文件数量和总大小；
3. 下载到当前会话独立目录；
4. 校验字节数和 SHA-256；
5. 使用随机文件名，不信任原始路径；
6. 只在 envelope 返回 `localPath`；
7. ACK 或过期后按策略清理。

首期只支持 png / jpeg / webp / gif；其它附件保留元数据但不自动打开。

## 13. 能力清单与现有 MCP 映射

### 13.1 会话与聊天

- context.get
- model.register
- chat.wait
- chat.reply
- chat.ack
- chat.stop
- activity.note

### 13.2 用户电脑能力

- fs.read
- fs.list
- fs.grep
- fs.write
- fs.edit
- process.exec
- process.resume
- process.cancel

这些能力由现有桌面客户端执行，并继续沿用其目录授权与危险命令确认。

### 13.3 路线图

- plan.submit
- plan.update
- plan.get

### 13.4 任务协作

- task.listAvailable
- task.dispatch
- task.wait
- task.progress
- task.result
- task.ask
- task.answer
- task.message
- task.cancel

所有能力都必须返回统一 envelope 和 inbox；不能有“某些命令收不到消息”的旁路实现。

## 14. 安全策略

### 14.1 用户电脑

- realpath 后必须位于授权根目录；
- 符号链接、junction、UNC 与设备路径单独校验；
- 写入使用临时文件 + 同目录原子替换；
- edit 必须精确匹配，批量编辑全成或全败；
- 命令按可配置 allow / deny 策略；
- 危险操作必须有用户确认票据；
- 每条 capability request 绑定 conversation、requestId 与过期时间；
- 结果限制字节数，超限落临时文件并返回摘要。

### 14.2 Hub

- TLS；
- 内部密钥只用于 bootstrap，短期令牌细分 cloud / desktop 角色；
- 令牌绑定 conversation 与设备；
- 防重放 nonce / requestId；
- 消息、图片和结果设置保留期；
- 日志自动脱敏；
- 管理操作单独审计；
- 不允许通过参数切换到别人的 conversation。

### 14.3 Cloud CLI

- state 目录当前用户专有；
- 不读取其它 session；
- stdout 只输出协议 JSON；
- token 不进入 argv；
- 中止后只恢复当前 request / waiter；
- state 绑定 workspace，复制工作区不能自动继承有效会话。

## 15. 在线性

必须分别记录：

- `transportConnected`：网络连接是否存在；
- `desktopReady`：桌面客户端能力端是否可用；
- `agentListening`：Cloud CLI 是否正在前台等待；
- `agentWorking`：最近是否有能力调用；
- `agentStalled`：超过阈值没有 wait、能力调用或心跳；
- `conversationClosed`：会话是否终止。

聊天页显示“在线”至少要求 desktopReady，若需要立即交互还应要求 agentListening 或 agentWorking 最近活跃。长连接存在不能单独算 AI 可响应。

## 16. Hub 数据模型

首期可用 SQLite WAL + 本地对象目录完成单机验证，存储接口必须可替换。核心表：

- conversations
- participants
- messages
- deliveries
- responses
- capability_requests
- capability_results
- process_operations
- attachments
- presence_events
- audit_events

要求：

- sequence 在 conversation 内单调；
- deliveryId / responseId / requestId 唯一；
- ACK 与回复同事务；
- 能力变更请求具备幂等键；
- 图片文件与数据库引用一致清理；
- Hub 重启后 waiter、cursor、未 ACK delivery 和运行中 op 仍可恢复或明确失败。

生产多实例阶段再换共享 SQL 与对象存储，协议不变。

## 17. 可观测性

至少记录：

- userCreatedAt → hubQueuedAt；
- hubQueuedAt → deliveredAt；
- deliveredAt → acknowledgedAt；
- responseCreatedAt → userReceivedAt；
- 每能力排队、执行、返回耗时；
- inbox 旁带数量；
- wait 中止、冲突、重投、重复回复；
- 图片上传、下载、校验失败；
- transport / desktop / agent 三层在线变化。

管理面必须能区分：消息没进 Hub、已排队、AI未领取、AI已领取未回复、回复已发送。

## 18. 失败与恢复矩阵

| 场景 | 行为 |
| --- | --- |
| Cloud CLI 等待中断 | 保留 cursor；重启后重领未 ACK delivery |
| 同一会话启动两个 waiter | 后启动者返回 conflict，不领取消息 |
| Hub 重启 | SQL 恢复队列；客户端重连；未 ACK 消息重投 |
| 桌面客户端离线 | capability request 保留有限时间；聊天消息仍入队 |
| 图片下载中断 | 不 ACK；删除 partial；下次重试 |
| 回复提交后网络断开 | responseId 重放返回原结果 |
| 写入提交后网络断开 | requestId 查询原结果，不重复写 |
| 长命令连接中断 | opId 保留；恢复时查询状态和缺失输出 |
| 用户消息在变更前到达 | 返回 message_pending，不执行变更 |
| 用户消息在变更后到达 | 结果与 inbox 同时返回 |
| 令牌过期 | 返回 auth_expired，不静默注册新会话 |
| 会话关闭 | 返回 stop；拒绝后续能力请求 |

## 19. 实施阶段

### 阶段 A：协议与单机 Hub

- protocol schemas 与错误码；
- SQLite 队列；
- 文本 wait / reply / ACK；
- 首次模型登记与后续恢复；
- 9 分 30 秒 Cloud CLI 等待。

验收：连续中止、Hub 重启和回复重放均不丢消息、不重复回复。

### 阶段 B：图片

- 桌面上传；
- Hub 对象；
- Cloud 下载校验；
- 回复图片。

验收：大小、MIME、哈希错误全部拒绝；未 ACK 可重试。

### 阶段 C：现有桌面能力

- client-sdk 接入现有 daemon；
- read / list / grep / write / edit；
- message_pending 前置闸；
- 每能力结果旁带 inbox。

验收：用户在 AI 连续读写间发消息，最迟在下一能力结果里出现；消息到达后的旧写入不会执行。

### 阶段 D：长命令

- process opId；
- 输出片段；
- resume / cancel；
- 消息到达提前 yield。

验收：10 分钟命令期间发消息，Cloud CLI 在配置片段周期内返回 delivery，命令状态可继续查询。

### 阶段 E：路线图与任务协作

- plan / task 全能力；
- 统一 envelope；
- 活动与审计。

验收：所有方法都经过同一 inbox middleware，无旁路。

### 阶段 F：生产化

- 共享 SQL / 对象存储适配；
- TLS、令牌轮换、限流、指标与告警；
- 现有桌面客户端灰度切换；
- 旧 MCP 通道作为回退，稳定后移除。

## 20. 测试与验收

必须自动化覆盖：

1. 消息在 wait 前、wait 中、wait 边界到达；
2. 每一种能力执行前、执行中、执行后到达消息；
3. 变更前 message_pending 阻断；
4. 长命令 yield / resume / cancel；
5. delivery 重投与回复幂等；
6. 两 waiter 冲突；
7. Hub / Cloud CLI / 桌面客户端分别重启；
8. 图片 partial、错哈希、超限与过期；
9. 路径逃逸、符号链接与危险命令确认；
10. state 被复制到另一 workspace；
11. 模型名变化与恢复令牌过期；
12. stdout 始终只有一份可解析 JSON。

现场验收指标：

- idle waiter 存在时，文本 P95 领取延迟小于 2 秒；
- AI不在 wait 时，消息最迟在下一能力结果出现；
- 长命令运行时，消息 P95 领取延迟小于命令输出片段周期 + 2 秒；
- 断网与进程重启不丢文本和图片；
- 重试不重复回复、不重复写入；
- 桌面客户端之外没有第二个用户侧程序。

## 21. 兼容与迁移

- 新协议与旧 MCP 通道并存一段灰度期；
- 桌面客户端增加 transport 模式开关；
- 新 Cloud CLI 首选新 Hub，失败时不得自动切到另一 conversation；
- 协议使用版本字段与能力协商；
- 旧消息不迁移，灰度会话从新 sequence 0 开始；
- 灰度确认文本、图片、全部能力与恢复均稳定后，再移除旧通道。

## 22. 当前拍板

- 项目是独立、中性的聊天工具；
- 目录为 `E:\my\MCP\agent-transport`；
- 用户电脑复用现有桌面聊天客户端；
- 云端首次只显式传一次 exact 模型名，后续自动恢复；
- 前台等待目标约 10 分钟，内部使用短网络轮询；
- 所有能力结果都通过统一 middleware 旁带 inbox；
- 变更能力在执行前遇到新消息必须先让 AI处理；
- 私有仓库提交 `config/runtime.json`，内含 `workspaceId + internalKey`，Cloud首次只再传模型名；
- Hub 独立监听 `0.0.0.0:47420`；现场公网未转发 47420，因此 Cloud 通过现有 47320 的 `/agent-transport` 透明代理访问；
- 现有桌面客户端增加 transport 模式开关，旧通道保留回退，同一聊天只允许一个通道领取；
- 第一阶段直接实现可靠文本、图片、ACK、恢复、桌面全部能力，再接路线图与任务协作。

## 23. AI 使用规则如何随 clone 生效

只提供 CLI 不够：AI必须知道什么时候重跑等待、如何解析 envelope、看到 inbox 后先做什么。实现阶段仓库应自带 `.cursor/rules/agent-transport.mdc`，内容只描述协议行为，不含任何密钥或业务文案。

规则至少要求：

1. 首次执行 `npm run agent -- --model <exact-name>`；登记成功后不再重复传模型名。
2. 每次命令只解析 stdout 的最终 JSON；stderr 仅作诊断。
3. envelope 带 inbox 时先读所有图片和文本；变更未执行则根据用户最新要求决定是否重发。
4. 处理 delivery 后使用同一个 deliveryId 回复；回复成功即 ACK。
5. `idle` 不是结束，在当前目标仍要求等待时重新执行 `npm run agent`。
6. `conflict / auth_expired / stop` 不盲目重试，按结构化 action 处理。
7. Command aborted 只恢复当前 state 与 request，不创建第二个 conversation。
8. 任何能力都必须通过 CLI，不能绕过 message-aware middleware 调另一套执行路径。

`npm run agent` 首次成功时还应输出一份很短的 `ready` envelope，明确 state 文件、conversationId 和下一条命令；不能输出一大段自然语言让模型猜。

## 24. 实施前仍需完善和拍板

### 24.1 配置文件如何出现在全新 Cloud VM（已拍板）

使用私有仓库提交的 `config/runtime.json`，clone 后直接可读。实施必须增加私有仓库泄露告警、keyId、双钥轮换和全令牌吊销；不得因配置随仓库到达而省略短期令牌。

### 24.2 “后续不传模型名”的范围

推荐定义为“同一 stateDir 且恢复令牌有效”。全新 VM、删除 state、令牌吊销或 workspace 绑定变化时必须重新登记模型；不能让一个状态文件跨机器永久通用。

### 24.3 仓库可见性与 clone 认证（已拍板）

仓库必须是私有仓库，真实内部密钥随仓库提交。Cloud VM仍需预先具备该私有仓库的只读 Git 凭据；这是启动前置，不属于 `npm run agent` 的参数。

### 24.4 Hub 部署地址（首期已拍板）

Hub 监听 `0.0.0.0:47420`。现场路由没有直接开放公网 47420，首期由现有公网 47320 将 `/agent-transport/*` 流式代理到本机 47420，Cloud 地址为 `http://test.cxrry.com:47320/agent-transport`；该地址已从独立 Cloud VM 验证。外层 9 分 30 秒进程不依赖单条长 HTTP，代理上游 timeout 为 40 秒，覆盖 30 秒内部轮询。真实使用前必须迁移 HTTPS。

### 24.5 断网时变更能力是否执行

推荐 fail closed：变更能力在执行前无法确认 inbox 时不执行，返回 `inbox_unavailable`。否则用户已经发了“停止”，网络断开却继续写文件，消息前置闸就失去意义。只读能力可以在结果里标记 `inboxStale=true` 后继续。

### 24.6 长命令遇消息后的默认动作

推荐普通命令继续运行并返回 opId；命中危险级别的命令则暂停或取消。需要为命令策略增加 `onMessage: continue | pause | cancel`，不能全局写死。

### 24.7 多条消息的优先级

同一能力返回最多旁带 10 条，严格按 sequence；出现“停止 / 改方向”不在传输层做自然语言猜测，由 AI按顺序处理。传输层只保证不漏、不乱序、不跨 conversation。

### 24.8 能力发现

脱离 MCP 后没有工具 schema 自动展示。`protocol` 必须生成：

- CLI `--help`；
- JSON Schema；
- `.cursor/rules/agent-transport.mdc`；
- 机器可读 `npm run cli -- capabilities`。

四者从同一 capability registry 生成，避免文档与实现漂移。

### 24.9 现有桌面客户端灰度

需要在现有客户端增加 transport 模式开关与协议版本协商。新通道稳定前保留旧通道，但同一 conversation 只能由一个通道领取消息，防止双投和双写。

### 24.10 Hub 首期存储

SQLite 适合单机证明协议，不适合多实例共享。需明确首期目标：若直接接真实用户，建议一开始使用现有 SQL 服务和独立图片目录；若只做隔离验证，可先 SQLite WAL，再通过 repository 接口迁移。

### 24.11 Cloud Shell 前台时限

必须在目标 Cloud 环境现场确认单次 Shell 调用能稳定前台等待 9 分 30 秒，并验证中止后是否仍遗留后台进程。若产品层会自动转后台，CLI需用单实例锁和 `wait.pid`，下一次先接管或返回 conflict，不能再起一个 waiter。

### 24.12 密钥轮换

即使内部密钥写本地配置，也必须支持 keyId、双钥过渡、吊销和短期会话令牌。共享内部密钥泄露时只靠换仓库文件无法立即踢掉已登记会话。

24.1、24.3、24.4 已拍板。剩余条目作为实现验收项，不阻塞开始编码。
