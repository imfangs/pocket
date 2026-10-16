# 归档能否跨过桌面占用

2026-10-16。用户指出：如果已结束会话长期不能归档，Pocket 的归档在实际使用中就走不通。本次继续检查可实施的接入方式；不重试已取消的真实请求、不改真实 Codex 数据或重启桌面。

## 判断与适用范围

当前独立 CLI 路线确实不能满足“在手机上归档常用的已结束会话”。等待 writer 自行释放不是可靠的交互闭环。这个问题需要改变归档请求到达的位置，不能继续只调整等待文案。

同一 Core 的 `thread/archive` 能释放自己持有的目标和子会话，再完成真正归档；10-15 的隔离协议实验已证明这一点。新的候选是在下一次启动 Codex 时加入一层透明 stdio 适配器，将 Pocket 的归档请求送到该桌面的同一 Core。它不是热接入当前进程，也不是另开 Core 接管原会话。

**结果：薄适配器的隔离原型 26 项检查通过，已经证明可以从侧通道归档同一 Core 持有的会话和整个子树。** 真实 GUI、App Tools、既有发送/已读同步和工作树行为尚未验收。技术路线可行不等于已经交付手机能力；本次部署和现有归档行为保持不变。

## 为什么换 CLI 或跳过子会话都不行

本机 CLI `0.162.0-alpha.17.2`、稳定版 `0.163.0` 和核查时 main 的归档存储实现一致：先取得整个 spawned 子树的 writer，再移动原会话及子会话。任何一个节点由另一 Core 持有，整次请求在移动前失败。

官方文档说子会话归档可能部分成功，指的是全树锁已经取得后的文件移动失败，不代表可以跳过持锁子会话。公开参数只有 `threadId`，没有强制、root-only 或跳锁参数。

- [官方归档文档](https://learn.chatgpt.com/docs/app-server#archive-a-thread)
- [0.163.0 全树先取锁与随后移动](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/thread-store/src/local/archive_thread.rs#L24)
- [归档协议测试](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/tests/suite/v2/thread_archive.rs#L538)
- 本地原始对照：`.local/qa/archive-owner-2026-10-15/proof.json`、`subtree-proof.json`；包含零模型轮次、全树状态及清理回读。

## 接入方式的取舍

| 方式 | 当前证据 | 取舍 |
| --- | --- | --- |
| 当前独立 CLI／短 RPC | 受原 Core 的 writer 阻止 | 保留无占用场景；不能据此承诺常规即时归档 |
| App Tools 原生操作 | 能经原桌面 manager 执行，并处理桌面附属状态 | 当前独立 Pocket 没有已核验的宿主入口；不伪造身份或绕过签名 |
| 直接共享 WebSocket Core | 桌面有 `CODEX_APP_SERVER_WS_URL` 启动分支 | 会关闭目前 Pocket 依赖的本地 owner IPC 协调，并绕过 stdio 启动时的部分配置注入；不是只补归档的小改动 |
| 本地 daemon／官方 proxy | 官方支持本地 socket 与字节代理 | 无法给当前 stdio Core 补 listener；proxy 也不是 JSONL 到 WebSocket 的协议转换器 |
| 下一次启动时的 stdio 薄适配器 | 桌面识别 `CODEX_CLI_PATH`，ClawKit 有同类启动机制 | 优先验证；保留原桌面 stdio 初始化，仅增加受限本机归档入口 |

当前桌面 `26.1007.71326:20398` 的 WS 分支会令 `localClientCoordinationEnabled` 为 false，现有 desktop IPC 注册也随之关闭。普通 local WS 分支没有 durable 分支的握手鉴权配置；不能把支持 WS 等同于已支持所需认证或所有桌面工具。

`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 还有启动条件：不存在配置 overrides、没有 bundled `Resources/git/bin/git`。本机后一条件满足，但桌面正常注入 App Tools、code-review 等 overrides，不能直接认为只设一个变量就可用。这些是当前安装包观察，不是官方承诺长期稳定的扩展契约。

本轮首次用官方 `app-server proxy --sock` 承接 JSONL 初始化超时。已由协议源码确认，proxy 原样转发 WebSocket HTTP Upgrade 和帧，不负责转换；这次失败不能作为共享 Core 不可行的证据。临时进程和目录已清理，错误及清理回读保留在 `.local/qa/archive-shared-2026-10-16/proof.json`。

## 隔离原型的实际结果

入口：`.local/qa/archive-stdio-adapter-2026-10-16/adapter.py`、`probe.py`；最终结果 `proof.json`，逐帧 hash 和路由在 `adapter-trace.jsonl`。实际使用当前 App 内置官方 CLI，以 Python 进程模拟桌面 stdio 客户端；不是运行真实 GUI。

- 官方 CLI 创建 5 个空测试会话；在临时数据库中仅构造测试用父子关联，不触碰真实 Codex 数据。目标、邻居和一个子会话由同一个 Core 加载，父会话保持未加载。
- 从额外 Unix 客户端归档已持锁目标成功；再归档未加载父会话及其两个子会话成功，包含仍由同 Core 持锁的子会话。源归档状态为真，writer 释放，原 rollout 内容 hash 不变。
- 无关邻居在两次归档后均仍加载、可读取，归档状态、writer 和内容 hash 保持原样。
- 操作系统回读确认实际运行的是官方 Core，PID 和模拟桌面父 PID 保留；额外 helper 不在 Core 的祖先链。给定 argv/env 的完整 hash 一致，原桌面输入与转发输出逐帧一致。
- 桌面与侧客户端即使使用同一请求 ID，也不会串响应；半帧输入正确转发。真实 `thread/archived` 通知完整送到模拟桌面，侧通道私有响应不会泄漏给它。
- 侧通道拒绝执行方法；客户端发完只读请求立刻断开，Core 和邻居继续可用。模型端点收到 0 请求，所有测试会话保持 0 tokens、0 用户事件，没有启动模型轮次。
- 原型最终 26/26 通过；Core、helper、创建器、临时 home 和 socket 均已清理。

首轮核心归档已经成功，但 argv/env 完整 hash 检查失败：精简的测试环境没有继承 macOS 原有 `__CF_USER_TEXT_ENCODING`，Python 启动时自动补入该系统键。key-only 对照确认已有键无变化或删除。将父环境原有的该键纳入 fixture 后，保留原完整 hash 断言再次运行，26项全部通过。首轮失败和差异在 `first-proof.json` 与 `environment-key-diff.json`，没有丢弃失败或弱化断言。

此原型只验证 app-server 传输和测试目标归档。它没有完成通用 CLI 代理、生产认证/账本、真实 GUI 工具、原生撤销/置顶、工作树和自动化的完整验收，不应直接安装到日用桌面。

## 其他客户端给出的实际证据

- **CodexMonitor**：自己启动并持有 app-server，再向该实例发送归档。证明拥有 Core 的客户端能执行归档，没有证明可控制已经运行的官方 GUI Core。[启动](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/backend/app_server.rs#L749-L781)、[归档](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/shared/codex_core.rs#L363-L373)。
- **HAPI**：启动共享 app-server，再让官方终端 TUI 通过 `--remote` 接入；明确不支持其他 live owner 的热迁移。它的共享执行器机制可借鉴，不能外推为当前官方 GUI 已接通。[共享运行时](https://github.com/tiann/hapi/blob/317e39a0bb9c768ce135f3fbe3157f9e3fefeebe/cli/src/codex/shared/runtime.ts#L308-L330)、[生命周期边界](https://github.com/tiann/hapi/blob/317e39a0bb9c768ce135f3fbe3157f9e3fefeebe/docs/guide/codex-shared-sessions.md#L21-L50)。
- **ClawKit**：在官方桌面下一次启动时传入 `CODEX_CLI_PATH`，用适配器转发实际官方引擎的 stdio。10-13 本地快照没有现成归档接口；有价值的是启动机制。证据在 `.local/research/2026-10-13-clawkit-pocket/windows-source/desktop-352/src-tauri/crates/desktop-bridge/src/native/` 的 `launch.rs`、`runtime.rs` 和 `mod.rs`。

## 最小候选方案与验收

候选仅覆盖由该桌面 Core 持有的本机会话。Pocket 页面、请求账本、树指纹与取消机制继续使用既有实现；归档路由增加“同一 owner”的受限通道。

1. 启动适配器先 fork 一个仅负责传输的 helper，主进程再直接 exec 官方 Core。原 PID 成为真实官方 Core，父进程仍是 GUI；MCP 子进程的实际祖先链保持 `MCP → Core → GUI`。普通常驻 wrapper 再 spawn Core 会多一层祖先，不采用该结构。argv、env、初始化、服务器请求和通知仍需保全；不改 bundle、签名或真实存储。
2. Pocket 经用户私有目录内的受限 Unix socket 请求归档。身份、请求 ID、会话树指纹、当前运行/待发状态及原 owner 都需检查。归档前任何未知或活动状态均不当作空闲。
3. 控制请求使用独立 ID，响应仅回给调用方；原 Core 的通知仍送达桌面。掉线后核对原 requestId 和实际存储，不重放未知归档。
4. 成功必须包含原存储及整棵子树回读；桌面列表、置顶与缓存也需验证。当前 GUI 收到真实 `thread/archived` 通知后，主进程会安排工作树归档清理及关联 heartbeat 处理，renderer 会驱逐会话缓存。不能承诺“只改归档记录”；同时，原生按钮里的显式取消置顶与撤销操作也不能仅凭该通知视为已经复现。
5. 必须保留卸载和回退路径：正常退出测试桌面后移除启动配置，重新走官方 CLI。不用删除 writer 或杀死正在工作的真实 Core 来迁移。

工程验证分两层：先在完全隔离的 home 中，以模拟桌面加额外控制客户端验证 ID 分流、持锁归档、子树、无关会话和进程清理；再在独立可控的真实 GUI 启动中验证 App Tools、审批、发送、已读与归档后的列表。前一层成功不代替后一层。

当前 App Tools 原生 authorizer 包含 peer、parent、grandparent 的签名检查。fork/exec 结构在进程关系上保留原链，仍须验证真实 GUI 下的授权和正确调用会话上下文；不能借用签名解释器冒充客户端或绕开检查。并发开始新轮次、归档通知与旧缓存交错、恢复时置顶状态，以及中途退出/更新的恢复也属于尚未完成的产品验收。

启动集成还须覆盖日常从 Dock 打开和 App 升级后的重开；仅在一次终端启动时传环境变量，不能算长期可用。Pocket 必须确认受限通道确实连接当前桌面 Core，通道缺失时保留明确不可用/等待状态，不伪装成功。目前没有安装这种启动集成，实验脚本也不是可直接替换日用 CLI 的发行物。

现有真实请求继续沿用用户“先保留”的决定；本次研究不恢复已取消请求。需要真实桌面退出的步骤另择可中断时机，不能因本轮研究擅自重启。

## 补充官方资料

- [App Server transports](https://learn.chatgpt.com/docs/app-server)：stdio、TCP/Unix WebSocket、认证与实验性边界。
- [Remote control](https://learn.chatgpt.com/docs/developer-commands#codex-remote-control)：managed daemon／前台会话流程，不能替代本地协议客户端设计。
- [Desktop SSH remote connections](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)：说明远端启动方式，没有保证同机热附着既有 stdio Core。
- 当前包的启动条件、精确片段/hash和签名父链记录：`.local/research/2026-10-16-archive-entrypoints/shared-owner.md`、`.local/qa/shared-owner-2026-10-16/bundle-evidence.json`。这些内部入口以后升级须重新核验。
- 桌面通知、工作树/heartbeat、置顶和撤销的差异：`.local/research/2026-10-16-archive-entrypoints/native-side-effects.md`；Core [mark_archived](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/state/src/runtime/threads.rs#L1109) 不清除原 `is_pinned`。
