# 阅读后同步 Codex 已读状态

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
