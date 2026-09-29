# 当前桌面控制入口与共享队列核验

2026-09-29。范围：只读核验已安装 Codex 的当前实例，以及 `study/codex` 对应代码；不配对、不改变认证、不重启、不创建任务、不发送或修改队列。本文补充 [Remote 与能力研究](2026-09-29-official-remote-and-capabilities.md)。

## 结论

当前可用的 follower IPC 能转发已有任务的运行、停止、压缩及审批，但未发现新建、改名、归档或通用 App Server 请求代理。官方 App Server 协议具备这些操作，不等于当前独立 Pocket 进程已可连接原桌面 App Server。

共享队列的 follower 方法存在，但它**直接替换旧版队列**，没有自动选择新版 App Server 队列，也没有返回队列快照。当前两个持久队列都为空，无法仅据此确定该 renderer 的运行时队列后端。不要把方法存在当成完整共享队列已具备。

## 当前实例与来源版本

- App `/Applications/ChatGPT.app`：`26.903.71938:8576`；嵌入 CLI 只读 `--version` 返回 `0.153.4`。
- 主 App 进程 PID 756、其 App Server PID 1516。当前命令行省略 `--listen`，使用默认 stdio。`lsof` 仅见其 stdio socketpair 等匿名 socket，没有该进程 TCP listener 或具名 Unix listener。
- `~/.codex/app-server-control/app-server-control.sock` 不存在。
- 本地源码 HEAD `1f54845a49475aea60d420a848519b969c03a132`；研究固定上游 ref `eb10d91e48ccbd0930427461fb392337addb1ac0`，本次没有 fetch、修改或构建上游。
- 本机持久认证模式仅回读为 `apikey`，没有输出认证值；`state_5.sqlite` 的 `remote_control_enrollments` 为 0 行。该证据不等于穷举 App 内存中的全部临时状态。

## 入口逐一核验

### 1. 当前桌面 follower IPC

`~/.codex/ipc/ipc.sock` 使用小端 32 位长度前缀 JSON，先 `initialize`，再 `thread-owner-discovery`，按 owner Client ID 定向发送版本化方法。现有 Pocket 的实现见 `bin/desktop-bridge.py` 和其引用的 `app_ipc.py`。

安装 bundle 的方法注册表含 start/steer/interrupt/compact/settings/edit-last-user-turn、命令/文件/权限/用户输入/MCP 审批，以及 `thread-follower-set-queued-follow-ups-state`。没有 create/name/archive 通用请求代理。`thread-archived` / `thread-unarchived` 是**事后广播**，发送它们不会完成原任务归档。

### 2. App Tools 管道

沿用 [签名边界证据](2026-09-28-peer-signing-boundary.md)：动态 App Tools 管道要求 OpenAI 固定团队、程序身份及父/祖父签名链。当前 Agent 的一等工具可以操作原任务，但不能据此把普通 Pocket Node/Python 进程当成受信客户端。没有尝试改签、替换客户端身份或放宽校验。

### 3. Unix daemon / WebSocket

开源 `codex-rs/app-server-transport/src/transport/mod.rs:54–69` 定义 `app-server-control/app-server-control.sock`。`unix_socket.rs:21–85` 接受 Unix socket 上的 WebSocket，socket mode 为 0600；`app-server-daemon/src/client.rs:65–110` 展示连接和 `initialize` / `initialized`。这是一条真实的多客户端入口，**前提是原桌面已经连接该实例**。

安装 bundle 存在 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 分支，但条件包括 local host、无 config overrides、无 CLI override、无自定义 CLI command、daemon version probe 成功。主进程当前传 `getConfigOverrides:()=>SO(e)`，而 `SO` 对 local 返回 `mcp_servers.codex_app=…` override，缺插件/管道也返回 disabled override。故正常当前桌面启动路径仍无法满足 `!overrides.length`；仅设置该环境变量并不能切换。

另有 `CODEX_APP_SERVER_WS_URL` / host `websocket_url` 客户端入口，但它是让桌面连接预先存在的服务，不能给已经运行的 stdio 进程添加 listener。修改启动配置、重启并迁移到共同 daemon 是另一个需要验证模型路由、MCP App Tools、owner 和恢复语义的迁移任务；不能作为本次无缝接入，也不能先启动第二个执行器再声称接通原实例。

### 4. 官方 Remote

`app-server/src/lib.rs:758–796` 向 Remote transport 传入与 Core 同一 `AuthManager`。`app-server-transport/src/transport/remote_control/auth.rs:33–80` 明确拒绝 API key auth，错误为 `remote control requires ChatGPT authentication; API key auth is not supported`。当前持久 `apikey` 模式及零 enrollment 没有提供可复用的已配对中继。

官方客户端配对与账号授权可以连接中继上的原 App Server；当前研究没有得到 Pocket 可直接使用的公开客户端 SDK/无配对附着接口。`codex --remote` 只接受已有 ws/wss/unix App Server endpoint，并不自动发现或接管桌面。不能在此任务中静默切换认证或模型路由来满足 Remote 前置条件。

## 共享队列：两个后端，不能混写

### 旧版桌面队列

- 数据源：`~/.codex/.codex-global-state.json` 的 `queued-follow-ups`，结构为 `{ [conversationId]: QueuedMessage[] }`。本次只读该字段为空对象；不修改源文件。
- 写入口：`thread-follower-set-queued-follow-ups-state` v1，参数 `{conversationId, state:{[conversationId]: messages}}`。owner 调用 `turnCoordinator.acceptFromFollower(conversationId, state[conversationId] ?? [])`。
- `acceptFromFollower` 直接调用 `#d(e, ()=>incomingMessages, true)`。内部串行写、重新读取 global state、检查仍为 owner，但 transform 固定返回收到的数组；**会覆盖同任务期间的其他编辑**。它不含 revision / expected hash / item mutation，也不先调用后端选择函数 `#l`。
- 变更广播：`thread-queued-followups-changed` v1，内容 `{conversationId,messages}`；接收端校验广播来自当前 owner。它是变更事件，不是可请求的初始化快照。
- renderer 的 `queuedMessages` 字段 reader 现场调用 `turnCoordinator.readMessages`。2026-09-29 实际只读订阅本 Pocket 原任务的 v11 `conversationState` snapshot，顶层字段及嵌套数据均无 queue 字段。不能从已有历史 snapshot 取得统一队列。

最小**纯文本**旧版条目可按当前原生构造写为：

```json
{
  "id": "stable-client-message-id",
  "text": "用户正文",
  "context": {
    "prompt": "用户正文",
    "addedFiles": [],
    "fileAttachments": [],
    "ideContext": null,
    "imageAttachments": [],
    "workspaceRoots": ["原任务 cwd"]
  },
  "cwd": "原任务 cwd",
  "createdAt": 0
}
```

`createdAt` 为真实提交毫秒时间。此处是纯文本最小构造，**不是全部可存在字段的封闭 schema**：原生条目还可含附件、评论、工具/应用上下文、metadata 等；读取旧条目时需完整保留未知字段。编辑正文须同时修改 `text` 与 `context.prompt`，保留 ID、创建时间和非正文 context。`pausedReason` 为非空字符串时旧版自动出队会暂停；停止会使现存条目加上 `Interrupted before the steer was accepted.`。

旧版自动发送要求 owner、任务就绪、没有运行轮、没有暂停原因，并由桌面 coordinator 执行。Pocket 如果把项目交给原生队列，应停止自己对此条目的自动发送，不能同时驱动两套执行循环。

**直接发送还有独立锁：**原生 `sendQueuedMessageNow` 先选择后端；旧版进入 coordinator `#s`，使用 `queued-follow-up-send-lock-acquire`，准备并调用 start/steer，确认 sent 后删除，最后 `queued-follow-up-send-lock-release({sent})`。这些主进程锁不是 follower 注册方法。仅做“Pocket Steer + 删除旧版条目”与桌面自动出队存在竞态；先读摘要、写后回读能降低/发现部分冲突，不能替代原生发送锁，也无法恢复已经被覆盖的另端内容。

### 新版 App Server 队列

renderer 的 `vBn` 以 Statsig gate `2120612410` 且 Core 版本至少 `0.148.0-alpha.14` 为开关。coordinator `#l` 只在该功能启用且旧版该任务队列为空时选择 server queue；因此后端还会受旧版存量条目影响。

- API：`thread/queue/add/list/update/delete/reorder/start`，初始化必须 `capabilities.experimentalApi=true`。
- `QueuedSubmission` 的完整当前字段是 `{id,input,clientUserMessageId}`；input 为 `UserInput[]`。更新以 `queuedSubmissionId` 为单位，保留 ID 与次序；删除返回 `deleted`；reorder 须传完整队列 ID 排列。
- `thread/queue/changed` 只通知 thread ID；客户端用 list 分页回读。底层队列库有 durable revision，但 App Server 当前请求/响应不提供 expectedRevision/CAS。
- 持久源：`~/.codex/queue_1.sqlite`。本次只读 `queued_items=0`、`queued_thread_revisions=88`；说明存在历史使用痕迹，**不能证明当前 renderer gate 值**。Statsig 状态文件仅有 stable id，没有可用于此判断的 gate 值。
- 正常完成/失败会接着发送下一条；中断后暂停，resume 不自动解除；`thread/queue/start` 仅可在空闲时选择队首或指定条目，Core 接受后移除。运行中“直接发送”由原客户端额外协调 Steer，不能把 queue/start 当成运行中 Steer。
- 旧版 follower `set-queued-follow-ups-state` 不会转译成这些 API。向旧版队列注入条目可能使 coordinator 优先选旧版，遮住已有 server queue；不能把它当作统一后端适配器。

官方 CLI 确有 `codex queue`，但 `tui/src/session_queue_commands.rs:28–66` 通过 session-command App Server 连接发 `thread/queue/add`；无已存在 daemon 时可能使用 embedded app-server，因而不是当前 stdio 桌面的旁路安全入口。本次仅查看 `queue --help`，没有执行入队。

## 可验证的下一步

1. 新建、改名、归档继续等待/验证能连接**同一原实例**的 API 入口；不能用广播、SQLite 更新或 Pocket 别名替代。现有一等 App Tools 可用于受控原任务验收，但不是已交付的后台 HTTP 接口。
2. 共享队列先补一个只读能力探测，清楚区分当前后端与“未知”。仅原文件为空或 Core 版本足够，不足以证明后端。需要可信的 owner 队列读入口，或同一 App Server 的 list 连接。
3. 若限定实现旧版共享队列，必须明确这个能力范围，并验证完整读取、原 owner 写入、另端编辑冲突、发送锁、后台自动出队、直接发送与断线未知回执；不要一边残留 server queue 一边强行写入旧版。摘要校验是 Pocket 的检测，不能称为原 owner 的原子 CAS。
4. 最合适的底层接口是原 owner 提供统一 read/add/update/delete/send-now（含 stable request ID / revision），内部复用 coordinator 与发送锁；或先完成共享 App Server 的受支持部署再使用实验性 queue API。当前发布包未发现该完整 follower 面。

## 证据定位

源码固定 ref 的前缀：`https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/`。

- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:872–974`：队列协议字段。
- `codex-rs/app-server/README.md:886–907`：队列事件、自动执行、暂停语义。
- `codex-rs/thread-store/src/queue_store.rs:14–62`：底层 revision 与按项修改。
- `codex-rs/tui/src/session_queue_commands.rs:28–66`：CLI queue 连接与 embedded 边界。
- `codex-rs/app-server-transport/src/transport/remote_control/auth.rs:33–80`：Remote 认证要求。
- `codex-rs/app-server-daemon/src/client.rs:65–110`、`app-server-transport/src/transport/unix_socket.rs:21–85`：Unix WebSocket 客户端与接入。

安装包文件是 minified JS；以下为 UTF-8 解码后字符 offset，避免伪造行号。定位用字符串也可复查：

| app.asar entry | SHA-256 | 关键定位 |
|---|---|---|
| `.vite/build/main-Bkkz0ENj.js` | `037076973c753515ef4329aa493f1072902cc638cbbcec788d81c87f392342f2` | `SO` 1151969，`getConfigOverrides:()=>SO` 2644462 |
| `.vite/build/src-B6LqG3ek.js` | `9a1d9737c526cbba0e18e5ffc3b9371ef055318e7eabb7584b082fbcdb24472e` | daemon 条件 893767，版本 probe 894264，follower 注册表 349401 |
| `webview/assets/app-initial-a9514281e192.js` | `038d28242240bb19fd90c7a380d80c6d23caaebc77a3ebb87ff6045bc49762c6` | `acceptFromFollower` 2988767，存储适配 `Dfn` 2990823，后端 `vBn` 3522173，字段 reader 2652934，`async#t` 2979549 |

本次未修改应用、配置、认证、队列或源数据库。当前在线运行和特定设备上的真实执行行为仍以受控操作回读为准。
