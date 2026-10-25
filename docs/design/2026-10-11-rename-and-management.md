# 重命名与管理减法

2026-10-11，方帅要求支持会话重命名、删除分组与安排，并移除详情右上角重复的“··· 管理”。实际发布身份和最终验证结果由 [CURRENT](../../CURRENT.md) 维护。

## 交互

详情只保留“会话 / 管理”两个页签；管理页提供重命名、归档/恢复与接续说明。删除右上管理按钮、自定义分组树、安排视图、分组拖动、回顾日期、相关行标签及只服务这些操作的批量选择。

原项目筛选、目录记忆、Pocket 置顶、运行/待输入状态、附件与草稿继续使用。旧导航偏好中的 group/active/later/reference/unassigned 回到全部会话，保留有效的排序设置。保存接续说明只提交 note 与 expectedRevision；旧分组、安排与备份仍在本机保存，未做数据删除迁移。

改名先读取原名称与指纹，保存后显示同步状态，成功后更新详情和列表。冲突保留输入，重新读取最新名称后才能再次提交。关闭未决对话框不会取消已登记操作；重开恢复原 requestId 并核对。网络丢失或未知结果仅 GET 核对，绝不自动重发改名 POST。已归档会话先由用户明确恢复后再改名。

名称 trim 后为 1–220 个 UTF-16 单元，与当前来源标题边界一致；拒绝控制字符、换行与段分隔符。emoji 等补充平面字符占两个单元。

## 原会话与并发

使用当前版本门槛内的官方 CLI 短生命周期 app-server，只允许 initialize 与 thread/name/set，不 resume/start 任务、不开始模型轮次，也不接管既有 writer。Pocket 对 Codex SQLite/global JSON/rollout 仍保持只读。

此前缺口在于原桌面 follower 未提供改名转发。此次隔离验证确认 metadata-only name/set 可在另一原 owner 持有 writer 时写入名称；真实受控对象的原 owner 和原生 read_thread 均回读到同一个新标题，因此不需要 Pocket 别名或自创标题广播。

`server/rename.mjs` 在 Pocket SQLite 的 rename_operations 保存幂等回执。POST 先持久登记并及时返回 pending；同 requestId/同 payload 返回原回执，异 payload 拒绝，同线程只允许一个未决改名。进程重启后 pending 转 unknown，通过官方 inspect 读取持久结果，不重放写入。已有写入子进程明确停止的证据时，显式GET确认原名和指纹完全未变，可结案为未生效并允许新请求；确认外部改名则返回冲突。停机证据不足仍保留unknown，提交前的旧inspect不能用来判定新操作。`thread_metadata_changed` 保留不确定状态，不能仅因标题相同而判成功。标题写入及来源同步都确认后才 succeeded。

改名与同线程/受影响子树的归档、恢复互斥；不会因改名阻止原任务发送和排队。归档中的 writer 等待仍遵循既有生命周期契约。官方 API 当前不能直接改已归档任务名称，界面不得为改名偷偷恢复原会话。

来源同步发现标题变化时递增 titleRevision。读取目录与单任务时同一事务取得标题和版本；前端仅合并改名所拥有的 title/titleRevision，并分别保护较新的标题和置顶，避免旧的说明保存、打开或目录结果倒退状态。

## 验证入口

- `.local/qa/rename-2026-10-11/`：官方隔离 home、writer 互斥探针、原 owner 与原生工具独立回读；测试会话名称和归档恢复回执。
- `.local/qa/rename-ui-2026-10-11/`：合成浏览器视觉/交互，API 回执为拦截模拟。
- `.local/qa/rename-integration-2026-10-11/`：实际 HTTP/RenameService/SQLite 与注入原生适配器联调，单独验证真实后台集成。

自动化和桌面手机尺寸浏览器结果不代表 iPhone 真机手感或长期网络稳定性。此改动不需要启动真实模型轮次。

2026-10-11真实Pocket API验收：改名和恢复各一次POST均succeeded，原生read_thread与list_threads返回新名，最后原owner快照也同步；owner、idle/resumed及10个轮次保持。前次约31秒、本次约72秒才观测到owner新标题，期间原生list读取也可能触发刷新，不能确定固定同步时长或承诺即时显示。原生GUI因工具安全限制未观察，不绕过；验收对象已恢复原名和归档。

公网验收使用真实Service Worker：11项登录、管理入口、归档限制、320px、退出后401检查通过，0任务写入/消息发送；屏蔽Service Worker的初次隔离测试曾在退出等待超时，未修改产品退出逻辑。发布只上传一次，OAuth 401发生在上传前并通过原Wrangler续期恢复。两个本轮合成fixture进程与临时目录已清理。

## 2026-10-25：快速清空名称

欧吉安要求重命名时一键清空原标题。名称输入框右侧增加轻量的清空按钮，仅非空时显示；复用现有IconButton和X图标，不新增工具栏。清空后保留同一输入节点并聚焦，触摸已有焦点时不先转移焦点，便于直接输入新名称。

清空只修改本地编辑值，复用手动输入的错误/终态清理逻辑；原标题、指纹和已提交操作保持原契约。读取、提交、pending/unknown或不允许改名时，清空按钮与输入框一同禁用。空白名称不能点击保存；放弃未保存修改仍经现有关闭确认。原生改名与回执协议未改，只需发布共享网页。

完整1344项回归与构建通过，Chromium/WebKit共73项交互与几何检查通过。WebKit曾在阻止pointerdown默认动作时吞掉tap后的click，已改为只在mousedown阶段保留已有焦点；补充探针确认tap清空且blur/focusout为0。该证据不代表iPhone系统键盘实测。验证证据保存在 `.local/qa/rename-clear-2026-10-25/`。

源码 `7dbd322a2e7d51e901636bd891f20e180bf7bf99` 已发布，共享网页build为 `cf36bd66b748436e26bf8a6a470c94b6b7d1f44cd48040cb70e10eea8ed84e39`；Pages部署 `68c9419f-c03d-4131-be79-5cf584708d6f`，29个资源和功能回读通过。一次上传，预检401在上传前通过既有Wrangler续期恢复；没有重启两机服务或操作真实会话。浏览器与临时fixture进程已关闭，当前版本入口见CURRENT。
