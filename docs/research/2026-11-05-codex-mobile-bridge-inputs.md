# Codex Mobile Bridge 给 Pocket 的输入

2026-11-05。接续[对外价值与差异化](2026-11-05-pocket-value-and-differentiation.md)，本次追到实际源码，比较已有重叠与可吸收的机制。Pocket 基线 `1c7b1dd`；上游固定 `0721aa7dafa6177751ba7e568e0ad0efee05655b`，本轮核对 main 仍指向它。选取源码通过完整 Git tree 的 blob SHA 校验，保存到忽略目录 `.local/research/bridge-for-pocket-2026-11-05/`。

## Brief 与判断

[Codex Mobile Bridge](https://github.com/try2love/codex-mobile-bridge) 是自部署的桌面 Agent 手机网关：桌面启动器、Web 与手机壳连接原电脑上的 Codex/Claude/DSH，并扩展本地/SSH/WSL CLI、文件与终端。其 Codex Desktop 路线也通过原会话 owner 和 follower IPC 执行；CLI 无现成 owner 时，显式继续才走原生 daemon/恢复。它与 Pocket 的关系比“通用远程 Agent 平台”更接近。

**优先吸收发送确认的证据边界和长会话兼容用例；对外 Alpha 借鉴入口诊断与设备配对。** 持续连接/增量补丁是值得测量的架构候选，多 Agent、桌面大工作台和完整终端暂缓。它没有解决我们所有原桌面控制缺口，不因此迁移后端或扩产品范围。

## 1. 优先补强：展示输入不能直接确认发送

上游[持久输入身份提取](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/features/sessions/store.py#L28)和[回执核对](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/app/service.py#L2251)把来源分开：仅根据同线程保存的原生用户项/持久输入 ID，将已有 unknown 改为 accepted；不凭展示正文、助手回复或准备中的 turn 推断。保存账本失败时回退 unknown。[10-30恢复记录](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/.agents/notes/implemented/bug-fix/2026-10-30-desktop-ipc-rebuild-and-send-receipts.md#L59)解释了原生 follower 超时但输入已持久化的具体问题；记录中的实机与网络结果是上游证据，未在本机重跑。

Pocket 已有 requestId、unknown 不重放、原会话归属和草稿保护；无需重做账本。但本轮发现一个具体的条件性缺口：

- [history投影](../../bin/desktop-bridge.py)在 turn 没有原生 userMessage 项时，用 params.input 生成可读用户行，并携带 params.clientUserMessageId。这是展示兼容行为。
- [loadHistory](../../server/desktop.mjs)随后依据这些行的 clientMessageId 更新 dispatches 为 accepted，并尝试移除同 ID 待发条目。其确认入口没有区分“原生消息项”与“从 params 合成的展示行”。send 的已有编号判断也存在 params-ID 路径，后续修复不能只覆盖列表展示。
- 初始隔离探针给定只有 params、没有 userMessage 的 inProgress turn：实际 Python history 函数输出带编号的用户行，实际 JS loadHistory 在 stub store 上发出了 accepted 更新及出队 SQL。独立复核指出初始fixture缺少真实入口字段、stub未执行SQL；随后补齐host/runtime/requests/model等字段，通过原始snapshot envelope、describe及身份校验，再用内存SQLite中的匹配unknown/待发行运行实际loadHistory，确认回执变为accepted且对应待发行被移除。上游持久身份提取函数对同一仅params输入返回空集合。

这证明源码路径可以将仅params投影用作回执证据；items为空也可能是分页或尚未物化，不能据此证明原生未持久化或发送失败。没有验证真实原生生产该状态时的持久化时序、出现频次、已发生消息丢失或任何既有用户回执需要修改。因此保留为条件性回执风险，不称已发生的现实故障。修复候选是给投影和确认建立不同证据字段，在成功原生响应、明确原生用户项或同线程持久ID上核销；先核对原生生产者契约。展示、草稿交接和防重仍保留；弱证据不能触发重发。

最小后续验收：prepared-only 不核销；原生确认或持久精确 ID 能核销；accepted steering 与排队状态分别验证；跨线程同 ID、未知与较新草稿保持；不重复发送。**本轮仅复现，没有修产品或核销真实账本。**

## 2. 优先验证：超大桌面快照与重复连接成本

上游 [DesktopIPC](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/clients/codex/ipc.py#L17)采用持续连接、1MiB接收分块、256MiB接收帧上限，并将发送预算独立保持64MiB。[历史/控制分离记录](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/docs/architecture/history-control-separation.md#L43)报告一次真实 owner 首帧约94.6MB；这是作者环境的测量，不是 Pocket 测量。它也明确承认：手机先看最近页，并没有消除首次全量 owner 快照。

Pocket 已做历史分页、缓存、条件请求和预取，这些不需重新立项。但当前分发的 [AppIPC](../../vendor/codex-bridge/app_ipc.py)直接拒绝超过64MiB的帧；[runBridge](../../server/bridge-process.mjs)每次派生短生命周期 Python 客户端。HTTP 304和手机历史分页并不自动减少上游首次 IPC 快照的成本。

本轮使用同一合成 JSON 帧、内存字节流和两边原始接收代码：小帧两者均能接收；65MiB正文（总帧68,157,515字节）被 Pocket 以 `unsupported_app_protocol:frame` 拒绝，而 Bridge 的接收层成功交给回调。没有真实 socket/会话、模型调用或全产品运行；这个结果只证明适配器的帧边界，不能把256MiB接收成功当作完整会话可控或内存性能更好。

最小后续验收：先用受控长会话量取 IPC 原始帧、重复读取耗时、峰值内存与首次可读正文时间；保留可解释上限。再比较短连接与小范围持续订阅/增量状态复用。大帧、补丁baseRevision失配、断线重建、慢会话与无关会话隔离必须覆盖。单纯把64改为256还会扩大解析内存，不作为未经测量的完整解决方案。

## 3. 借鉴：从入口到正确实例的诊断

上游的[公开入口探测](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/features/network/access.py#L413)拒绝重定向、限制响应大小、区分 HTTP/TLS/连接失败，并[核对实例ID](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/features/network/access.py#L442)。[连接界面](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/desktop/features/connections/connections.js#L122)根据代理位置解释上游地址和下一步。

Pocket 已有 setup、doctor、安装文档和真实部署回读；doctor仍将 control/mobileConnection明确报为not_checked。最有价值的增量是让陌生人知道：环境准备、本机API、公开入口、入口指向的实例、原桌面控制分别过了哪一关，以及失败下一步。可先补命令诊断结果与安装文案，不需要新桌面工作台。

最小验证（待做）：正确/错误实例、302、403、证书错误与超时的合成响应；核对分类和恢复提示。电脑访问成功不等于手机蜂窝网络可达，实例 ID 也不是认证凭据。最终仍需要新 Mac 和手机入口验收。

## 4. 条件性采用：一次性扫码与单设备撤销

[配对代码](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/features/auth/pairing.py#L26)将 grant 绑定入口，300秒到期，一次兑换；刷新使旧 grant 失效。[认证代码](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/features/auth/auth.py#L252)记录登录并支持单项撤销。

Pocket 已有口令、随机会话、退出和口令轮换全撤销。独立用户使用多个手机/浏览器后，扫码减少初装输入，单项撤销避免为了移除一台设备让所有设备重登。可借这些机制，保留自身会话期限，不照搬仅凭User-Agent认定可信手机而取消到期的策略。

最小验证（待做）：过期、错入口、重复兑换、刷新撤销、只撤销指定登录；已有Cookie、数据、草稿和其他机器路由保持。它是开源采用成本的优化，不是当前个人部署必须立即增加的功能。

## 5. 作为架构候选：持续连接的正确重建

[rebuild_connection](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/bridge/app/service.py#L1856)只替换 Bridge 自己的 follower 连接，等待已有写操作、重新初始化并订阅；旧 reader 退出前核对 socket身份，不能清掉新连接。源码包含[旧路由仍活着但已退役的回归用例](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/tests/test_ipc_recovery.py#L48)。这不是重启原 Codex，未知写入不重放。

Pocket 目前每次调用新建短连接，不直接拥有同一种长期旧socket状态；前端也已有代次和迟到响应保护。因此不因它有rebuild按钮就新增按钮。若采用持续订阅，上述旧路由/旧回调/阻塞写关闭的场景应先进入验收；当前可借其分层诊断，让用户区分网络入口不可达、API不可达和owner不可达。

## 明确不能从它获得的结论

- **App owner归档仍受限。** [上游归档说明](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/.agents/notes/implemented/feature/2026-10-27-confirmed-disconnect-archive.md#L54)明确：移除 follower 不能释放 App 自身writer，没有已验证的follower归档/卸载操作。其CLI/WSL同运行时停止与归档不能解决 Pocket 的原桌面占用问题；不把“不支持”改成强停App。
- **网关队列不是桌面统一队列。** [消息管理](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/docs/message-management.md)管理由网关持有且尚未交付的条目，不证明能同步原桌面所有待发输入。
- **未读仍有独立语义。** 文档说明标记/已读在浏览器，进入会话清完成标记，不是修复原生桌面蓝点的证据。Pocket继续保持实际可见阅读和内容版本水位。
- **原生手机通知不是PWA保活。** Pocket已有Web Push和近期会话跟踪；对方Android前台服务和iOS第三方通知路线不能直接搬进PWA。通知更多通道、CLI/WSL、终端/Git和多Agent暂缓，除非真实目标恢复这些范围。

## 本轮结果与接续

完成固定源码取证、Pocket对照、独立安装/配对侧审，以及两个隔离条件探针和独立边界复核。`probe-result.json`保存帧/仅params投影及入口校验结果，`receipt-probe-result.json`保存实际loadHistory在内存SQLite中的回执/出队结果；输入和输出全为合成数据。独立复核后补强fixture和SQL验证，未把合成状态等同于真实生产者行为。未安装/启动Bridge、未连接真实桌面或调用模型、未改产品/部署/认证。安装、真实首帧规模、原生准备态出现条件和实际用户效果都仍待验证。

建议顺序：先补发送确认的证据边界；测量长会话帧和重复读取；开源Alpha优先补入口诊断；扫码/设备撤销和持续订阅按使用证据推进。当前两个源码缺口只进入待续记录，不自动修改旧回执、清队列或扩大开发主线。

## 同日补充：先按自用重新排序

欧吉安随后问：先不考虑开源，自用有哪些新的输入能用得更好。本节是该讨论范围内的建议，不把假设写成永久取消开源，也不代表功能已实现或正式调整开发优先级。

1. **发送后更放心。** 优先核对仅params展示与原生确认的证据契约；网络断开、原生超时后能明确核对结果，并保持后续输入。Pocket已有账本和草稿保护，新增的是收紧确认来源与完整恢复验收。前述合成路径已复现，真实原生生产时序尚未验证，不清理旧unknown或重发。
2. **打开长会话、多任务接续更快更稳。** 测一条长会话和一条短会话的首段正文、owner准备、发送接收与峰值内存；再决定连接复用/增量订阅是否有收益。当前代码仍有跨会话后台队列逐项await；10-26已补连接就绪时本会话单独唤醒，不能说所有发送都被一个慢会话阻塞。Bridge自己的maintain也有逐项循环，因此公平轮转/有界并发是Pocket已有缺口的验证方向，不冒充从上游直接获得的现成修复。
3. **手机直接验收产物。** Pocket当前已支持Markdown/文本/源码、图片、视频；HTML仅作为源码文本，PDF主要下载。Bridge的`web/features/workspace/pdf-preview.js`使用惰性PDF.js与逐页绘制，支持手机缩放；`html-preview.js`与`bridge/api/html_preview.py`将自包含HTML放在隔离shell中，允许内联交互、禁止网络/API/外部资源和表单。更有感的新能力是从原回复点开报告PDF或网页小样，返回原阅读位置后在同一会话反馈。只扩既有已登记文件的预览，不增加任意文件浏览或新授权；依赖CDN/API的完整应用仍走现有预览入口。待用多页PDF、自包含交互HTML及拒绝网络样本验证，未实施。
4. **离开页面后及时知道，回到页面能继续。** Pocket已有近期会话Web Push、通知点击ACK及草稿保护；先完成真实iPhone主屏幕/锁屏送达、等待操作/结束/失败和点击正确机器会话的闭环。已有能力尚缺真机效果证据；Bridge多通知渠道只是后备候选，Android后台服务不能直接搬进PWA。原生推送验收后若仍有具体缺口，再选已有授权通道，不新增泛通知平台。

分层联网诊断对自用也有帮助，但排在上述体验之后：区分公网入口、本机API、目标电脑、原owner与未确认消息，优先提供明确恢复动作，保持原任务和未知账本。扫码配对、陌生人安装壳、多平台和多Agent暂不进入这轮自用建议。

若只进行一轮优化，建议先核对/补强发送确认，再用实际长短会话决定速度改造；最值得单独增加的可见功能是PDF/自包含HTML预览。完整Git工作台、统一桌面队列和占用归档不能由这个上游直接兑现。
