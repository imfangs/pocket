# 数据与接口

## 所有权

`server/source.mjs` 是 Codex 桌面只读适配器；`server/store.mjs` 管理 Pocket SQLite；`server/index.mjs` 提供本机 HTTP；React 按导航、列表、接续详情和对话框组织。

已核验来源：原ChatGPT App 26.903.71938 (8576)、Core 0.153.4；2026-10-10新增App 26.1007.21159 (20052)、内置CLI 0.162.0-alpha.17.2，见[升级兼容验证](research/2026-10-10-desktop-upgrade-compatibility.md)。原 `state_5.sqlite` 的 `name` 优先于初始提示词形式的 title；项目和 pin 顺序以桌面 global state 的明确映射为准，兼容 app-server project ID 到旧 saved-project ID 的迁移映射。cwd 只作为来源说明，不自动覆盖明确项目归属。

源 SQLite 用 `readOnly:true` 和 query_only，global state 仅 readFile。扫描本机 CLI/桌面/独立执行来源，排除标明 subagent 的记录；不用 `has_user_event` 推断有效任务，因为本机该字段不具备筛选效力。最近可见历史按需读取而不持久导入；不提取模型总结，不读取云端或其他 remote host 的任务。手机访问通过口令保护的 HTTPS 转发，见 `docs/MOBILE.md`。历史与 query 桥接、状态限制及防重语义见 `docs/CONVERSATION.md`。

`source_threads` 缓存来源元数据；`annotations` 存意图、备注、回顾日期、组 ID、最后打开时间和编辑 revision；`groups` 存独立树。`pin_overrides` 仅在 Pocket 保存用户明确设置的置顶/取消置顶及顺序，不写 Codex 原 pin。未设置的任务继续沿用 Mac pin；设置后来源同步不覆盖，新增 Pocket pin 以递减负顺序排在原 pin 前。同值重试不改变顺序或写入时间，原任务更新时间保持不变。目录与单任务返回统一采用有效 pin。默认继承来源分组只在 sourceProjectId 非空时成立，手动分组不会捕获全部无项目任务。用户明确的空组数组表示取消归组，以后同步不重新附加。

首次成功导入才建立来源分组。分组删除不会在下一次同步重建；子分组上移、任务和备注保留。源失败保留上次快照；源中消失的 ID 标记 missing，仍保留接续数据，重新出现后恢复来源关联。

2026-10-11 起，网页只使用接续说明；自定义分组、手工安排/回顾日期及批量归组入口退休。上述旧表、兼容 API 和备份结构仍保留；保存说明只发送 `note + expectedRevision`，不将隐藏字段重置。原项目筛选独立于旧分组继续使用。

## 写入和恢复

每条编辑带 expectedRevision，冲突返回 409；批量操作是一个事务，任一无效任务/分组使整个批次回滚。成功编辑与分组操作后写本机 JSON 备份。导入先验证版本、ID、引用和树无环，再备份、事务恢复。数据库和 JSON 备份使用私人文件权限。

版本 1 备份新增可选 `pins` 数组，包含 `{thread_id,pinned,position,updated_at}`；`pinned` 为布尔值，置顶的 `position` 为唯一负整数，取消置顶为 `null`。新导出始终包含该数组；导入旧备份未含 `pins` 时保留当前 Pocket 置顶，显式 `pins: []` 清除全部 override 并重新沿用 Mac 状态。置顶、分组和说明在同一恢复事务内更新；来源中暂不存在的置顶记录保留，来源再次出现后生效。

所有有效任务返回 `pinSource: "pocket" | "codex"` 和持久的全局 `pinRevision`：每次实际修改置顶、显式恢复不同的 `pins` 记录，或来源同步改变未 override 任务的有效置顶/顺序时递增；重复同值、相同备份、来源其他字段变化保持编号。清空 override 也保留并递增编号，备份不能将编号倒退。前端可用它避免迟到的任务/目录响应覆盖较新的置顶字段；未知请求的只读核对还须确认 `pinSource` 为 `pocket`，不能把 Mac 原状态同值当作本地操作已完成。该编号不代替说明编辑的 `revision`。

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
- `PATCH /api/tasks/:id`：网页发送 note、expectedRevision；intent、reviewAt、groupIds 仅保留旧客户端/备份兼容，拒绝其他字段。
- `GET /api/tasks/:id/name`：读取原会话显示名称、名称指纹、可改名状态和未决回执。
- `POST /api/tasks/:id/name`：`{requestId,name,expectedName,expectedFingerprint}`，持久登记后返回 pending；官方原会话写入与来源同步确认完成才 succeeded。
- `GET /api/tasks/:id/name/:requestId`：只读核对改名回执，未知不重放，详见[重命名契约](design/2026-10-11-rename-and-management.md)。
- `POST /api/tasks/:id/pin`：仅接受 `{pinned:boolean}`，设定 Pocket 置顶并返回确认后的有效任务；重复同值幂等，不调用原桌面、不改变原会话的运行或归档状态。
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
