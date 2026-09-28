# 会话历史与网页 query

2026-09-28 用户追加需求：移动端排序可切换、默认最近活动、打开任务查看最新历史，并从 x.fangs.cc / threads.local 向原任务发送 query。

## 使用

任务详情默认进入「会话」，「整理」保留原来的说明与分组编辑。历史按时间由旧到新排列，首次进入定位最新消息；切回近期会话保留内容和阅读位置，手动向上阅读时不会强制拉回底部。页面可见时，运行中每次读取完成后 2 秒再读，空闲 8 秒；实际间隔还包括网络与桌面读取耗时。后台暂停，重新可见或联网后立即更新，也可手动刷新或跳到最新。

窄屏详情可从左边缘向右滑返回列表，未发送 query 草稿仍保留。手势须从详情左侧 32px 内开始；输入框、链接/按钮、代码块/表格、选中文字和多指手势不触发返回。关闭按钮继续可用；不改写浏览器的历史导航。软件键盘打开时，详情跟随可见视口的高度和偏移，收起顶部任务摘要，为输入区腾出空间；关闭键盘后恢复。

显示桌面当前已加载的最近历史，最多 80 条可见消息；完整历史、工具详情和审批继续在原 Codex 中查看。消息正文支持 CommonMark / GFM：标题、粗体/斜体、删除线、列表/任务列表、引用、链接、表格、行内代码和代码块。长代码与宽表格仅在消息内部横向滚动。Mermaid 暂按代码块显示；没有加入语法高亮或图表执行器。

Markdown 通过 React 节点渲染，不执行原始 HTML；链接仅允许 HTTP(S)/mailto，外部链接新页打开且不携带 referrer。本机文件路径保留显示文字，不作为网页路由打开。Markdown 图片显示说明和可点击的外部图片链接，不自动加载第三方资源；原 App 附件仍为占位提示。不会读取隐藏推理或系统/开发者指令。渲染只改变展示，不修改消息原文；组件按文本 memo，历史刷新和输入时不重新解析未变的消息。

任务在 Mac 已加载且空闲时可以发送文本 query，最多 16000 字。运行中、待审批/输入、已归档或不兼容版本保持不可发送。未加载的原任务可以从网页点「连接 Mac 中的原任务」调用既有 deep link，然后刷新状态；不会创建新任务。

query 会在原任务的工作目录和权限中执行，模型/推理设置由原任务继承。网站访问口令不变；持有访问口令者现在可以向满足条件的原任务提交消息。网页不自动回答审批请求，也不覆盖权限或模型。

## 数据与协议

`server/desktop.mjs` 从已导入的 ID 查找目标，调用 `bin/desktop-bridge.py`；后者复用 FBT `experimental/codex-retry/scripts/app_ipc.py` 的长度前缀 Unix socket 客户端。身份为 `codex-navigator`，不改变 FBT 重试守护策略或配置。

已只读核验的桌面版本是 `26.903.71938:8576`；使用 initialize v0、owner discovery v1、following v1、snapshot v11、follower start turn v2。`config/desktop-bridge.json` 固定版本与依赖路径。App 升级或协议变化后发送关闭，需要重新核验。它是版本限定的内部协议，不是官方承诺稳定的公共 SDK。

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 已核对 `thread/read`、`turn/start`、`turn/steer` 与审批生命周期。本项目使用现有桌面 owner 的 IPC，不启动另一个 app-server 读写同一任务。

有 owner 时读取原 App 的 canonical turnHistory，提取 userMessage、已接受的 steeringUserMessage 与非 analysis 的 agentMessage。运行中追加的用户文本单独显示；其 serverUserMessageId 已成为普通 userMessage 时去重。只读取追加消息的输入、标识和时间，不暴露 restoreMessage 中的上下文。这里支持查看桌面追加消息，网页发送仍不支持 steer。无 owner 时通过只读 SQLite 定位 rollout，校验真实路径必须在 Codex home 的 sessions/archived_sessions 内且 session_meta ID 相同，再读取文件尾部至多 4 MiB。只保留 user/assistant 可见文本，单消息至多 24000 字，总量至多 160000 字。页面标明“已保存的历史”或实时状态，不把落盘副本当成实时运行状态。

后端最多短时复用 10 条任务的历史：未完成的读取合并为一个请求，完成后活动快照 750ms、其他 3 秒过期。浏览器本次登录内最多缓存 10 个已访问任务的历史与阅读位置，切回先展示缓存，成功复核前保持发送禁用；退出后随 App 卸载清空。历史不保存到任务架数据库、KV、浏览器持久存储或 Service Worker cache。分组/说明仍独立存储。未发送的 query 草稿只保留在当前登录页面内存中，可在任务与标签切换后取回；刷新前提示未发送文本。

历史请求一次只运行一个，离开页面会取消；18 秒仍无响应则结束等待并有界退避重试，断网时保留已读内容并提示恢复方式。发送操作不使用这套自动重试，仍按下文 requestId/回执处理。

## 发送与重复提交

私人 API 同样要求有效登录、同源 Origin 和 CSRF token：

- `GET /api/tasks/:id/history`：最近可见消息、来源、运行状态、是否可发送。
- `POST /api/tasks/:id/messages`：仅接受 `{text, requestId}`，拒绝模型、权限、cwd 等覆盖字段。
- `GET /api/tasks/:id/messages/:requestId`：查询提交回执，不重新发送。

每次提交先在任务架 SQLite `dispatches` 表写入请求编号、目标 ID、文本哈希和 pending 状态，真实文本不进入账本。相同编号只能对应相同目标和文本，重复 POST 返回已有回执；同一服务进程中同一任务并行提交被拒绝。Python 在发送前两次回读 owner 和状态，使用 clientUserMessageId 与 inheritThreadSettings 提交。

accepted 表示原桌面接口接收，不表示模型执行完成；运行进展通过历史刷新读取。明确拒绝保留草稿供修改/重试。超时或回执不明标 unknown，不自动重发；页面“核对发送状态”只查账本，原 App 历史出现对应 clientUserMessageId 时可确认 accepted。

原接口没有“仅当状态仍相同才提交”的原子条件，最后一次回读与实际提交之间仍有短暂竞态；收到未知结果时应先核对原历史。当前不支持向正在运行的 turn 追加 steer、新建任务、上传附件、停止任务或远程审批。

## 验证状态

2026-09-28 正式登录、历史读取、Markdown 及移动尺寸布局已验证；运行中追加消息漏显已修复。公网 API 向受控原任务提交一次无工具回显，准确 requestId、模型回复和 completed 状态均独立回读，原归档已恢复。该样本证明 API→原 owner→模型→历史链路，尚不等于 PWA 真机表单发送或长期网络可靠性验收。表单/回显、协议发送结构、模型/权限继承及状态竞态另有合成测试。当前部署身份和完整验证状态以 `CURRENT.md` 为准，后续打磨见 `QUALITY.md`。

排序不再被 pinned/recent 视图强制覆盖。偏好版本升级为 2，旧默认迁移为 updated；之后保留用户的显式选择。原版置顶顺序仍可通过「置顶优先」查看。
