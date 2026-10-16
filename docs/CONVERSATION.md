# 会话历史与网页 query

2026-10-16显示修复：隐藏完整浏览器上下文包装附带的`My request:`，保留用户正文、复制和原始回执数据；识别边界见[用户消息包装](design/2026-10-16-user-message-envelope.md)。

10-15更新：待发消息放弃修改、答案草稿丢弃、归档主按钮和离线附件处理见[交互稳定与原地恢复](design/2026-10-15-interaction-recovery.md)。保存/恢复仍沿用本文的revision与回执协议。
2026-10-15交互更新：浏览不激活，主动输入意图预连接，右下主按钮融合重试/发送/核对；常用文案简化，近期消息时间相对显示。具体条件、请求防重与旧接口边界见[独立优先与输入意图](design/2026-10-15-priority-and-composer.md)。

2026-09-28 用户追加历史与网页 query 需求；本文于 2026-10-01 对齐已交付行为。当前运行/发布状态见 [CURRENT.md](../CURRENT.md)，旧验证时间线见 [HISTORY.md](../HISTORY.md)。维护本文件时以现有实现与近期设计记录核对接口语义。

## 使用

任务详情直接显示对话，不再保留页签与备注编辑。点击顶部会话标题打开原会话信息、重命名与归档等操作。历史按时间由旧到新排列，首次进入定位最新消息；切回近期会话保留内容和阅读位置，手动向上阅读时不会强制拉回底部。页面可见时，运行中每次读取完成后 2 秒再读，空闲 8 秒；实际间隔还包括网络与桌面读取耗时。后台暂停，重新可见或联网后立即更新，也可手动刷新或跳到最新。

2026-10-05：原未读且保存轮次已结束的任务，在前台实际显示最新内容后同步 Codex 已读；普通后台读取和旧缓存不标读。任务离开「待我输入」后，详情和草稿保留。失败时可点「同步已读」重新核对，具体观察凭据与回读边界见[已读同步](design/2026-10-05-read-state-sync.md)。

窄屏详情可从左边缘向右滑返回列表，未发送 query 草稿仍保留。手势须从详情左侧 32px 内开始；输入框、链接/按钮、代码块/表格、选中文字和多指手势不触发返回。关闭按钮继续可用；不改写浏览器的历史导航。软件键盘打开时，详情跟随可见视口的高度和偏移，收起顶部任务摘要，为输入区腾出空间；关闭键盘后恢复。

2026-10-10：详情仅在确认软件键盘遮挡时临时跟随视口，收起后恢复CSS全屏高度；失焦保留短暂动画宽限，生命周期与有限延后采样处理Safari迟到的尺寸。独立全屏背景避免过渡时露出任务列表；不主动blur/refocus，不改草稿或输入法回填。具体复现、旋转/缩放边界与真机验证范围见[键盘收起后的详情恢复](design/2026-10-10-keyboard-recovery.md)。

消息视觉分为用户、过程与最终回复三类，通过对齐、容器和过程侧线区分；可见身份/阶段标题已移除，可访问名称仍保留。时间、复制、最终用时及短暂发送确认位于消息右下，具体布局和全局toast见[轻量反馈](design/2026-10-12-light-feedback-and-message-footer.md)。只按来源明确的 final/final_answer 判断最终回复，无 phase 的旧消息不会推断成已完成。同轮最终回复出现后，之前的连续过程默认折叠，可展开查看原文；当前问题保持可见，正在上翻或选字时暂缓折叠，规则与阅读保护见[过程折叠](design/2026-10-11-completed-progress.md)。

显示桌面当前已加载的最近历史，最多 80 条可见消息；更早历史、未支持的工具详情和表单继续在原 Codex 中查看；已支持审批可在网页响应。消息正文支持 CommonMark / GFM：标题、粗体/斜体、删除线、列表/任务列表、引用、链接、表格、行内代码和代码块。长代码与宽表格仅在消息内部横向滚动。Mermaid 暂按代码块显示；没有加入语法高亮或图表执行器。

Markdown 通过 React 节点渲染，不执行原始 HTML；外链仅允许 HTTP(S)/mailto，新页打开且不携带 referrer；严格 UUID 的 `codex://threads/ID` 可转为 Pocket 内导航。记忆引用、创建任务、批注等专用标记按[消息标记契约](design/2026-09-30-codex-markup-and-current-questions.md)展示，不执行正文中的动作。已在可见正文中引用、位于任务目录内的本地静态图片可通过认证地址预览和打开大图；范围与读取边界见 [图片契约](IMAGES.md)。其他本机文件路径保留文字，不作为网页路由打开。外部图片保留可点击链接，不自动加载第三方资源；Pocket上传且绑定的附件显示图片/文件卡片，其他来源的原App附件仍为占位提示。不会读取隐藏推理或系统/开发者指令。渲染不修改原文；组件按文本与图片地址 memo，历史刷新和输入时不重新解析未变的消息。

任务在 Mac 已加载时可以发送文本 query，最多 16000 字。空闲时立即发送；运行中或已有待发消息时默认排队。待发列表支持删除、编辑和直接发送。编辑先暂停该条，“保存并排队”保存新内容并恢复该条排队；整队暂停时显示“保存并保持暂停”。“放弃修改”仅清本地编辑稿，原文继续暂停，需明确“恢复排队”。切换会话后草稿仍可继续编辑。直接发送在运行中使用 Steer 追加到当前轮，空闲时开启下一轮。待审批/输入、已归档或桌面接口不兼容保持不可发送。未连接的会话在主动输入时预连接，或提交消息后由 Pocket 接入原桌面；同一主按钮负责发送与失败重试，期间保留草稿与待发，并等待真实连接结果。连接超时可明确重试，不创建新任务、不重放未知发送。见[连接恢复](design/2026-10-05-connection-recovery.md)。

输入框按实际文字换行自动增高，删除后缩回；长文到上限后在框内滚动，上限随可见视口收缩。待发消息编辑框使用相同规则。

query 会在原任务的工作目录和权限中执行，模型/推理设置由原任务继承。网站访问口令不变；持有访问口令者现在可以向满足条件的原任务提交消息。网页允许用户明确响应已支持的提问与审批，不自动回答，也不覆盖原模型或扩展权限范围。

## 停止当前执行

正在执行时会话顶部出现「停止」。POST /api/tasks/:id/stop 只接受 `{requestId, expectedTurnId}`；GET /api/tasks/:id/stop/:requestId 只核对回执。原 owner 的 thread-follower-interrupt-turn v4 使用 user-stop 模式和明确 turn ID，原任务已经换轮时拒绝旧请求。

execution_stops 和 queue_pauses 存储停止回执与队列暂停状态。提交前先暂停 Pocket 自动队列，收到 accepted 后继续回读；只在目标 turn=interrupted 时显示中断，若其自行完成则标为 ended。结果不明或服务重启均不重放请求。该操作不撤销已完成的工作，不归档/删除会话，也不修改任务目标、自动化或权限设置。

「恢复排队」POST /api/tasks/:id/queue/resume 接受 `{expectedStopId}`，避免旧页面解除后来一次停止。恢复同一中断轮的队列须由用户明确点击；发送前再次核对原轮次，普通自动队列仍不越过失败/中断状态。队列只属于 Pocket，其他客户端的队列不由该表管理。

## 回答 Codex 异步提问

支持上文原生异步选项/自由文本提问。原消息 delivery=async 且带 questions；编号严格沿用 JSON.stringify([request_user_input_async, sourceMessageId, questionIndex])。仅从原桌面最新一轮读取最多10个未回答问题，总内容预算45000字符，单题内容不截断；最新一轮已完成但仍有问题时保留，新轮开始后旧问题退出回答区，历史文字保留。内容预算超限时保留普通历史文字，不提供不完整题目的提交入口。

POST /api/tasks/:id/questions/:key/answer 接受 `{requestId,text}`。服务端重新读取问题并核对含题目/选项的指纹，再构建原生 send_user_message_question_reply 封装。运行中的回答直接追加给原任务，空闲时开启原任务下一轮；沿用模型和权限，不混入普通 outbox。question_answers 只关联题目指纹与发送账本，不另存答案正文。未知回执只核对，历史看到准确 clientMessageId 才解除不确定性。

已回答状态按原生用户回复或已接受的 steeringUserMessage 识别，跨桌面和 Pocket 一致。2026-10-10：异步问题在其原正文位置显示，默认只展示题目与“回答 / 忽略”；点回答展开表单，正文和普通输入框保持可见。忽略只记录本设备对这道问题的呈现选择，不发送答案、不停止执行、不改变原生已回答状态；仍可重新回答。未提交答案草稿保留，正在提交或结果未知时不能忽略。状态按任务与题目指纹隔离，本地最多保存200个忽略标识，不保存题目或答案正文。回答后保留问题历史，用户回复展示可读正文；原消息附加说明、图片与截断提示沿用正文展示边界。

问题暂先于原正文到达时仍可操作，但暂停已读同步，直到正文与原观察凭据相符。跨视图保留在途回答标识，提前返回的 not_found 不得解除仍在途的回答保护。交互与验证见[可忽略的异步提问](design/2026-10-10-optional-question-prompts.md)。同步阻塞型 item/tool/requestUserInput 和权限审批保持必须明确响应的原语义，见下文“更多审批与阻塞问题”；文件选择、MCP 自定义和未支持表单仍需在 Mac 处理。

## 网页审批

任务卡片显示「等待确认」时，可查看原请求的命令/文件改动、目录与申请原因。命令分支 item/commandExecution/requestApproval 提供原请求允许的 accept/cancel；文件、本轮权限与阻塞问题分支见下文。持久 execpolicy/session 放权不在范围内。超出完整展示预算或未支持的请求仍交给 Mac，不在截断内容上批准。

POST /api/tasks/:id/requests/:fingerprint/respond 接受 `{responseId, decision}`，阻塞问题回答使用 `{responseId, answers}`；GET /api/tasks/:id/responses/:responseId 只查账本。fingerprint 对整个原请求做 SHA-256，提交前两次读取 owner 并核对当前请求。命令分支调用 thread-follower-command-approval-decision v1，不执行命令本身。原生 id 为数字 0 也原样保留。

request_responses 账本保存响应编号、请求指纹、一次性 decision 和状态，不另存命令正文。重复编号返回已有回执；同一请求未确认的响应不会被新点击替换。超时和服务重启保留 unknown，不能自动重试；桌面快照确认该请求消失后记为 resolved。resolved/accepted 表示审批处理，不能代替原命令执行成功。

## 上下文用量与压缩

会话顶部状态栏显示上下文占用百分比，展开可查看 used / window / remaining tokens。值来自原 App 的 latestTokenUsageInfo.last.totalTokens 与 modelContextWindow，与桌面保持同口径；不是累计计费用量，也不以网页显示的消息字数估算。只有已取得实时桌面快照时显示，字段缺失时标记暂不可用。

「压缩上下文」在原任务空闲时可用，允许保留待发消息。较早内容会被总结为更短上下文，可能省略细节；按钮旁的说明可展开。压缩期间暂停执行派发和自动出队，仍可保存新的待发正文；原本已暂停/编辑中的队列不会被自动解锁。POST /api/tasks/:id/compact 只接受 `{requestId}`，GET /api/tasks/:id/compact/:requestId 仅查询回执。

请求在本机 compactions 表记录编号、任务、基线事件 ID 和状态，不保存聊天正文。原 owner 收到 thread-follower-compact-thread v1 后返回 accepted；读取到基线之后的新 contextCompaction 完成事件后才显示 completed。失败和结果不明分别显示；未知回执不自动重放，重启未完成的提交标为 unknown。该内部接口未提供服务端幂等编号，最后一次状态校验与调用间仍有很短竞态；其他客户端也可能触发压缩，核对表示已观察到后续压缩事件，不强行归因给某一次点击。

完整能力差距与优先级见 [DESKTOP-PARITY.md](DESKTOP-PARITY.md)。

## 数据与协议

`server/desktop.mjs` 从已导入的 ID 查找目标，调用 `bin/desktop-bridge.py`；后者复用 FBT `experimental/codex-retry/scripts/app_ipc.py` 的长度前缀 Unix socket 客户端。身份为 `codex-navigator`，不改变 FBT 重试守护策略或配置。

2026-10-13实现调整：`config/desktop-bridge.json` 只配置运行路径，App 发布号不再决定准入。桥接仍检查 Codex bundle 身份、socket、固定 IPC 方法/快照版本、owner 与响应归属，以及 Pocket 实际消费的任务状态。初始化、owner discovery、following、snapshot、start turn、steer turn 的已知版本分别为 0、1、1、11、2、1；未知契约保持拒绝。这些是内部协议，不是官方承诺稳定的公共 SDK。

内置 CLI 由 `bin/bundled_cli.py` 按实际包布局发现；新建、改名、归档/恢复仍独立检查已验证 CLI 版本，未验证版本返回 `cli_version_changed`。接口不兼容时保留落盘历史、草稿与条件允许的入队保存，暂停实际发送、停止、压缩和自动出队；存量 `app_version_changed` 回执继续识别，新鲜有效状态可解除旧连接失败。具体取舍与验证边界见[桌面兼容](design/2026-10-13-desktop-compatibility.md)。

历史证据：2026-10-10在 `26.1007.21159:20052` 上已完成原owner公网受控回显及CLI隔离验收，原模型/权限不变；当时采用精确App版本配置。该次[桌面升级兼容记录](research/2026-10-10-desktop-upgrade-compatibility.md)保留原结论，不作为当前准入规则。

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 已核对 `thread/read`、`turn/start`、`turn/steer` 与审批生命周期。本项目使用现有桌面 owner 的 IPC，不启动另一个 app-server 读写同一任务。

有 owner 时读取原 App 的 canonical turnHistory，提取 userMessage、已接受的 steeringUserMessage 与非 analysis 的 agentMessage。运行中追加的用户文本单独显示；其 serverUserMessageId 已成为普通 userMessage 时去重。只读取追加消息的输入、标识和时间，不暴露 restoreMessage 中的上下文。网页的「直接发送」也通过同一 owner 提交追加消息。无 owner 时通过只读 SQLite 定位 rollout，校验真实路径必须在 Codex home 的 sessions/archived_sessions 内且 session_meta ID 相同，再读取文件尾部至多 4 MiB。只保留 user/assistant 可见文本，单消息至多 24000 字，总量至多 160000 字。页面标明“已保存的历史”或实时状态，不把落盘副本当成实时运行状态。

历史首次读取的 owner discovery 最多等待2秒，以免未加载任务长时间阻塞落盘内容。近期重试最多等待10秒，兼容长会话与繁忙桌面；找到owner后恢复socket原预算，整体历史读取仍有16秒外层上限。查找、初始化和完整快照传输是不同阶段，不能把2秒当成完整请求预算。

2026-09-30增加独立的只读文字路径 `GET /api/tasks/:id/transcript`，直接读取受限、按来源过滤的rollout，不等待桌面快照。该响应只有展示数据，没有执行权限；前端以共同消息ID、同消息完整度或明确的回合完成证据更新消息，原生内容领先时保留原生结果。原桌面状态仍独立更新，文字不能清除发送回执或授权操作。文字读取、缓存、后台暂停、压缩与验证边界见 [文字优先说明](design/2026-09-30-transcript-first.md)。

后端最多短时复用 10 条任务的历史：未完成的读取合并为一个请求，完成后活动快照 750ms、其他 3 秒过期。浏览器本次登录内最多缓存 10 个已访问任务的历史与阅读位置，切回先展示缓存，成功复核前保持发送禁用；退出后随 App 卸载清空。历史不保存到 Pocket 数据库、KV、浏览器持久存储或 Service Worker cache。分组/说明仍独立存储。未发送的 query 草稿只保留在当前登录页面内存中，可在任务与标签切换后取回；刷新前提示未发送文本。

历史请求一次只运行一个，离开页面会取消；18 秒仍无响应则结束等待并有界退避重试，断网时保留已读内容并提示恢复方式。发送操作不使用这套自动重试，仍按下文 requestId/回执处理。

## 发送与重复提交

2026-10-10新增图片/文件发送：已有会话可从回形针选择附件或粘贴图片，上传到Mac后与Query一起提交，也可只发附件。消息接口接受 `attachments: string[]`，去重指纹同时覆盖文字和附件身份/哈希。上传与派发是两份回执，附件贯穿草稿、未知状态、待发与历史；私有存储、格式限制、原owner输入和恢复契约见[附件发送](design/2026-10-10-attachments.md)。

私人 API 同样要求有效登录、同源 Origin 和 CSRF token：

- `GET /api/tasks/:id/history`：最近可见消息、来源、运行状态、是否可发送及本任务 outbox。
- `POST /api/tasks/:id/messages`：仅接受 `{text, requestId, enqueue?: true}`，拒绝模型、权限、cwd 等覆盖字段。
- `GET /api/tasks/:id/messages/:requestId`：查询提交回执，不重新发送。
- `PATCH /api/tasks/:id/outbox/:messageId`：`{text, expectedRevision}` 保存编辑。
- `DELETE /api/tasks/:id/outbox/:messageId`：`{expectedRevision}` 删除待发消息。
- `POST /api/tasks/:id/outbox/:messageId/edit|resume|send`：`{expectedRevision}` 暂停编辑、恢复排队或直接发送。

每次提交先在 Pocket SQLite `dispatches` 表写入请求编号、目标 ID、文本哈希和 pending 状态，真实文本不进入发送账本。已提交的待发正文单独存入 `outgoing_messages`，仅在 Mac 私有数据库中持久保存，接受或取消后清除；不包含在整理备份、公开构建或浏览器持久缓存中。相同编号只能对应相同目标和文本，重复 POST 返回已有回执；同一任务的实际发送串行，发送尚未返回时仍可继续追加待发消息。Python 在发送前两次回读 owner 和状态，使用 clientUserMessageId 与 inheritThreadSettings 提交。

accepted 表示原桌面接口接收，不表示模型执行完成；运行进展通过历史刷新读取。明确拒绝保留草稿供修改/重试。超时或回执不明标 unknown，不自动重发；页面“核对发送状态”只查账本，原 App 历史出现对应 clientUserMessageId 时可确认 accepted。

2026-09-30：普通消息发送的原owner桥接预算为45秒；HTTP约1秒内返回账本状态，仍在核验时为202/pending，网页只GET原编号直至终态。桥接输出无内容的阶段标记，终止并排空stdio后，只有明确停在发送前才报告未发送；已经进入发送、无标记或排空不明仍为unknown。已由原历史确认accepted的结果不能被迟到错误降级。详见 [长会话发送修复](design/2026-09-30-send-reliability.md)。

原接口没有“仅当状态仍相同才提交”的原子条件，最后一次回读与实际提交之间仍有短暂竞态；收到未知结果时应先核对原历史。共享桌面队列和MCP自定义表单尚未接入。原任务重命名、新建/归档、手机附件、同步阻塞问题及命令/文件/本轮权限审批已实现，其边界见对应章节。


## 待发队列的边界

Pocket 与 Codex 桌面的待发列表独立。已安装桌面版本的队列 IPC 会整体替换列表，没有安全的原子追加接口；本实现不读取后重写桌面队列，以免覆盖桌面或其他客户端刚加入的内容。官方行为说明见 [Steering and queuing](https://learn.chatgpt.com/docs/prompting#steering-and-queuing)。

每个任务最多 20 条待发消息，按提交顺序执行。Mac 服务在当前轮 completed、任务可发送时继续；页面关闭后仍可工作，Mac/服务离线时保留待发内容。只要首条在编辑、提交中、失败或结果待确认，自动发送暂停，后续消息不会越过它；用户可以明确选择某条直接发送。待审批、失败/中断的轮次不自动接续。

编辑和删除使用 revision 防止旧页面覆盖新内容；实际发送前原子认领条目。重启时尚未获得结果的 pending 条目标为 unknown，不重放；历史中精确匹配 clientMessageId 后才解除不确定状态。明确未发送的错误可由用户编辑/直接发送重试。若 unknown 长期无法核对，保留条目并在原 App 确认，不能凭超时推断未发送。

## 验证状态

2026-09-28 新增真实公网队列验收：运行中编辑、删除、Steer 及下一轮自动执行均成功，回读两个 completed 回合、准确消息与指定回复，0 工具调用，删除消息未出现，原归档已恢复。私有证据 `.local/qa/queue-live.json`。

2026-09-28 正式登录、历史读取、Markdown 及移动尺寸布局已验证；运行中追加消息漏显已修复。公网 API 向受控原任务提交一次无工具回显，准确 requestId、模型回复和 completed 状态均独立回读，原归档已恢复。该样本证明 API→原 owner→模型→历史链路，尚不等于 PWA 真机表单发送或长期网络可靠性验收。表单/回显、协议发送结构、模型/权限继承及状态竞态另有合成测试。当前部署身份和完整验证状态以 `CURRENT.md` 为准，后续打磨见 `QUALITY.md`。

排序不再被 pinned/recent 视图强制覆盖。偏好版本升级为 2，旧默认迁移为 updated；之后保留用户的显式选择。原版置顶顺序仍可通过「置顶优先」查看。

## 每轮用时（2026-09-28）

历史接口新增 `turnTiming: { turnId, status, startedAt, durationMs, observedAt } | null`，完成回复可带 `turnDurationMs`，单位均为毫秒。桌面字段回源当前安装版本的 `turnStartedAtMs` / `durationMs`；不拿最终回复开始时间当结束时间。落盘回退优先采用 `task_complete.duration_ms`，没有原生时长时仅在同轮开始/结束事件齐全时相减；截断且缺失数据不补猜。落盘运行轮的 observedAt 是最后保存记录的时间，仅显示“已记录”；不会因轮询把旧任务一直计时。

会话顶部表示最近一轮，完成回复下方表示各自轮次；不是全部历史累加（当前历史有数量和字节上限）。运行中每秒仅更新计时组件，网络错误/只读回退停止实时外推，完成后固定为原生总耗时。

## 保存历史的可见性（2026-09-28）

`response_item.role` 是模型输入输出角色，不能单独证明用户发言或用户可见回复。回退读取使用 `internal_chat_message_metadata_passthrough.content_item_kinds` 过滤自动上下文，保留 `user.text`；混合条目按内容项过滤。`compacted.compaction_response_id` 经 `token_usage_record.response_id` 定位内部摘要消息；缺少该关系时仅按 compacted 精确引用的正文匹配。原生 `item_completed` 的 AgentMessage 具有可见性优先权，避免把用户真正请求的总结当内部摘要。没有来源标记的旧记录只识别完整运行时封装，不用 AGENTS、memory 等关键词删除普通讨论。过滤在消息数量/字数截断之前，不修改 Codex 原文件。

## 队列与连接恢复的独立性（2026-09-28）

`canSend` 表示最近桌面快照的接收状态；`canQueue` 表示可把正文存进 Mac 待发列表；`canAttemptSend` 表示可显式调用写侧重新连接并核验后发送，不能把它当已获得实时状态。已知审批/压缩/停止未确认、桌面接口不兼容和不可用原任务不会开放直接发送。未知回执仍不自动重放。

UI 仅在实际离线、输入为空、操作提交中或相应能力被明确禁止时禁用；原 owner 读取失败后默认保存为待发，不发送未验证的缓存状态。当前数据仍来自保存历史时说明连接恢复后发送。初次 owner 读取 2 秒回退；一分钟内的后续读取给10秒预算（09-30修复后），最多保存 40 个最近读取记录。前 3 次回退后 2 秒再读，持续不可用时回到 8 秒，后台暂停规则不变。

2026-10-05：明确连接/提交触发一次按任务合并的桌面接入，45秒内退避核对 `resumeState=resumed`；普通历史和队列轮询只读，不反复打开桌面。连接状态通过独立小响应读取，失败不影响草稿；新鲜实时状态可清除旧失败提示。已连接但待审批仍保持原发送限制。

2026-09-29：当前原版界面在聊天执行中禁用手动压缩（安装版本 26.903.71938:8576 的 composer.compactSlashCommand.disabledInProgressToast），Pocket 保留这一条件。有待发消息不再是禁止压缩的理由，服务端以发送互斥锁及压缩请求账本优先暂停出队。历史暂时回退时 canAttemptCompact 允许显式重新连接并核验，只有原 owner 新鲜空闲状态才真正发起。旧 completed 回执仅留作去重，不再常驻显示；当前观察到的完成转移只提示 3.5 秒。pending/accepted/unknown 和错误继续可见，未知结果不自动重试。

2026-09-29 文案精简：上下文弹层仅保留一行用量和压缩按钮。执行中/压缩中由按钮表达，实际失败与待核对用短状态保留；协议与可用条件不变。输入占位引导清除，但字段标签与 aria-label 保留。

## 更多审批与阻塞问题（2026-09-29）

新增文件改动审批、命令附带的网络/额外权限说明、仅本轮权限授权、同步阻塞式 requestUserInput 回答。Python 在第二次 owner 快照上匹配完整请求指纹；文件审批指纹还包含实际 changes/diff，变更后拒绝旧响应。没有完整改动或含会话范围 grantRoot 的文件请求不提供允许按钮。权限只提交当前请求的权限内容，固定 scope=turn；拒绝提交空权限。

问题使用 thread-follower-submit-user-input 返回原请求，不发成普通 query；答案正文不写入响应账本，只保留哈希。明确 rejected 后的新用户操作使用新响应 ID；pending/unknown 仍只核对，不重放。MCP 自定义表单及其他未支持类型显示需在 Mac 处理，不伪装成普通命令批准。

自动与隔离 UI 验证覆盖文件 diff 改变、权限不扩展、问题精确 ID 与答案、重复响应、过期请求及未知回执；实际新类型审批尚待真实请求出现时验收。
