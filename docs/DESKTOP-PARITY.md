# Pocket 与桌面能力对照

核验日期：2026-09-29。按单人手机接续任务的价值排序，是本项目的产品判断，不是使用频次统计。桌面依据为已安装版本 `26.903.71938:8576` 的可读代码与原 owner 快照；内部 IPC 的存在不等于 Pocket 已实现或跨版本稳定。新增源码核验、官方 Remote 链路及完整候选见[本轮研究](research/2026-09-29-official-remote-and-capabilities.md)；研究建议先讨论再实施。

| 能力 | Pocket 当前状态 | 后续接入判断 |
| --- | --- | --- |
| 原未读提醒 / 待我输入 | 已接入保存状态视图 | 精确身份/host的原未读集合加终态确认，普通idle不计入；查看Pocket暂不回写已读。见[蓝点核验](research/2026-09-29-unread-status.md) |
| 上下文用量、手动压缩 | 本轮接入；正式版本见 CURRENT.md | 显示桌面最近请求用量，占用由 last.totalTokens / modelContextWindow 得到；空闲时可压缩，压缩期间暂停出队；执行中按原版条件禁用 |
| 运行中继续问、排队编辑/删除/直接发送 | 已实现 | Pocket 待发列表与桌面独立，实际执行回到原 owner |
| 停止当前执行 | 已接入，按 turn ID 中断 | 真实原任务 interrupted 已回读；Pocket 队列暂停/恢复可控，目标和自动化配置不改变 |
| 回复澄清问题、处理审批 | 命令/文件/本轮权限审批、异步与阻塞问题已接入，MCP 自定义表单等尚未接入 | 高优先级。存在 submit-user-input 与审批接口；先做用户明确选择的澄清回复，审批需展示准确操作与权限范围，不自动同意 |
| 图片/文件附件 | 尚未接入 | 手机上常用。桌面有上传/附件管线；需新增文件上传、大小与类型边界、Mac 临时文件生命周期和回显，不能只发手机本地路径 |
| 加载更早历史、对话内搜索 | 目前只读最近可见消息；搜索针对任务目录 | 存在 load-complete-history，需分段加载与界面窗口化，避免整段历史拖慢移动端 |
| 查看文件改动、工具结果与终端输出 | 只显示用户消息及可见回复 | 值得做。需按类型提供可展开的有界结果，文件打开与下载单独校验路径，不能直接暴露 Mac 文件系统 |
| 切换模型/思考强度/工作模式 | 当前继承原任务设置 | 存在 follower settings 接口；需读取该任务支持的模型和模式，处理运行中的生效时机 |
| 完成/失败/待处理通知 | 已实现 Web Push 基础链路，真机送达待验 | 关注近期在 Pocket 打开的任务；后台监测、状态去重、已处理请求取消，细节见 NOTIFICATIONS.md |
| 与桌面共享待发队列 | 尚未接入，Pocket 队列仍独立 | 已核验旧 follower 仅整表替换 legacy 队列，不适配新版队列或原生 send-now 锁；同一 App Server 通道仍受限，详见本轮 desktop-control-entrypoints 核验 |
| 编辑上一条并重跑 | 尚未接入 | 安装版本有 follower-edit-last-user-turn；先明确回滚后续对话的语义，区别于普通改字 |
| 会话重命名 | 尚未接通，用户 2026-09-29 要求同步 Codex 原任务 | 官方有 `thread/name/set`，当前桌面原 owner 转发方法没有改名；不实现仅 Pocket 显示名，接通后再做。见[核验记录](research/2026-09-29-rename-and-open.md) |
| 新建任务、原版归档、分叉 | 当前以查看、整理、继续既有任务为主 | 桌面有对应能力，但 App Tools 管道限定 OpenAI 团队签名和进程身份链，自己的证书不能解决（见[签名边界](research/2026-09-28-peer-signing-boundary.md)）；deep link 只能预填。需找到受支持常驻创建路径，并设计项目/cwd/工作树选择 |

## 接口与语义依据

- [官方 App Server](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)：`thread/compact/start` 只表示已启动，完成以 `contextCompaction` 的生命周期为准。
- [官方命令说明](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands)：`/compact` 总结上下文，`/status` 展示配置与 token 用量。这是官方客户端的命令语义；Pocket 文本框不自动把所有斜杠命令解释为控制操作。
- 当前安装 App 使用 `latestTokenUsageInfo.last.totalTokens` 与 `modelContextWindow` 展示上下文占用，累计 total 不用于占用百分比。该数字按最近模型请求更新，不代表正在生成时每个字符的即时统计。
- Pocket 调用版本限定的 `thread-follower-compact-thread` v1，目标只有原 conversationId；不启动另一份 app-server、不改模型或权限。每次用户点击有独立持久请求编号，未知回执先核对，不自动重复压缩。

建议优先讨论单图附件、只读改动与结果、更早历史/定位、待处理与通知；同步阻塞式提问等真实阻塞仍按实际问题调整优先级。新建/改名/归档与共享队列单列接口验证。以上尚未实现的能力不因列入本表自动成为建设任务。

2026-09-28 用户明确选择：左滑归档必须同步 Codex 原任务，接口接通前暂缓，不做 Pocket 独立归档。
