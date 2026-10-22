# 阅读后同步 Codex 已读状态

> 2026-10-22 后续决策：方帅已授权 [Pocket 独立阅读状态](2026-10-22-pocket-read-state.md)。以下为原生同步的历史实现与故障证据，不再是新界面的标读契约；旧接口保持兼容。

2026-10-05。方帅要求：Pocket「待我输入」中的任务，点击读取之后取消未读，并与 Codex 侧边栏同步。

## 体验与取舍

用户打开会话，当前页面已显示最新保存内容后，向原桌面提交标读；普通目录刷新、后台读取和旧缓存不表示用户已经阅读。标读成功后重新同步原目录，任务离开「待我输入」，正在阅读的详情和草稿保持。

读到旧位置时，新到内容仍保持未读。标读只改变提醒，不回答问题、不批准操作、不结束任务；之后新的原生未读事件仍可让任务再次进入收件箱。

## 原生通道与实证

版本仍为 `26.903.71938:8576`，安装 bundle 与 [09-29 核验](../research/2026-09-29-unread-status.md) 的 SHA 一致。普通 IPC 的 `thread-read-state-changed` v3 广播可进入主进程 read-state owner，主进程校验当前身份与执行主机后，更新原存储并通知匹配的桌面 renderer sessions。

Pocket 使用自己的 initialize 客户端身份，不经 App Tools 管道、不伪装桌面身份、不直接写 Codex 文件。当前适配范围为 API-key + local stdio；候选 context 由主进程的活身份/主机校验决定是否接受，磁盘配置本身不等于成功证明。

受控验收会话的原未读状态 `false → true → false` 已实测回读，约 127/129 毫秒生效并恢复原状态；新鲜原 owner 快照包含 `hasUnreadTurn:false` 与 `unreadMessageCount:0`。私有证据 `.local/qa/read-state-2026-10-05/native-roundtrip.json`。

## 阅读凭据与并发

快速正文响应提供短期观察凭据，绑定精确任务、稳定保存历史版本与身份/主机。前端只为实际显示的版本提交标读，服务端写前重新核对；过期凭据、新活动或身份变化返回 stale，不执行标读。相同请求编号复用回执，结果未知不自动重放。

原生 setter 只有布尔值，未提供 expected turn 或每会话 revision。其 generation 仅用于身份/主机换代，不能当作消息的原子比较条件。写前检查可以拒绝已知过期阅读，但最后核验与原生应用之间仍沿用桌面的事件先后语义，不能宣称完全消除该短窗口；不通过反向写 true 补偿，以免覆盖另一客户端的实际阅读。

成功以原身份/主机的持久未读集合回读为准，发送广播本身不等于完成；仅成功后刷新 Pocket 权威目录，不用本地隐藏冒充双端同步。

## 验证与发布

256 项全量测试和构建通过，含 Node 纳秒文件指纹到 Python 假 IPC、写前版本变化、身份/主机变化、幂等/未知恢复、旧生命周期事件别名，以及前台可见性和迟到结果。独立审阅发现并修复慢回执被轮询取消、问题卡标读、遮挡、快速返回和回执丢失恢复等问题。

390px 内置浏览器完成六种合成流程：慢回执只提交一次；未知结果显式重试；同正文新凭据从 stale 恢复；问题卡未读到底不写、读到底后写；已标读但回执丢失可通过权威目录恢复；向上读旧历史时新版本保持未读，跳到最新后清除。列表移除时详情与草稿保留，无页面错误和横向溢出。证据 `ui-fixture-state.json` 与 `browser.json`。

真实 API 用同一受控对象验证原未读 true → 取得观察凭据 → POST read 约549毫秒返回 read → Pocket hasUnreadTurn/needsInput 均 false；原 owner 的 hasUnreadTurn 及原持久集合也独立回读为 false。随后重新置测试未读，通过实际 Pocket 网页打开内容，自动阅读再次将原集合与 owner 状态清除；未点击连接或发送消息，验收对象恢复原已读状态。证据 `live-api.json`、`live-native-before/after.json`、`live-ui-before/after.json`。

公网源码 `edbeb9d`、Pages 部署 `5b8ffeee-83cb-4e39-970e-0acc4a207b97`，14 个公开文件匹配、功能检查与ready=true。公网标读约1秒返回read，原集合与运行owner状态均回读false，验收对象保持原已读状态；证据 `public-api.json` 和 `public-native-after.json`。当前发布身份以 `CURRENT.md` 为准。未作 iPhone 真机或长期跨设备并发验收；原生布尔 setter 的并发窗口仍按上节边界处理。

## 2026-10-14 读后未清除：桌面通信异常，待重启验证

用户再次报告读完仍未读。当前生产前端确实提交了标读，账本大量返回 `unknown/readback_unconfirmed`；Codex 官方列表与原持久集合均仍为未读。实际样本的历史/正文差异只是尾随 memory citation，现有精确扩展合并会保留完整正文，阅读凭据可正常使用。前端定向60项与手机合成16项检查通过，包含原生失败、主动重试、成功后保留草稿、长Query/过程折叠及真正等待输入仍保留；没有放宽阅读版本匹配。

App `26.1007.30912 / 20156` 的标读广播仍为v3，字段、身份、host派生和持久化逻辑与Pocket一致。受控对照中，官方setter可改变同一原生身份/host的未读状态，Pocket广播被另一新客户端收到，却不能改变持久状态。测试会话恢复原已读状态，原归档保持；未发送消息。

同一App进程存在两个同路径 UNIX listener。原生每个协调客户端独立构造router manager，启动时的检查、unlink、listen之间没有共享锁；这与旧、新router分裂、主进程标读监听留在另一条连接的现象吻合。双listener与广播失效是已验证事实，具体连接归属及启动竞态的因果仍需恢复后对照，不将静态代码推断当成已完成修复。

用户随后询问是否BotMux监听干扰。补查已安装BotMux代码：通知Hook读取完成事件；side-conversation-monitor以`createConnection`连接同一socket，发送初始化/订阅和无处理能力的discovery响应，没有创建、删除socket或写入已读状态。两个监听由macOS `SO_ACCEPTCONN`确认均属于Codex主进程；当前socket创建于10月13日10:21:25，今天15:51恢复BotMux后未替换。最早失败回执在10月10日20:09，早于本次恢复。这些证据不支持把本次恢复BotMux认定为原因，但尚未完成停用对照，不能排除所有历史交互。`I am the router`日志在每次接入客户端时也会打印，不能据它统计listener或认定分裂时间。证据 `native/listener-recheck.json`。重启仅为待验证的恢复候选，不能表述成已证实必需或保证解决。

未找到安全的局部重连入口。`ipc-connection-reset` 是socket关闭后的本地通知，不是重连命令；不要试发它、删socket或仅重启Pocket API来碰运气。恢复候选是等待原任务安全空闲后完整退出/重开Codex，再检查listener与受控标读；一次重启本身不能代替验收。当前其他会话在运行，已请求用户决定重启时机，尚未重启。

一条已有失败标读凭据且当前正文版本完全一致的实际会话，已通过官方标读工具补齐同步，原集合与Pocket目录的未读/待输入都回读为false。这是精确对象的恢复，不代表Pocket自动标读通道已恢复；未批量清除未知或新内容的未读。

私有证据 `.local/qa/read-state-2026-10-14/`：`frontend/browser-verdict.json`、`native/current-protocol.json`、`native/socket-split.json`、`native/routing-event.json`、`native/canary-old-writer.json`、`native/already-read-recovered.json`、`native/recovery-assessment.json`。产品代码、部署和Pocket服务保持原版本。

## 2026-10-20 再次复现与精确补齐

用户再次确认，在 Pocket 读完返回后，Pocket 和 Codex 都保持未读。本轮重新核验当前代码、生产构建及真实原生通道，不能沿用 10-05 的成功记录宣称当前自动同步可用。

- 当前 App `26.1013.40934:20770`，内置 CLI `0.163.0-alpha.10.2`。原生标读仍使用 v3 广播，活身份与 host key 的验证未变；没有新增独立 follower 标读 request。
- Pocket 账本最近请求实际进入了原生写入，返回 `unknown/readback_unconfirmed`。独立前端检查的 26 项定向测试、16 项基础浏览器断言及 Chromium/WebKit 28 项扩展断言通过；可见阅读、长内容/过程折叠、旧滚动位置、新凭据、慢回执退出和草稿恢复未发现本次回归。注入原生未确认结果可以准确复现用户症状。
- 用已存在、已归档且 0 消息/0 tokens 的专用 QA 空会话对照：官方 setter 能置未读；运行当前 `bin/read-state.py` 返回 `readback_unconfirmed`，原持久集合仍为未读。随后通过官方 setter 恢复原已读，文件版本、归档与 tokens 保持。旧受控回显对象的 rollout 已不存在，未为测试恢复或伪造该文件。
- 对专用 QA 的官方未读→已读变化做 18 秒被动监听，新客户端没有收到任何标读广播，但收到其他 IPC 消息。主进程 PID `94780` 的 FD `142`、`144` 经只读 `SO_ACCEPTCONN` 检查都是同一路径的真实 listener。结合现版仍存在每实例 `canConnect → unlink → listen` 的启动过程，证据仍与内部 router 分裂一致；没有通过恢复后的对照确认全部因果。

已对最近 24 小时的失败阅读回执逐条核对，只有 4 个会话的当前 thread/sourceVersion/identity/host 与用户实际阅读凭据完全一致且仍未读。写前再次核对后，经官方 setter 补齐；原持久集合和 Pocket `/api/sync` 均回读为 `hasUnreadTurn:false`、`needsInput:false`。其余已变化或已读的凭据跳过，没有批量清除未读、改写历史或重放未知发送。这只是精确恢复已有阅读，**自动标读通道仍未恢复**。

当前未找到可由 Pocket 后台直接调用、无需重启的另一条已验证原生 setter 路线。App Tools 的宿主身份检查继续保留；原 Core 没有对应控制 socket；官方 CLI/通用 follower 没有此操作。`ipc-connection-reset` 只是断连后的本地通知，重启 Pocket API 或 renderer 也不能保证重建主进程标读客户端。不删 socket、不伪装签名客户端、不直接写原数据库或全局 JSON。

下一步是用户确认安全时机后完整退出/重开 Codex，再执行同一专用对象的原生→Pocket→持久状态对照，并确认 listener 与事件互通。重启是待验证的恢复候选，不能保证不会再次出现启动竞态。检查时其他会话正在运行，本轮未擅自中断；产品源码、前端部署和 Pocket 服务均未改变。

私有证据：`.local/qa/unread-sync-2026-10-20/`。前端见 `frontend/assessment.md` 和两份 verdict；原生对照见 `native/baseline.json`、`old-writer.json`、`restored.json`、`native-routing.json`；精确补齐见 `pending-visible-reads.json`、各对象的 repair intent、`repair-receipts.json`、`confirmed-visible-reads.json`、`pocket-readback.json`。下一次继续先回读这些外部操作结果，避免重复置未读或补齐。

## 2026-10-22 上游已读方案与当前只读复核

方帅明确 Claude 接入先缓，继续聚焦当前 Codex 接入和原生未读/已读同步。Happy/HAPI 的已读源码主要维护客户端自己的 Set、localStorage 或本机 SQLite/JSON；未发现把阅读写回 Codex Desktop 原生蓝点的链路。完整对照见[未读专项研究](../research/2026-10-22-unread-comparison.md)。

本轮没有重复标读实验，只读核实当前 App 仍为 `26.1013.40934:20770`；主进程已于 10-22 04:10（Asia/Shanghai）启动，PID 为 `79026`。既有 socket 探针确认 FD `134`、`141` 仍是同一路径的真实 listener。新进程启动后的 Pocket 回执截至检查有25条 `readback_unconfirmed`；另有1条read，不能据此认定广播通道恢复。

因此旧记录中“尚待首次完整重启”的接续条件已过时：新进程里重复监听与失败回执再次出现。下一次修复应围绕当前标读订阅/路由归属和受控原生写回对照展开，重启只能作为需要前后验证的实验，不能单独当修复。完整因果仍待定向确认，本轮不把双listener直接等同每条失败的根因。

没有改动产品、App/服务、socket、Codex存储或真实已读状态。证据在 `.local/qa/unread-research-2026-10-22/`：`current-listeners.json`、`read-only-receipt-summary.json`；含精确命令、时间与汇总，无会话正文。
