# 数据与接口

## 所有权

`server/source.mjs` 是 Codex 桌面只读适配器；`server/store.mjs` 管理任务架 SQLite；`server/index.mjs` 提供本机 HTTP；React 按导航、列表、接续详情和对话框组织。

已核验来源：ChatGPT App 26.903.71938 (8576)、内置 Core 0.153.4。原 `state_5.sqlite` 的 `name` 优先于初始提示词形式的 title；项目和 pin 顺序以桌面 global state 的明确映射为准，兼容 app-server project ID 到旧 saved-project ID 的迁移映射。cwd 只作为来源说明，不自动覆盖明确项目归属。

源 SQLite 用 `readOnly:true` 和 query_only，global state 仅 readFile。扫描本机 CLI/桌面/独立执行来源，排除标明 subagent 的记录；不用 `has_user_event` 推断有效任务，因为本机该字段不具备筛选效力。此版不导入完整 transcript、不提取模型总结，不读取云端或其他 remote host 的任务。手机访问通过口令保护的 HTTPS 转发，见 `docs/MOBILE.md`。

`source_threads` 缓存来源元数据；`annotations` 存意图、备注、回顾日期、组 ID、最后打开时间和编辑 revision；`groups` 存独立树。默认继承来源分组只在 sourceProjectId 非空时成立，手动分组不会捕获全部无项目任务。用户明确的空组数组表示取消归组，以后同步不重新附加。

首次成功导入才建立来源分组。分组删除不会在下一次同步重建；子分组上移、任务和备注保留。源失败保留上次快照；源中消失的 ID 标记 missing，仍保留接续数据，重新出现后恢复来源关联。

## 写入和恢复

每条编辑带 expectedRevision，冲突返回 409；批量操作是一个事务，任一无效任务/分组使整个批次回滚。成功编辑与分组操作后写本机 JSON 备份。导入先验证版本、ID、引用和树无环，再备份、事务恢复。数据库和 JSON 备份使用私人文件权限。

服务定期只读刷新来源，前端定期读取目录。原版归档只影响普通列表；用户明确标成稍后/推进/参考的任务仍保留在相应视图。运行状态、更新时间不被推断为接续意图。

## HTTP

- `GET /api/health`：公开服务身份，不含来源与任务数据。
- `GET /api/auth/status`、`POST /api/auth/login`、`POST /api/auth/logout`：口令与浏览器会话。
- `GET /api/connection`：认证后查看 Mac 隧道与固定入口登记状态。
- `GET /api/catalog`：任务、分组、项目、来源时间/错误、当前会话 CSRF token。
- `POST /api/sync`：只读刷新来源。
- `PATCH /api/tasks/:id`：intent、note、reviewAt、groupIds、expectedRevision；拒绝其他字段。
- `POST /api/batch`：`{ids,change:{intent?,groupId?}}`，最多 2000 条。
- `POST /api/groups`、`PATCH /api/groups/:id`、`DELETE /api/groups/:id`：导航分组。
- `POST /api/open/:id`：只接受已导入原 ID，调用系统 `open codex://threads/:id`，返回 `handoff_requested`，不发送消息或新建会话。
- `GET /api/export`、`POST /api/import`：仅任务架元数据备份。

所有私人 API 需通过 Cookie 认证；本机 CLI 的独立 bearer 仅直连 loopback 有效。状态变更需相同 Origin 和从 catalog 取得的 `X-Navigator-Token`，登录/退出只要求同源。允许 loopback、threads.local 和本机已登记的精确 tunnel Host；Caddy/cloudflared 在 loopback 转发 HTTPS，服务校验 forwarded proto 并按实际 Host 重建 Origin。无 CORS、无遥测，API 响应 no-store，静态资源和 CSP 限定本站。Pages 只持久保存公开前端与连接地址，私人 API 经 Worker 转发，口令哈希与浏览器会话保存在 Mac。

边缘专用 `POST /api/relay/register` 由 Worker 自己处理，使用独立机器 key 的 SHA-256 verifier，只能续登记当前项目的连接地址。它不转发到 Mac，也不授予任务读取/编辑权限。自 2026-09-28 起，常驻连接器直接调用此接口，不依赖 Wrangler OAuth；只有发布代码时需要 Cloudflare 管理凭据。详细配对和恢复见 `docs/MOBILE.md`。

## 原 App 接续边界

使用官方文档列出的 `codex://threads/<id>`，实际请求含原 ID。系统 `open` 成功只表明交接已受理；独立验证通过原生 Codex 任务接口核对目标由 notLoaded 变为 idle。原 App 的 GUI 自动化读取被工具安全限制，因此未自动确认具体窗口视觉布局。

从内置浏览器跳回原会话可能切换原 App 当前任务，原先的浏览器面板随任务切换；固定 URL 与后台服务继续存在。在独立浏览器窗口使用任务架可以保留并列导航入口。

## 回归

自动测试使用临时 Codex SQLite/global-state fixtures：读前后源文件哈希不变、标题/项目/pin映射、子代理过滤、无项目默认组、同步保留、revision 冲突、层级循环、删除保留、批量回滚、备份恢复、Host/Origin/token 和准确原 ID 交接。浏览器验证详见 `docs/QA.md`。
