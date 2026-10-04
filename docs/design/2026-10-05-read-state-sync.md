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
