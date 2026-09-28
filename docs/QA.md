# 验证记录

日期：2026-09-27。真实 Codex 来源只读；合成测试与隔离实例只写自己的数据。没有向原会话发送测试消息、改写原数据库或修改原版标题/置顶/归档。

## 2026-09-28 18 点轮次：未加载历史等待

- 只读探针：initialize 32ms，未加载任务 owner discovery 10000ms 后 RuntimeError，整次 10032ms；已加载任务 initialize 1ms、discovery 267ms、整次 424ms。应用版本门控未变。请求已有 timeoutMs=2000，但本次核验的桌面仍等满默认期限。
- 先以延迟 owner 回复建立失败用例，旧实现仍返回成功，未及时回退；再给仅 history 操作的 owner discovery 加 monotonic 截止时间和 socket 剩余预算。finally 恢复原超时，完整快照和 send 不受短预算限制。
- 46 项测试通过。三个新回归分别验证读侧约 2 秒结束等待、发送能等待 2.1 秒的 owner（含二次状态回读且只提交一次）、找到 owner 后 2.5 秒的完整快照仍成功。没有对真实任务发送测试 query。
- 公网登录后读取同一未加载任务：2734ms、200、rollout、13 条消息、canSend=false；已加载任务 851ms、200、desktop/active。测试会话已退出，原任务归档状态未改动。
- 正式网页打开该归档任务后最终显示“已保存的历史”、13 条消息与归档说明，发送禁用；一次观察中短暂出现错误状态，但读取错误文本时它已自动恢复，未取得具体错误原因，不把它归因于改动或算作长期可靠性通过。浏览器无 error/warn 日志；测试搜索和视图已恢复。
- 桥接逐次启动，公网回读证明 Mac 侧补丁已生效。无前端改动，Pages 更名部署保持不变，未重复构建或上传。

私有证据 `.local/qa/history-owner-budget.json`、`history-owner-browser.json`。PWA 真机及不同网络下的回退频率仍待持续观察。

## 2026-09-28：Pocket 更名

网页、PWA 安装与离线页面的产品名更新为 Pocket；内部服务、数据目录、Cookie、manifest id 和备份格式沿用兼容值，历史记录保留旧称。公开壳缓存升为 v2。构建和既有 5 项 PWA/认证检查通过，本机浏览器标题/侧栏/安装说明符合新名，控制台无 error/warn。

源码 `b96c77f`，生产部署 `838f2e36-5da2-437d-92fd-b6a0a553c986`；10/10 公开文件、域名/DNS/TLS、匿名保护通过。正式页面 title、apple-mobile-web-app-title、manifest name/short_name 均为 Pocket，manifest id 仍为 `/`，离线页为“Pocket · 等待连接”。私有证据 `.local/qa/pocket-brand.json`。已有 iOS 主屏幕图标的本地名称更新没有做真机验证。

## 2026-09-28：持续打磨首轮

- 用户授权持续优化，新增 `QUALITY.md` 作为问题队列和验收入口，同任务 heartbeat 每日 10:00/18:00 运行，有有效进展才通知。下述受控回显是本日新验收，区别于本文件上方 09-27 的只读基线。
- 选择已完成的相关文档任务，记录原归档状态并临时恢复；只发一条禁止工具/文件/发布/外发的标记回显。公网 messages 约 2629ms 返回 accepted；公网历史观察到同 requestId 用户消息和精确回复约 13111ms，官方任务回读 completed（11197ms）。原桌面快照仅 userMessage、agentMessage 两项，工具数为 0。原归档已恢复，数据库独立回读为 archived=1；没有重复提交。私有回执 `.local/qa/remote-echo.json`。
- 最近历史与阅读位置留在当前 App 登录实例内，最多 10 个任务，不写浏览器持久存储；旧缓存只显示，复核成功前发送禁用。稳定消息 ID 避免窗口截断后按数组下标重建全部 Markdown 节点。
- 读取改为完成后调度，运行中 2 秒、空闲 8 秒；后台/断网停读，重新可见、联网及 pageshow 立即恢复。18 秒超时后有界退避，手动刷新合并，离开任务取消读请求。后端活动快照 750ms、其他 3 秒；未完成的缓存请求复用，防止读取慢于 TTL 时重复启动 IPC。
- CUA 390×844：阅读位置 scrollTop=9812、底部距离 844；关闭详情、对该测试 tab 模拟断网、重新打开，48 条消息和阅读位置不变，显示自动恢复提示、发送禁用。恢复网络后无需操作即回到 active，新增消息仍保持阅读位置；一次后续请求间隔 3578ms，包含网络/桌面耗时。网络模拟已恢复、测试 tab 已关闭，控制台无 error/warn。
- 后端由 FBT local 重启，执行前确认无 pending dispatch，HTTPS/健康回读通过；前后分组/备注哈希一致。43 项自动测试通过，包含调度、后台/网络恢复、超时不死锁、取消、并发合并、缓存界限、阅读位置及原有认证/发送/移动交互回归。
- 发布源码 `0ca2861`、Pages `f6879895-01b9-4124-bc0e-59990ff63bb1`，10/10 文件与域名/DNS/TLS/匿名保护通过。正式历史两次 200、source=desktop、active，耗时 2127/1514ms，间隔一秒后 checkedAt 更新，私人 API no-store，测试登录退出。文件与 API 回读不替代 iPhone PWA 真机和长期网络验收。

私有证据 `.local/qa/feed-browser.json`、`feed-public.json`、`feed-restart-baseline.json`、`feed-restart-after.json` 和发布回执。模拟器及 PWA 的既有边界继续有效。

## 2026-09-28：边缘返回与首次键盘遮挡

- 用户澄清手势为从左边缘向右滑，键盘遮挡发生于 iPhone 主屏幕 Web App。实现只在窄屏详情左侧 32px 接受起点，72px 以上向右位移触发已有关闭动作；保留编辑冲突处理和未发送 query 草稿。输入控件、按钮/链接、表格/代码、选中文字、多指与垂直滚动不触发返回，事件监听不阻止原生滚动或缩放。
- iPhone 16 / iOS 18.2 Simulator Safari 实际软件键盘复现：原详情按布局视口 fixed top/bottom 定位，键盘和页面平移后输入框底部位于 501px，超出 Safari 内容区域底部约 449.7px，发送按钮被挡。截图和 `.local/qa/check-keyboard.py` 断言为失败，不用桌面缩小窗口替代键盘。
- 改为监听 visualViewport.resize/scroll 及 focus/窗口变化，更新详情 height 和 offsetTop；收起键盘期间的顶部摘要并缩小 composer。相同刷新→打开详情→首次输入流程中，输入框底部 396px，断言通过，受控截图确认发送按钮也完整可见。缩放时不应用键盘布局，退出详情移除监听。
- 原生 pan 从 (20,86) 向右 180px、280ms，详情关闭并返回列表；重新打开同一任务保留测试草稿。原生垂直滚动不关闭详情。自动测试覆盖首次 focus 后延迟到达的 viewport resize、Safari 平移、缩放/宽屏/清理以及手势方向、边缘范围、阈值和取消条件。
- 模拟器添加了仅供验证的本机网页主屏幕图标，但启动提示 “In your region, web apps now open in your default browser.”；不能把 Safari 结果写成 PWA 独立窗口或真机通过。物理 iPhone 的 PWA 和 Android 仍待实际反馈。
- `fc6cb66` 发布为 Pages 部署 `4f572bbd-12d2-4253-9d43-2a312fcd715c`，正常 DNS/TLS、域名 Active、10/10 公开文件哈希与匿名保护通过。主屏幕 App 需要重新加载页面才能使用新 JS；本次没有宣称模拟器或文件一致性已证明用户的 PWA 真机问题解决。

本次无测试 query 发送。私有证据 `.local/qa/keyboard-baseline.json`、`keyboard-after.json`、`swipe-edge-back.json`，受控前后对照 `/tmp/navigator-keyboard-comparison.jpg`。

## 2026-09-28：Markdown 渲染发布

- 实际用户流：登录 → 选择原任务 → 会话历史 → 阅读表格和代码。两类消息均渲染 CommonMark/GFM，正文原文及 API 不变。使用 memo 避免每次历史轮询和编辑 query 时重新解析未变文本。
- 构建通过，整套 33 项测试通过；新增三项以实际 React 组件做 SSR，核对标题/强调/列表/任务列表/引用/表格/代码、脚本转义、原始 HTML、危险链接和图片仅显示链接。测试 Vite 环境关闭依赖预扫描，避免服务关闭与扫描竞态噪声；相关三项再跑通过。既有依赖版本未变，新增 Markdown 依赖使用公共 npm registry。
- CUA 本地真实会话 1280×800 和 390×844 通过：页面非空、没有框架错误层、控制台无 error/warn；表格、强调、列表、链接和代码均为实际 DOM 元素。受控截图确认手机双列表格、行内代码与段落可读，底部输入框在视口内；滚动查看表格成功，页面没有横向溢出。
- 前端源码 `a327e5d`，生产部署 `64c50223-0b00-44c7-b3e9-9197504548bb`；正式域名 Active、DNS/TLS、10/10 资源哈希和匿名保护均通过。正式浏览器加载新脚本，口令登录后真实原任务含 22 条 Markdown 消息、1 个表格、3 个代码块，三个代码块均可在内部横向滚动；390px 页面宽度不变、无错误层和控制台警告/错误。
- Markdown 图片保留为外部链接，不自动加载；本机文件路径只展示文字；Mermaid 保留代码展示。未扩展语法高亮、附件读取或 query 执行能力，真机触摸/键盘仍待验。

私有证据 `.local/qa/markdown-rendering-browser.json`，受控预览 `/tmp/codex-navigator-markdown-table-preview.jpg`，桌面与手机原图位于相邻临时路径；截图未上传或纳入 Git。

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


## 2026-09-28 下拉刷新与待发队列

- 构建与 59 项测试通过：原 owner Steer 参数、运行中默认延后、FIFO、编辑暂停及旧 revision 拒绝、取消、并发发送时继续入队、未知结果不重发、重启 pending 转 unknown、历史核对、HTTP 同源保护、触摸方向与点击抑制。
- 真实公网 API：相关受控验收任务运行中入队三条；编辑后一条直接 Steer，删除一条，另一条等 completed 后自动进入下一轮。两轮完成并准确回显；原始 rollout 独立确认 0 function call、删除文本未出现；恢复原归档，生产 outbox=0。凭据和消息只在私有回执 `.local/qa/queue-live.json`。
- 隔离真实浏览器：加入队列、暂停编辑、修改保存、删除、直接发送及自动出队回显通过。合成自动回显另由 API 回读确认，见 `.local/qa/fixture-read.json`。
- iPhone 16 / iOS 18.2 Safari 模拟器：从任务行下拉 190px 松手后同步计数 +1，短拉 30px、横移 110px 均 +0。首次连续手势发现 Safari 在短拉后合成点击误开详情；加入点击抑制后，同组手势留在列表，普通点按可打开。`.local/qa/pull-real.json`。
- 主屏幕 PWA 真机、Android 与长期掉线恢复不由本轮模拟器结果替代。线上部署身份以 CURRENT.md 为准。

- 补充键盘：iOS Safari 首次聚焦待发编辑框后，输入底部 391px，保存/取消按钮底部 447px，受控截图确认均在键盘/地址栏之上；队列操作触控高度 44px。取消编辑和删除后隔离 outbox=0，测试会话已关闭。
- 正式发布：源码 ffd2291 / 部署 b94c2d4e-33a1-48b1-be22-fdf8818b8d19。凭据刷新后单次上传，版本切换后 resume 完成 10/10 文件、DNS/TLS 和匿名保护检查。正式站活动会话加入队列按钮可用，390px 页面宽度一致，控制台无 warn/error；草稿清空，退出登录，恢复 viewport。`.local/qa/queue-public-browser.json`。


## 2026-09-28 上下文与输入框增高

- 67 项测试与构建通过。新增桌面用量口径/缺失字段、压缩 RPC 参数、运行竞态拒绝、压缩中禁止发送、持久请求防重、未知回执重启不重试、队列与参数边界验证。
- 真实公网压缩：受控已加载原任务空闲时压缩，准确完成事件、原始 compacted 记录与用量下降均回读。237904 / 828400 → 6898 / 828400，0 工具调用；恢复原归档。权威回执 `.local/qa/compact-live.json`。
- 浏览器 390px：空白/5 行/30 段/删短，输入高度依次 70/142/240/70px；仅长文 overflow=auto。没有提交测试草稿。`.local/qa/input-autogrow-browser.json`。
- PWA 主屏幕真机和长期恢复仍保留验证边界。部署身份以 CURRENT.md 为准。

- iOS Safari 8 行长输入的初版曾将发送按钮挤出可见区。修复按实际剩余空间扣除其他控件后，输入框 110px、底部 396px，发送按钮底部 444px；受控截图确认位于地址栏和键盘上方。`.local/qa/input-autogrow-ios-after.json`。


## 2026-09-28 网页命令审批

73 项测试通过，新增一次性审批原生参数、id=0、请求复用/命令变化拒绝、会话级放权拒绝、回执防重、未知结果恢复。隔离浏览器 390px 测到按钮高 44px、完整 git status --short 可见，点击后只有一个 accept，卡片消失，无 console warn/error。`.local/qa/approval-ui-browser.json`。真实两个研究任务的审批内容已从原 owner 只读回读；未代用户批准，生产执行回执留待用户真实点击验证。

新建任务按钮探测：App Tools 原生管道 tools/list 即被关闭，桌面日志确认 missing-code-signing-identity；该路径未实施绕过。newThread deep link 仅预填 Mac composer，不算手机端创建成功。

- 正式发布源码 21e75a1 / 部署 a3160d47-8973-4a9d-a388-13326c7c7177：10 文件哈希、DNS/TLS、匿名保护通过。两个真实研究任务在网页分别展示 Apple 登录态检查和 GitHub 查询审批，按钮可用、高 44px，390px 无横向溢出，浏览器无 warn/error；未点击真实允许/拒绝。`.local/qa/approval-public-browser.json`、`approval-public-mobile.json`、`approval-happy-public.json`。验收登录已退出。


## 2026-09-28 消息视觉区分

用户气泡靠右、过程采用灰色虚线时间线、最终回复为白色卡片与绿色侧线，文字和图标共同区分。对 7 条合成消息回读确认 user/commentary/final_answer/final/无 phase 均按预期呈现，旧无阶段消息没有误标成最终。390×844 与 1280×800 无横向溢出，表格可读、代码可独立横向滚动，控制台无 warn/error。构建及 8 项 Markdown/刷新回归通过；没有新增镜像样式实现的测试，没有发送真实 query。证据为 `/tmp/pocket-message-qa.json` 与同目录 `pocket-messages-mobile.png`、`pocket-messages-desktop.png`，这些临时截图不进 Git。

- 正式发布源码 3838ed8 / 部署 69e3de36-48c8-45fd-96ac-32639e1080f9，10 文件哈希、DNS/TLS 与匿名保护通过。正式页面 80 条消息显示用户 15、过程 55、最终回复 10；390px 无溢出，输入区可见，无 console warn/error，测试登录退出。轮询曾使一个 waitFor 定位器失效，后续直接 DOM 回读正常，不视作产品报错。`/tmp/pocket-message-live.json`。


## 2026-09-28 停止执行、异步提问与移动精简

- 87 项测试通过：条件中断不会影响新轮次、接收与 interrupted 分离、未知结果不重试、停止暂停队列、恢复只针对明确中断轮；异步问题沿用原 questionItemId 和回复封装、已回答/变化题目不能重复提交、发送账本防重；原有回归通过。
- 真实公网中断受控原任务：interrupted + idle，待发消息保留且未进入历史；测试条目清理、暂停解除、原归档恢复，0 工具调用。`/tmp/pocket-stop-live.json`。
- 隔离浏览器停止 → 暂停队列 → 恢复排队只记录一次 stop 和一次 resume send，输入区可见；Safari 模拟器实际点击停止后显示已中断。`/tmp/pocket-stop-ui.json`、`/tmp/pocket-stop-ios.json`。
- 移动精简将 390×844 对话区从 373px 提升到 566px。上方大摘要、技术说明和底栏收起，停止/上下文/异常仍可见，压缩可展开访问。旧截图捕获了侧栏过渡帧，不用作前后视觉证据；几何度量和精简后截图保留。`/tmp/pocket-mobile-density-after.json`。
- 异步回答目前以协议、隔离 UI 验证为主；实际选择需由用户作出，未代答归档偏好。PWA 真机仍待验。

异步回答补充验收：选项回答和自由文本各提交一次，均退出待答卡片。iOS Safari 第一次提交曾仅收起键盘；修复为键盘实际收起前保持布局，并记录题卡编辑状态，复测单次点击即提交。输入底部 338px、提交按钮底部 390px，均高于键盘；回执 `/tmp/pocket-question-ui.json`，截图 `/tmp/pocket-question-ios.png`。新增焦点移出但键盘仍遮挡时保持布局的回归。

- 正式发布：源码 ce11eeb / 部署 4a3f4c5d-2c46-49ca-a378-9f4f2e748784，10 文件哈希、DNS/TLS 与匿名保护通过；正式当前任务可见停止按钮及原生异步问题，未选答案前提交禁用，390px 无溢出、无 console warn/error。未点击真实停止或代选归档偏好。`.local/qa/stop-questions-public.json`。

- 2026-09-28 用户从 Pocket 回答归档范围问题，发送账本 accepted；在原 App 精确回读对应 clientMessageId 与答案，待答问题消失。真实网页 → 原任务回答链路通过，证据 `.local/qa/async-question-live-answer.json`。

## 2026-09-28 · Pocket 界面打磨

- 87 项回归测试通过，原生控制/队列/Markdown/移动 viewport 测试未变；最终构建分为入口与 App 两个 JS 块，登录入口 gzip 约 86KB，App 约 90KB。
- 内置浏览器 390×844、320×740、1280×900；任务选择和清除、回到任务保留五行草稿、输入从 58px 增到 134px、上下文 340px 浮层在 390px 内、Escape 关闭与复制成功状态通过。
- 隔离运行任务入队→编辑保存→停止后显示已中断/自动发送暂停→删除通过；独立读取 adapter 调用只有一次 stop，未自动发送已暂停消息。
- 隔离异步选项回答“会话阅读”和自由回答“保持简洁，方便单手操作”均从表单进入 answer adapter，问题列表清空。
- 原生新建分组 dialog 在手机视口 360×438px，焦点位于 group-name，未提交分组。
- iPhone 16 / iOS 18.2 Safari 模拟器，首次点击输入框，输入 y=340/h=51、发送 y=392/h=45；受控截图确认键盘上方可见。没有主屏幕独立窗口真机验收。
- 原始合成截图、测试日志、iOS 坐标见 `.local/qa/polish/`；视觉对照与文案变化见 `docs/design/2026-09-28-pocket-polish.md`。

正式发布：源码 `d1c0a3a` / Pages `ed7eb31f-270e-44cd-a62c-48836e07eddf`；11 文件普通 DNS/TLS 哈希全部匹配，私有 API 匿名 401。正式浏览器 390px 列表 80 条，标题 15px、--accent=#6254c7、默认复选框不可见、无横向溢出。部署回执 `.local/pages-site.json`。

本轮公网原任务返回“已保存的历史”回退视图：6 条过程消息、16px 输入、零横向溢出，无界面错误。显示来源限制并禁止发送，符合已有规则；本轮没有再次验证真实 owner 的执行/停止链路，不把合成操作验证当作真实模型执行。

## 2026-09-28 每轮用时与停止按钮

92 项回归及构建通过。新增协议验证桌面原生 durationMs、运行中忽略旧 duration、缺失时间不补猜；落盘测试覆盖轮间空闲、完成事件缺少开始记录、中断和最后活动时间；UI 测试小时格式及完成后冻结。

内置 Browser 390×844、320×740（触屏 CSS）、1280×900：运行中秒数递增；点停止后固定 3:48，停止调用一次；新轮从 0:00 开始；历史回复保留 2:16。按钮命中区 44×44，布局不重叠、无横向溢出；页面身份、非空、无框架错误、控制台、截图与交互均通过。受控联系表确认深色圆形停止图标、顶部两行轻量状态/用时以及回复下方用时，不挤压输入区。实际 PWA 真机未复测。

正式站资源与匿名保护通过，登录后当前原任务走保存历史回退：显示“已记录”及一条原生完成时长 0:55，发送保持禁用；本轮无真实 query/停止操作。服务重启健康，分组哈希一致；annotations 全量哈希因包含访问记录未取得一致，未将该哈希宣称为备注稳定性验收。发布中管理凭据 401 经 Wrangler 刷新；上传后一个文件曾在切换期返回旧 SPA，沿用同一部署 resume 完成校验，未重复上传。证据 `.local/qa/timing/`。

## 2026-09-28 历史来源回归

用户真实反馈指出上次时长验收中被当作回复的 0:55 实为内部压缩摘要。本轮复现并修复 response_item.role 误分类：按内容 provenance 与 compacted 的 response ID 过滤，保留作者真实消息；消息自身 turn_id 恢复截断历史里的时长归属。97 项测试通过，覆盖混合指令/用户正文、真实 AGENTS 引用、旧完整封装、任意摘要文本、超长摘要、原生可见回复优先和历史截断。

Mac 服务重启成功。真实公网浏览器 390×844 中，AGENTS 注入与内部摘要均消失，原用时请求和正常最终回复保留，正确总用时为 26:21；无横向溢出、无控制台错误。前端版本不变，没有重发 Pages。证据 `.local/qa/history-provenance/`，测试登录退出，临时标签页与测试服务均关闭。

## 2026-09-28 队列按钮与重连

原症状：真实活动任务的 5 次历史读取中 3 次约 2.05 秒返回 desktop_unavailable；分阶段探测 owner discovery 可达 3.589 秒。原 Conversation SSR 中已保存历史让加入队列/直接发送禁用，两项回归先红后绿。103 项测试与构建通过，覆盖慢 owner 重连、首读快速回退、存储独立于执行、已知审批与归档禁止、未知结果不重放、有限快速恢复。

隔离 Browser 390×844 / 320×740：回退时加入队列可用；直接发送调用一次；切到 desktop/idle 后自动队首调用一次；模拟离线禁用，恢复后草稿不丢且可用；明确未发送的失败保留正文和可手动重试按钮。无页面溢出和控制台错误。

公网受控原任务从 rollout 回退状态入队并主动派发成功，准确 marker 和 userMessage 回读，completed 用时 7780ms，0 工具调用；公网 history 也确认回复，outbox=0，原归档恢复。当前真实任务连续四次读取均 desktop/active，canSend/canQueue/canAttemptSend 全 true，分别 3046/4950/1053/4085ms。正式 390px 浏览器加入队列按钮可用、上下文正常、无控制台错误；未向当前人类任务提交测试文字。

源码 41a0a39，Pages 9f08577f-3090-4044-a18f-316dfce6c855，11 文件哈希、DNS/TLS、域名与匿名保护通过。一次上传后资源切换暂不匹配，沿用同一部署 resume 成功，无重复上传。证据 `.local/qa/queue-connection-live.json`、`.local/qa/queue-connection/`。测试登录退出；PWA 真机手感、长时间网络波动不计本次已验。

## 2026-09-29 打开原任务的文案

构建及 3 项会话操作回归通过。隔离 Browser 390×844 在已保存历史状态点击“在 Mac 中打开”，open adapter 仅调用一次，后续变为“可继续”且按钮消失，无旧文案、横向溢出或控制台错误。此次保留已有深链接语义，只澄清按钮文案并使用已有离线状态禁用它；没有触发真实模型或修改原任务名称。

Pages 源码 b9f0ac8，部署 54b30845-f144-4ff8-a389-82aeba0a2427；11 文件哈希、域名、DNS/TLS 与匿名保护通过，公网独立读取 App 资源确认新文案存在且旧文案消失。证据 `.local/qa/open-label/`。未重新验证 PWA 真机手感或真实打开链路；既有链路证据与本次文案验证分开。

## 2026-09-29 最近活动与静默列表刷新

源字段回归先红后绿：updated_at_ms 已更新时，recency_at_ms 仍旧，原导入错误地优先用了后者。改为实际更新时间，旧 schema 使用 updated_at 秒值；来源仍只读。104 项测试和构建通过。

隔离 Browser 390×844 原流程复现：发送后返回显示 3 小时前，手动刷新也不变。修复后在 fake owner 故意延迟 1.2 秒接收，点击发送后立刻返回，约 1118ms 后自动更新为刚刚并排首位，无 toast。另在模拟离线期间更新第二条来源记录，联网后自动同步、搜索词保留、排序更新；手动刷新也显示实际时间。此处耗时为隔离测试，不是公网性能承诺。

源码 c292d3c，Pages 97d357f7-97d7-4e96-b9b7-d2fa1eda2842；11 文件哈希、域名、DNS/TLS、匿名保护通过。公网 API 比较原 SQLite updated_at_ms 和旧 recency_at_ms，返回值覆盖最新 updated，未误用 recency。正式浏览器显示刚刚，并观测返回详情后 POST /api/sync，未弹刷新 toast，搜索保留，无页面溢出或 console 错误。原任务只读验证；没有新测试 query、改名或其他会话操作。证据 `.local/qa/activity/`。
