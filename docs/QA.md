# 验证记录

日期：2026-09-27。真实 Codex 来源只读；合成测试与隔离实例只写自己的数据。没有向原会话发送测试消息、改写原数据库或修改原版标题/置顶/归档。

## 2026-09-28：会话界面正式发布

- 新前端源码 `a6f8ed6`，Pages 部署 `22c85d18-38d5-449d-a8bd-a6818aeedf6a`。预检查管理 API 401 发生在上传之前，`wrangler whoami` 刷新登录后恢复。上传成功后首次核验主脚本暂时得到旧版 SPA 页面；`resume --publish` 沿用同一部署重新核对全部资源，域名 Active、CNAME/TLS、10/10 文件哈希与匿名保护均通过，未重复上传。
- 正式域名登录/目录/历史/导出 200；匿名目录、导出、历史 401；Cookie 的 Secure/HttpOnly/SameSite=Strict 保持有效，退出后测试会话 401。带有效登录和 CSRF 的空消息返回 400，没有实际提交新指令。
- 最新用户指令最初在 canonical 历史中缺失。只读桌面快照确认该文本为已接受的 `steeringUserMessage`，原解析器仅处理 `userMessage`，并非 Cloudflare 缓存问题。先添加回归复现失败，再修复读取 input、消息标识与时间；排除 rejected 追加消息，并在 serverUserMessageId 已物化成普通消息时去重，不返回恢复上下文。
- 修改后 30 项自动测试通过；正式历史接口返回最新追加文本恰好一次，真实来源仍为 desktop。Mac 桥接按请求启动，修复立即生效；前端构建没有变化。
- CUA 正式站点 390×844：口令登录、选择原任务、会话详情与手动刷新通过；最新追加消息可见。运行状态为 active，发送按钮禁用；输入区位于视口内、字号 16px，scrollWidth=390；浏览器 error 日志为空。分组与说明导出哈希前后一致。测试登录已退出。
- 真实文本 query 的模型执行、手机主屏幕安装、键盘与触摸仍未验收。本次不把消息入口上线或空输入拒绝当作真实发送成功。

私有回执：`.local/pages-site.json`、`.local/pages-site.integrity.json`、`.local/qa/conversation-release-live.json`、`.local/qa/conversation-release-browser.json`。初始漏显证据保留在 `conversation-release-live-initial.json`；回执不包含口令、Cookie 或聊天正文。

## 2026-09-28：固定入口误报 Mac 离线

故障回路：`curl https://x.fangs.cc/api/auth/status` 返回 503“Mac 暂时离线”；直连本机后端与当时的 tunnel 分别返回 auth/status 200、catalog 401。FBT 两服务显示运行，连接文件却为 `connected:true,published:false`。原登记程序使用 Wrangler OAuth，凭据已过期；日志证实 refresh endpoint 返回 HTTP 400，非交互 CLI 退出 1。不能由此推断 refresh 被拒绝的上游原因，但已证实后台对该登录态的依赖导致 KV 15 分钟记录过期。

修复由 `4732c11` 发布：后台以本机专用 256-bit 随机 key 向 Worker 登记；Worker 仅持有其 SHA-256 verifier，固定更新项目 KV 的 origin。不会用网页访问口令或浏览器会话授权登记。连接器健康同时检查隧道与有效登记，错误只显示分类码。

验证：

- 修改前登记测试返回 403 而非预期 200；修改后整套 20 项测试通过，包含续登记、错误 key、Cookie 不能登记、跨站/任意上游/超大 body 拒绝、HTTP 与网络错误、错误回执、健康状态过期检查。
- 正式登记在 `env -i` 的最小 PATH、无有效 Cloudflare 管理凭据且显式设置无效管理 token 时返回 200；该进程没有调用 Wrangler 或读取其配置。
- Pages 新部署 `d4cc76a0-42ef-4c82-8d7f-77e327903b7a`，正式域名 Active、TLS 与 10 个公开文件哈希一致。匿名目录与导出保持 401；登记匿名/错误 bearer/伪造 Cookie 均 401。
- 连接器重启改变 tunnel URL，自动登记于 02:46:15 UTC 完成；FBT `ready:true`。正式域名真实登录、目录/导出、同源 sync 均 200；浏览器显示原有分组和任务列表，重新同步可操作。
- 02:52:08 UTC 后台按定时器自动续登记成功，有效期延长至 03:07:08 UTC，期间没有手动发布地址。实际间隔约 5 分 53 秒，符合每分钟检查且距上次成功至少五分钟的调度方式。
- 12 个分组与接续元数据规范化哈希与修复前一致；没有修改网页口令或撤销用户会话。API 验收创建的独立会话已退出。
- 本机专用凭据文件 0600；实际 key 与 verifier 均未出现在 tracked source 或 dist。原始登录恢复日志只用于临时排障，不进入 Git。

公网请求与进程健康分别回读；一次恢复不证明隔夜、休眠、所有网络条件或真机体验稳定。私有证据 `.local/qa/connection-repair-baseline.json`、`.local/qa/connection-repair-live.json`。

## 手机固定入口验收（2026-09-27）

- `https://x.fangs.cc`：Pages 域名 Active；权威 DNS 与普通 DNS 的 CNAME 均为 `codex-navigator.pages.dev`；正常 TLS 无绕过；10 个公开文件逐个哈希一致。FBT `resume --publish` 回执 `ready: true`，没有重复上传。
- 16 项自动测试通过：在原 9 项基础上增加认证、Cookie 持久化/撤销、失败限流、远程 bearer 拒绝、Worker 转发边界、PWA 文件与真实执行的 Service Worker fetch/install 合成测试。
- 正式 URL 未登录 `/api/catalog`、`/api/export` 返回 401；浏览器口令登录后显示 20 条原版置顶和原有 `side / 游戏` 三条任务。口令与 Cookie 未写入公开制品。
- 登录 Cookie 的 Secure、HttpOnly、SameSite=Strict 均独立回读；同源 `/api/sync` 200，跨站请求 403，远程本机 bearer 401；退出后旧会话 401。浏览器退出并刷新回到口令页。
- 浏览器从重启前的页面保存临时接续说明，本机 API 独立回读成功，再清空并回读恢复。一次公网请求经历 HTTP/3 连接关闭与较长等待后成功，不能把本次通过外推为低延迟或长期连接可靠。
- Node 重启前后整理数据规范化 SHA-256 为 `d95e27a87137a97182c0de326e6740eca52f305d3d395225b6378ac953b15b22`，会话保持有效。连接器重启更换 Quick Tunnel 地址后自动重试登记成功，x.fangs.cc 使用新连接恢复，无需重部署静态页面。
- 390×844 下 scrollWidth=390；触控模拟时说明输入 font-size=16px。受控视觉预览显示详情的固定顶栏/保存栏及居中安装说明可见，截图时详情内容处于滚动位置。安装指引包含 Safari 与 Android 步骤。
- Chrome `Page.getInstallabilityErrors` 为 `[]`，manifest 解析无错误，Service Worker 状态 ready。**未验证真实手机安装、独立窗口登录、键盘/安全区/触摸体验。** 两次桌面断网模拟未得到可靠离线提示，网络均已恢复；离线合成测试通过与真实断网表现分别记录，不宣称真机离线通过。

发布回执 `.local/pages-site.json`，链路回读 `.local/qa/mobile-live.json`，截图 `.local/qa/mobile-*.png`，全部仅保留本机，不进入 Git。测试会话已撤销，临时含 Cookie 文件已删除。完整聊天内容、发指令与新建原任务不在这次 PWA 交付中。

## 自动检查

TypeScript + Vite 构建通过；`npm test` 9 项通过：只读导入及源哈希不变、标题/项目/pin 映射、子代理过滤、同步保留和来源暂缺、revision 冲突、无项目与手动分组、层级循环、删除保留、批量回滚、备份恢复、Host/Origin/token、准确原 ID 交接、中文多词搜索、原版归档后仍可发现明确标记的稍后任务。

## 浏览器验收

使用 Codex In-app Browser / CUA，桌面 1280×720 与窄屏 390×844。先读 DOM/控件状态，截图落盘后经过 FBT safe-image-view 再用 view_image 检查，没有使用独立 Playwright 浏览器替代。

- `https://threads.local` 证书受信任；没有跳过 TLS 校验。
- 从真实界面新建 `side / 游戏` 子分组，三条明确的游戏任务通过多选一次加入；原项目字段各自保留。
- 真实任务临时填写接续说明、稍后意图与日期，保存后同步来源、重载页面并通过 API 独立回读。测试说明/意图/日期已清除，保留有用分组。
- 中文搜索和空结果反馈正常；刷新保留分组。手机页面 scrollWidth 为 390，没有横向溢出；详情为全屏面板，关闭的导航抽屉设置 inert。
- 隔离实例经文件选择器导入正式备份，回读子分组与三条原任务。没有在正在使用的正式整理上覆盖式测试恢复。
- 隔离实例写一条说明后直接切换另一任务，自动保存到正确原 ID。
- 隔离实例通过另一写入方制造 revision 冲突，浏览器保留本地草稿；读取最新内容按钮取回已保存版本，没有静默覆盖。
- FBT 服务重启前后，分组和接续数据的规范化 SHA-256 完全一致。

## 原会话交接

浏览器主按钮实际调用 `/api/open/:id`，收到 `handoff_requested`。另选一条原先 `notLoaded` 的任务，经同一端点交接后，官方 `list_threads` 回读该原 ID 为 `idle`，证明原任务已加载；没有新建对话或发送提示词。

原生 Computer Use 拒绝读取 `com.openai.codex` GUI，工具返回 “for safety reasons”；没有绕过限制。验收边界是原 ID 已加载，未自动核对 App 窗口像素或具体窗口选择。

## 服务与拒绝路径

FBT local 管理常驻进程和 HTTPS，域名解析到 127.0.0.1 与 ::1。实际域名同源 POST `/api/sync` 返回 200；跨站 Origin 返回 403；直接后端伪造 Host 返回 403。源异常使用合成输入验证，没有移走真实 Codex 文件。

## 视觉核对与修复

设计依据为用户的原侧栏截图及 `docs/DESIGN.md`。内置 image_gen 在本会话不可用，未切换付费 API，未声称存在一张“已批准的生图稿”。

| 比较点 | 核对 |
|---|---|
| 布局 | 桌面导航/列表/详情三栏各自滚动；窄屏列表与全屏详情 |
| 文字 | 系统中文字体，任务标题 14px，页面标题 26px；没有营销区和假指标 |
| 色彩 | 白主面、浅灰绿导航、深绿主操作；已提高时间和辅助说明对比度 |
| 分组 | 命名、层级、计数、折叠；原横线仅在本工具隐藏 |
| 状态 | 保存、批量、空态、冲突和恢复有实际反馈；打开只显示已请求，独立回读另记 |
| 响应式 | 390px 无横向溢出，详情关闭和打开原任务控件可见 |
| 文案 | 与规范及真实任务数据核对；批量、错误、备份确认属于必需功能状态 |

实际修复了无项目默认组误匹配、日期输入事件漏记、重复保存请求、原版归档隐藏明确待续任务和窄屏导航键盘访问。浏览器工具的空字符串 fill 不总能触发受控输入事件；已用真实键盘全选/删除验证清空和保存。

测试截图与回执保存在 `.local/qa/`，不进入 Git。长期减少遗漏的实际效果仍需日常使用反馈；没有宣称所有机器、窗口和未来 Codex 版本均已兼容。
