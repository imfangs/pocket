# 会话历史与网页 query

2026-09-28 用户追加需求：移动端排序可切换、默认最近活动、打开任务查看最新历史，并从 x.fangs.cc / threads.local 向原任务发送 query。

## 使用

任务详情默认进入「会话」，「整理」保留原来的说明与分组编辑。历史按时间由旧到新排列，首次进入定位最新消息；切回近期会话保留内容和阅读位置，手动向上阅读时不会强制拉回底部。页面可见时，运行中每次读取完成后 2 秒再读，空闲 8 秒；实际间隔还包括网络与桌面读取耗时。后台暂停，重新可见或联网后立即更新，也可手动刷新或跳到最新。

窄屏详情可从左边缘向右滑返回列表，未发送 query 草稿仍保留。手势须从详情左侧 32px 内开始；输入框、链接/按钮、代码块/表格、选中文字和多指手势不触发返回。关闭按钮继续可用；不改写浏览器的历史导航。软件键盘打开时，详情跟随可见视口的高度和偏移，收起顶部任务摘要，为输入区腾出空间；关闭键盘后恢复。

消息视觉分为三类：用户消息靠右浅绿气泡，Codex 过程消息使用灰色虚线时间线，最终回复使用白色卡片与绿色侧线；同时显示图标和「你 / Codex · 过程 / Codex · 最终回复」标签。只按来源明确的 final/final_answer 判断最终回复，无 phase 的旧消息保留「Codex · 回复」，不会推断成已完成。过程消息保持完整可读，不自动折叠。

显示桌面当前已加载的最近历史，最多 80 条可见消息；完整历史、工具详情和审批继续在原 Codex 中查看。消息正文支持 CommonMark / GFM：标题、粗体/斜体、删除线、列表/任务列表、引用、链接、表格、行内代码和代码块。长代码与宽表格仅在消息内部横向滚动。Mermaid 暂按代码块显示；没有加入语法高亮或图表执行器。

Markdown 通过 React 节点渲染，不执行原始 HTML；链接仅允许 HTTP(S)/mailto，外部链接新页打开且不携带 referrer。本机文件路径保留显示文字，不作为网页路由打开。Markdown 图片显示说明和可点击的外部图片链接，不自动加载第三方资源；原 App 附件仍为占位提示。不会读取隐藏推理或系统/开发者指令。渲染只改变展示，不修改消息原文；组件按文本 memo，历史刷新和输入时不重新解析未变的消息。

任务在 Mac 已加载时可以发送文本 query，最多 16000 字。空闲时立即发送；运行中或已有待发消息时默认排队。待发列表支持删除、编辑和直接发送。编辑先暂停该条，保存后恢复排队；取消编辑恢复原文，切换任务后草稿仍可继续编辑。直接发送在运行中使用 Steer 追加到当前轮，空闲时开启下一轮。待审批/输入、已归档或不兼容版本保持不可发送。未加载的原任务可以从网页点「连接 Mac 中的原任务」调用既有 deep link，然后刷新状态；不会创建新任务。

输入框按实际文字换行自动增高，删除后缩回；长文到上限后在框内滚动，上限随可见视口收缩。待发消息编辑框使用相同规则。

query 会在原任务的工作目录和权限中执行，模型/推理设置由原任务继承。网站访问口令不变；持有访问口令者现在可以向满足条件的原任务提交消息。网页允许用户对受支持的命令审批明确点击允许一次或拒绝，不自动回答，也不覆盖权限或模型。

## 网页命令审批

任务卡片显示「等待确认」时，展开可查看完整命令、工作目录及申请原因。仅对 item/commandExecution/requestApproval 接入「允许这一次」accept 和「拒绝本次」cancel；只显示桌面原请求提供的选项，任何持久 execpolicy/session 放权均不接入。更长于 32000 字的命令或其他未支持请求仍交给 Mac，不能在只显示截断内容时批准。

POST /api/tasks/:id/requests/:fingerprint/respond 接受 `{responseId, decision}`；GET /api/tasks/:id/responses/:responseId 只查账本。fingerprint 对整个原请求做 SHA-256，提交前两次读取 owner 并核对当前请求。Python 仅调用 thread-follower-command-approval-decision v1，不执行命令本身。原生 id 为数字 0 也原样保留。

request_responses 账本保存响应编号、请求指纹、一次性 decision 和状态，不另存命令正文。重复编号返回已有回执；同一请求未确认的响应不会被新点击替换。超时和服务重启保留 unknown，不能自动重试；桌面快照确认该请求消失后记为 resolved。resolved/accepted 表示审批处理，不能代替原命令执行成功。

## 上下文用量与压缩

输入区附近显示上下文占用百分比，展开可查看 used / window / remaining tokens。值来自原 App 的 latestTokenUsageInfo.last.totalTokens 与 modelContextWindow，与桌面保持同口径；不是累计计费用量，也不以网页显示的消息字数估算。只有已取得实时桌面快照时显示，字段缺失时标记暂不可用。

「压缩上下文」只在任务已连接且空闲、待发列表为空时可用。较早内容会被总结为更短上下文，可能省略细节；按钮旁的说明可展开。压缩期间暂停发送和自动队列处理。POST /api/tasks/:id/compact 只接受 `{requestId}`，GET /api/tasks/:id/compact/:requestId 仅查询回执。

请求在本机 compactions 表记录编号、任务、基线事件 ID 和状态，不保存聊天正文。原 owner 收到 thread-follower-compact-thread v1 后返回 accepted；读取到基线之后的新 contextCompaction 完成事件后才显示 completed。失败和结果不明分别显示；未知回执不自动重放，重启未完成的提交标为 unknown。该内部接口未提供服务端幂等编号，最后一次状态校验与调用间仍有很短竞态；其他客户端也可能触发压缩，核对表示已观察到后续压缩事件，不强行归因给某一次点击。

完整能力差距与优先级见 [DESKTOP-PARITY.md](DESKTOP-PARITY.md)。

## 数据与协议

`server/desktop.mjs` 从已导入的 ID 查找目标，调用 `bin/desktop-bridge.py`；后者复用 FBT `experimental/codex-retry/scripts/app_ipc.py` 的长度前缀 Unix socket 客户端。身份为 `codex-navigator`，不改变 FBT 重试守护策略或配置。

已只读核验的桌面版本是 `26.903.71938:8576`；使用 initialize v0、owner discovery v1、following v1、snapshot v11、follower start turn v2、follower steer turn v1。`config/desktop-bridge.json` 固定版本与依赖路径。App 升级或协议变化后发送关闭，需要重新核验。它是版本限定的内部协议，不是官方承诺稳定的公共 SDK。

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 已核对 `thread/read`、`turn/start`、`turn/steer` 与审批生命周期。本项目使用现有桌面 owner 的 IPC，不启动另一个 app-server 读写同一任务。

有 owner 时读取原 App 的 canonical turnHistory，提取 userMessage、已接受的 steeringUserMessage 与非 analysis 的 agentMessage。运行中追加的用户文本单独显示；其 serverUserMessageId 已成为普通 userMessage 时去重。只读取追加消息的输入、标识和时间，不暴露 restoreMessage 中的上下文。网页的「直接发送」也通过同一 owner 提交追加消息。无 owner 时通过只读 SQLite 定位 rollout，校验真实路径必须在 Codex home 的 sessions/archived_sessions 内且 session_meta ID 相同，再读取文件尾部至多 4 MiB。只保留 user/assistant 可见文本，单消息至多 24000 字，总量至多 160000 字。页面标明“已保存的历史”或实时状态，不把落盘副本当成实时运行状态。

历史读取的 owner discovery 最多等待 2 秒，以免未加载任务等满桌面默认的 10 秒才显示落盘内容。该客户端截止时间不用于发送，并在找到 owner 后恢复 socket 原预算，以允许较大的完整快照读取。初始化或快照传输本身不属于这 2 秒预算；整体读取仍受现有超时保护。

后端最多短时复用 10 条任务的历史：未完成的读取合并为一个请求，完成后活动快照 750ms、其他 3 秒过期。浏览器本次登录内最多缓存 10 个已访问任务的历史与阅读位置，切回先展示缓存，成功复核前保持发送禁用；退出后随 App 卸载清空。历史不保存到 Pocket 数据库、KV、浏览器持久存储或 Service Worker cache。分组/说明仍独立存储。未发送的 query 草稿只保留在当前登录页面内存中，可在任务与标签切换后取回；刷新前提示未发送文本。

历史请求一次只运行一个，离开页面会取消；18 秒仍无响应则结束等待并有界退避重试，断网时保留已读内容并提示恢复方式。发送操作不使用这套自动重试，仍按下文 requestId/回执处理。

## 发送与重复提交

私人 API 同样要求有效登录、同源 Origin 和 CSRF token：

- `GET /api/tasks/:id/history`：最近可见消息、来源、运行状态、是否可发送及本任务 outbox。
- `POST /api/tasks/:id/messages`：仅接受 `{text, requestId, enqueue?: true}`，拒绝模型、权限、cwd 等覆盖字段。
- `GET /api/tasks/:id/messages/:requestId`：查询提交回执，不重新发送。
- `PATCH /api/tasks/:id/outbox/:messageId`：`{text, expectedRevision}` 保存编辑。
- `DELETE /api/tasks/:id/outbox/:messageId`：`{expectedRevision}` 删除待发消息。
- `POST /api/tasks/:id/outbox/:messageId/edit|resume|send`：`{expectedRevision}` 暂停编辑、恢复排队或直接发送。

每次提交先在 Pocket SQLite `dispatches` 表写入请求编号、目标 ID、文本哈希和 pending 状态，真实文本不进入发送账本。已提交的待发正文单独存入 `outgoing_messages`，仅在 Mac 私有数据库中持久保存，接受或取消后清除；不包含在整理备份、公开构建或浏览器持久缓存中。相同编号只能对应相同目标和文本，重复 POST 返回已有回执；同一任务的实际发送串行，发送尚未返回时仍可继续追加待发消息。Python 在发送前两次回读 owner 和状态，使用 clientUserMessageId 与 inheritThreadSettings 提交。

accepted 表示原桌面接口接收，不表示模型执行完成；运行进展通过历史刷新读取。明确拒绝保留草稿供修改/重试。超时或回执不明标 unknown，不自动重发；页面“核对发送状态”只查账本，原 App 历史出现对应 clientUserMessageId 时可确认 accepted。

原接口没有“仅当状态仍相同才提交”的原子条件，最后一次回读与实际提交之间仍有短暂竞态；收到未知结果时应先核对原历史。当前不支持新建任务、上传附件、停止任务、澄清问题回复或命令之外的远程审批。


## 待发队列的边界

Pocket 与 Codex 桌面的待发列表独立。已安装桌面版本的队列 IPC 会整体替换列表，没有安全的原子追加接口；本实现不读取后重写桌面队列，以免覆盖桌面或其他客户端刚加入的内容。官方行为说明见 [Steering and queuing](https://learn.chatgpt.com/docs/prompting#steering-and-queuing)。

每个任务最多 20 条待发消息，按提交顺序执行。Mac 服务在当前轮 completed、任务可发送时继续；页面关闭后仍可工作，Mac/服务离线时保留待发内容。只要首条在编辑、提交中、失败或结果待确认，自动发送暂停，后续消息不会越过它；用户可以明确选择某条直接发送。待审批、失败/中断的轮次不自动接续。

编辑和删除使用 revision 防止旧页面覆盖新内容；实际发送前原子认领条目。重启时尚未获得结果的 pending 条目标为 unknown，不重放；历史中精确匹配 clientMessageId 后才解除不确定状态。明确未发送的错误可由用户编辑/直接发送重试。若 unknown 长期无法核对，保留条目并在原 App 确认，不能凭超时推断未发送。

## 验证状态

2026-09-28 新增真实公网队列验收：运行中编辑、删除、Steer 及下一轮自动执行均成功，回读两个 completed 回合、准确消息与指定回复，0 工具调用，删除消息未出现，原归档已恢复。私有证据 `.local/qa/queue-live.json`。

2026-09-28 正式登录、历史读取、Markdown 及移动尺寸布局已验证；运行中追加消息漏显已修复。公网 API 向受控原任务提交一次无工具回显，准确 requestId、模型回复和 completed 状态均独立回读，原归档已恢复。该样本证明 API→原 owner→模型→历史链路，尚不等于 PWA 真机表单发送或长期网络可靠性验收。表单/回显、协议发送结构、模型/权限继承及状态竞态另有合成测试。当前部署身份和完整验证状态以 `CURRENT.md` 为准，后续打磨见 `QUALITY.md`。

排序不再被 pinned/recent 视图强制覆盖。偏好版本升级为 2，旧默认迁移为 updated；之后保留用户的显式选择。原版置顶顺序仍可通过「置顶优先」查看。
