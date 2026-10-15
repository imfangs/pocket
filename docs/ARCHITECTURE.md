# 数据与接口

## 所有权

`server/source.mjs` 是 Codex 桌面只读适配器；`server/store.mjs` 管理 Pocket SQLite；`server/index.mjs` 提供本机 HTTP；React 按导航、列表、接续详情和对话框组织。

已核验来源：原ChatGPT App 26.903.71938 (8576)、Core 0.153.4；2026-10-10新增App 26.1007.21159 (20052)、内置CLI 0.162.0-alpha.17.2，见[升级兼容验证](research/2026-10-10-desktop-upgrade-compatibility.md)。原 `state_5.sqlite` 的 `name` 优先于初始提示词形式的 title；项目和 pin 顺序以桌面 global state 的明确映射为准，兼容 app-server project ID 到旧 saved-project ID 的迁移映射。cwd 只作为来源说明，不自动覆盖明确项目归属。

源 SQLite 用 `readOnly:true`、query_only 与一致读取事务，global state 仅 readFile。列表纳入本机 `vscode/cli/app` 用户会话，按已核验的桌面来源规则排除后台 `exec`、隐藏内部任务和子代理（含 `thread_spawn_edges` 子节点）；不用标题或 `has_user_event` 推断有效任务。桌面 `local_thread_catalog` 用于比对，不能当强制白名单：新建会话同步可能滞后，归档历史也不在其中。范围与升级边界见[来源范围](design/2026-10-14-desktop-list-scope.md)。最近可见历史按需读取而不持久导入；不提取模型总结，不读取云端或其他 remote host 的任务。手机访问通过口令保护的 HTTPS 转发，见 `docs/MOBILE.md`。历史与 query 桥接、状态限制及防重语义见 `docs/CONVERSATION.md`。

`source_threads`缓存来源元数据；`annotations`保存旧整理字段与revision，`groups`保存兼容分组。`pin_overrides`复用为Pocket优先关注存储：true为关注，false/缺省为未关注；原生置顶从来源独立读取。目录和单会话同时返回`codexPinned`与`pocketPriority`，Rank分别加60/90，可叠加。默认继承来源分组只在 sourceProjectId 非空时成立，手动分组不会捕获全部无项目任务。用户明确的空组数组表示取消归组，以后同步不重新附加。

首次成功导入才建立来源分组。分组删除不会在下一次同步重建；子分组上移、任务和备注保留。源失败保留上次快照；源中消失的 ID 标记 missing，仍保留接续数据，重新出现后恢复来源关联。

明确不属于桌面列表的旧缓存使用 `sourceExcluded`，与 `missing`、原归档状态分离；catalog、搜索、项目入口、计数和运行候选都排除。缓存记录、备注、置顶、队列和回执保留，原归档事实继续同步；按 ID 的既有操作仍可核对。catalog 带排除集合及最小归档事实，防止迟到操作回执把隐藏任务放回列表。前端保留正在阅读或含未完成输入的详情引用，后者可从临时“保留的输入”入口继续处理；内容处理后入口消失。正向重新纳入清除排除标记并恢复原元数据。

2026-10-11 两轮减法后，自定义分组、手工安排/回顾日期、备注编辑/预览及网页备份入口均已退休。上述旧表、兼容 API 和自动备份结构仍保留；旧客户端说明保存仍以 `note + expectedRevision` 更新，不重置隐藏字段。原项目筛选独立于旧分组继续使用。

## 写入和恢复

每条编辑带 expectedRevision，冲突返回 409；批量操作是一个事务，任一无效任务/分组使整个批次回滚。成功编辑与分组操作后写本机 JSON 备份。导入先验证版本、ID、引用和树无环，再备份、事务恢复。数据库和 JSON 备份使用私人文件权限。

版本1备份继续保存可选`pins`数组`{thread_id,pinned,position,updated_at}`，格式不变；true自然成为优先关注，false不再遮住新投影中的Codex标记。缺少pins保留现有偏好，显式空数组清除Pocket优先关注，Codex置顶保持；负position只为旧接口兼容保留，不参与当前Rank。恢复与分组/说明仍在同一事务内，源暂不可用的记录保留。

`pinRevision`为两个独立状态的共享单调版本。实际修改关注、恢复不同pins，或任何原生pin/顺序变化均递增（即使存在Pocket override）；重复同值不变。读取时与来源/私人表处于同一SQLite快照。前端原子合并独立二值与旧pin字段，拒绝迟到或半套投影覆盖；未知关注请求只读核对完整pocketPriority和revision，不向旧接口回退。旧`pinned/pinnedOrder/pinSource`及`/pin`保持原覆盖含义，兼容旧PWA，不能再用这些字段代表新界面的动作状态。详见[独立优先与输入意图](design/2026-10-15-priority-and-composer.md)。

原名称采用独立持久全局 `titleRevision`：来源同步发现显示名称变化才递增；与目录/单任务读取处于同一SQLite快照，备份导入不能倒退。前端逐字段比较 titleRevision 与 pinRevision，保护改名/置顶不被迟到的目录、打开任务或说明保存响应覆盖。它不代替说明的编辑 revision。

服务定期只读刷新来源，前端定期读取目录。原版已归档任务只在归档视图中出现，手工安排不改变原归档状态。运行状态、更新时间不被推断为接续意图。

## HTTP

- `GET /api/health`：公开服务身份，不含来源与任务数据。
- `GET /api/auth/status`、`POST /api/auth/login`、`POST /api/auth/logout`：口令与浏览器会话。
- `GET /api/connection`：认证后查看 Mac 隧道与固定入口登记状态。
- `GET /api/catalog`：任务、分组、项目、来源时间/错误、当前会话 CSRF token。
- `GET /api/task-statuses`：当前原桌面候选会话的短期执行状态；只读、共享、有界，来源与未知状态边界见[列表运行状态](design/2026-10-08-running-status.md)。
- `POST /api/sync`：只读刷新来源。
- `GET /api/tasks/create-options`：当前规范化目录与原项目组合，提交使用精确locationId。
- `POST /api/tasks`：`{requestId,locationId,name?,initialQuery?}`；可创建空任务，或创建后将1–16000字首条消息持久入队。创建与首条发送分别回读，重复requestId不重复创建或首发，见[快速新建](design/2026-10-09-quick-create-and-continuity.md)。
- `GET /api/task-operations`、`GET /api/task-operations/:id`、`POST /api/task-operations/:id/cancel`：生命周期回执与停止核对；`creationStatus`和`initialMessage.status`分开表达已创建与发送结果。
- `PATCH /api/tasks/:id`：旧客户端可发送 note、expectedRevision；intent、reviewAt、groupIds 仅保留旧客户端/备份兼容，拒绝其他字段。
- `GET /api/tasks/:id/name`：读取原会话显示名称、名称指纹、可改名状态和未决回执。
- `POST /api/tasks/:id/name`：`{requestId,name,expectedName,expectedFingerprint}`，持久登记后返回 pending；官方原会话写入与来源同步确认完成才 succeeded。
- `GET /api/tasks/:id/name/:requestId`：只读核对改名回执，未知不重放，详见[重命名契约](design/2026-10-11-rename-and-management.md)。
- `POST /api/tasks/:id/priority`：只接受`{priority:boolean}`，设置独立Pocket优先关注；缺省false与重复目标无写入，返回完整二值投影。
- `POST /api/tasks/:id/pin`：旧PWA兼容接口，保留`{pinned:boolean}`和有效pin覆盖语义；不调用Codex置顶写入。
- `PUT/GET/DELETE /api/tasks/:id/attachments/:uploadId`、`GET /api/tasks/:id/attachments`：私有上传、元数据核对、读取/删除及草稿恢复，见[附件协议](design/2026-10-10-attachments.md)。文件和消息绑定存于独立附件表，不进入整理元数据JSON导出。
- `POST /api/batch`：`{ids,change:{intent?,groupId?}}`，最多 2000 条。
- `POST /api/groups`、`PATCH /api/groups/:id`、`DELETE /api/groups/:id`：旧分组兼容接口，网页不再展示。
- `POST /api/open/:id`：只接受已导入原 ID，调用系统 `open codex://threads/:id`，返回 `handoff_requested`，不发送消息或新建会话。
- `GET /api/export`、`POST /api/import`：仅 Pocket 元数据备份。

所有私人 API 需通过 Cookie 认证；本机 CLI 的独立 bearer 仅直连 loopback 有效。状态变更需相同 Origin 和从 catalog 取得的 `X-Navigator-Token`，登录/退出只要求同源。允许 loopback、threads.local 和本机已登记的精确 tunnel Host；Caddy/cloudflared 在 loopback 转发 HTTPS，服务校验 forwarded proto 并按实际 Host 重建 Origin。无 CORS、无遥测，API 响应 no-store，静态资源和 CSP 限定本站。Pages 只持久保存公开前端与连接地址，私人 API 经 Worker 转发，口令哈希与浏览器会话保存在 Mac。

边缘专用 `POST /api/relay/register` 由 Worker 自己处理，使用独立机器 key 的 SHA-256 verifier，只能续登记当前项目的连接地址。它不转发到 Mac，也不授予任务读取/编辑权限。自 2026-09-28 起，常驻连接器直接调用此接口，不依赖 Wrangler OAuth；只有发布代码时需要 Cloudflare 管理凭据。详细配对和恢复见 `docs/MOBILE.md`。

## 原 App 接续边界

使用官方文档列出的 `codex://threads/<id>`，实际请求含原 ID。系统 `open` 成功只表明交接已受理；独立验证通过原生 Codex 任务接口核对目标由 notLoaded 变为 idle。原 App 的 GUI 自动化读取被工具安全限制，因此未自动确认具体窗口视觉布局。

从内置浏览器跳回原会话可能切换原 App 当前任务，原先的浏览器面板随任务切换；固定 URL 与后台服务继续存在。在独立浏览器窗口使用 Pocket 可以保留并列导航入口。

## 回归

自动测试使用临时 Codex SQLite/global-state fixtures：读前后源文件哈希不变、标题/项目/pin映射、子代理过滤、无项目默认组、同步保留、revision 冲突、层级循环、删除保留、批量回滚、备份恢复、Host/Origin/token 和准确原 ID 交接。浏览器验证详见 `docs/QA.md`。
