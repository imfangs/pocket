# Pocket 多机连接

2026-10-17。用户要求手机同时能接入格得 Mac 和豌豆 Mac，并选择“按电脑切换列表，记住上次选择”。本次不合并两台电脑的会话。

## 使用与隔离

2026-10-18按用户要求收拢：电脑切换和当前电脑名称只在「设置 → 连接电脑」显示，菜单、列表、详情、登录/连接失败页和通知标题都不展示具体电脑名。登录、连接失败、无效电脑参数及App加载失败页保留通用设置入口；未认证设置不加载通知接口。17日初版在各页展示电脑名的方案由本次替代。

浏览器验收发现无效machine原先直接进入选择页，跳过BootSplash生命周期，导致预置启动遮罩一直挡住设置。现统一先进入loading，再明确转到选择页，由同一启动壳控制器释放遮罩；无效参数仍不请求任一机器API，也不自动降级。静态网络离线壳没有具体电脑信息，继续保留原深链重试，不另造一套静态设置。

10-18验证：1009项完整回归、构建及Chromium/WebKit 182条契约检查通过，包含设置唯一入口、独立快捷分类、搜索/刷新记忆、口令/草稿保护、登录/离线/无效参数/加载失败路径。WebKit对人工中断App模块的失败缓存仍可能跨导航保留；设置已正确切换URL、选择值与认证目标，但切机不承诺修复资源加载失败。新隔离环境正常载入目标分类通过。证据 `.local/qa/navigation-settings-2026-10-18/`；未操作真实会话或重启服务，发布状态回CURRENT。

新入口沿用上次选择；旧的 `/?task=<id>` 明确属于格得 Mac，不能因上次选择豌豆而改变旧链接归属。豌豆链接为 `/?machine=wandou&task=<id>`。同一个 thread ID 的完整身份仍是“电脑 + thread ID”，展示收拢不改变内部路由。

切机通过页面导航重新建立一套状态，当前文档的机器身份固定。登录、CSRF、目录、新建偏好、近期点击、忽略提问和未决创建编号分别隔离；主题仍共享。格得原有路径、Cookie 和偏好键保留兼容。未知电脑明确拒绝，不退回另一台。

草稿和附件仍遵循现有内存边界，不新增聊天正文的浏览器持久存储。切机前共用未完成操作保护：有未发文字、问题回答、文件、队列编辑或未知提交时先保留当前页，说明需要处理的内容；不默默丢弃或重发。没有这些本地未完成内容时，服务器上的运行任务和已入队消息继续由各自 Mac 处理。浏览器自己的关闭/返回行为仍受平台限制。

手机多机入口仍是 `https://x.fangs.cc`。旧 `threads.local` 是格得本机入口，从那里选择豌豆时经相同保护进入公共 Pocket；不在格得 API 中再套一层跨机代理，也不转发其本机 bearer。

## 网关与机器身份

- `/api/*` 和显式 `/api/machines/ged/*` 使用原 `origin` KV 记录；`/api/machines/wandou/*` 使用 `origin:wandou`，上游仍接收规范 `/api/*`。
- 每台 Mac 有自己的登记 token。原 `NAVIGATOR_REGISTRATION_SHA256` 只授权格得；`NAVIGATOR_MACHINE_KEYS` 是其他机器 ID 到 verifier 的映射，不能用一个机器的 key 改另一台的记录。
- 新登记携带 `machineId`，回执也核验同一 ID；旧格得连接器仍可无 ID 登记。连接记录保持短期续登记，无连接时明确尚未转发，发出后结果不明仍按未知处理。
- 浏览器格得 Session 沿用 `navigator_session`，豌豆为 `navigator_session_wandou`。Worker 只将选定机器的 Cookie 转成上游原名，并将响应 Cookie 改回对应机器；其他机器的 Cookie 不透传。
- Node API 用 `NAVIGATOR_MACHINE_ID` 返回自身 `X-Pocket-Machine`。非默认机器的上游身份必须匹配；格得暂兼容旧 API 无头，有头时仍须匹配。前端也核验响应身份。
- 图片、原图和附件保留规范资源身份，仅在实际请求时加机器路径。源路径、权限与图片注册校验不放宽。

## 通知与旧客户端

同一手机域名只有一个浏览器 PushSubscription。两台已配对的 Pocket 后端共享同一应用 VAPID 身份，各自管理订阅是否启用；登记 key、访问 Session 和本机 bearer 不共用。关闭通知或退出登录只解除当前机器的后端订阅，不注销浏览器全局 PushSubscription。VAPID 不匹配时明确报配置未同步，不替另一台销毁订阅。

通知标题统一为「Pocket」，payload/tag仍带机器 ID，点击优先使用同一机器的窗口。远端使用新的 `pocket-open-machine-task` 消息类型，旧页面不会把它当作格得任务；找不到可接收窗口时打开对应链接，不覆盖可能还持有草稿的旧页。旧通知无机器 ID 时属于格得。

## 每台 Mac 的运行配置

每台后端只读取该机自己的 Codex 存储并连接其原桌面 owner。手机通过 Cloudflare 分别直达各台连接器，豌豆不依赖格得 Mac 中转。模型、目录、权限和回执仍由目标原会话决定；不会启动另一个执行器接管原任务。

`NAVIGATOR_BRIDGE_CONFIG` 可指向绝对路径的机器私有 JSON，字段与 `config/desktop-bridge.json` 相同。Node 与 Python 使用同一配置；无覆盖时格得沿用原配置，覆盖无效时不回退。远端应使用可用的现代 Python 和实际 App 路径，桥接依赖按已核验源文件打包并记录 SHA。

本机 API 与连接器使用既有 FBT local 管理机制。机器凭据、VAPID 私钥、实际部署路径/回执和测试样本仅留各机私有目录及 `.local/qa/multi-machine-2026-10-17/`，不放入前端或 Git。

## 验收边界

当前实现和验收中的具体进度以 CURRENT 及私有回执为准。必须分别确认：两机 Cookie/路由与无回退、同 ID 的会话/图片/文件、草稿阻止切换、消息只到目标机、真实远端版本和原 owner、实际云端登记、公开入口与进程恢复。静态配置、隔离浏览器、真实 Mac API、真实消息回显和 iPhone 主屏幕使用是不同证据，不能相互替代。

发布前952项完整回归与构建通过。实际Worker与两套合成Mac的本地HTTPS链路完成Chromium/WebKit共66项：自动保存独立Cookie、相同thread/attachment ID不串正文或文件、原生下载、草稿保护、仅向豌豆发送、离线不回退、独立退出、未知机器禁请求及成功提示减法。证书、临时数据和浏览器均已清理。

豌豆实际App为26.1013.40934:20770、内置CLI0.163.0-alpha.10.2。隔离临时home完成创建/改名等26项及归档/恢复专项14项，并只放行这一确切版本；未运行模型或改真实Codex数据。resumed-empty成为unknown的既有保守归档条件没有放宽，原失败和超时诊断保留在私有证据汇总。

归档仍受原桌面 writer 条件限制；多机路由不等于已经安装此前研究的共享 Core 适配器。先前用户要求保留的会话和已取消操作不恢复。

## 真实连接补充：首次未找到 owner

真实首发创建成功，但新会话首次查找返回`no-client-found`。旧异常映射将它当作`desktop_protocol_error`，read-first恢复因此在打开原会话之前退出；消息保持原队列，未重复提交。安装包与真socket证明快照仍为v11、owner discovery为v1、start turn为v2，不需要放宽协议版本。

修复只将“尚未派发、owner查找阶段、精确no-client-found”归为可恢复的`owner_unavailable`，继续原有单次打开/有界快照核对。初始化中的同名错误仍拒绝；写入已发出的错误仍是unknown，不能重放。只有验证到原owner的resumed快照后才能发送。

对同一验收会话的一次明确连接已使原队列完成：原requestId恰好1轮、1条用户消息，1条final与marker完全匹配；source=desktop/resumed/idle，轮次completed；格得API无该线程。没有启动第二Core、重启Codex或重复发消息。GUI存在两个同路径listener，但本次正常导航已成功，不能将它们认定为此故障原因。相应证据在`live-check.json`、`remote-protocol-after-open.json`，自动恢复修复的部署状态回CURRENT。


## 2026-10-17 部署与实际回读

前端/Worker发布源码`19d91ed4776d79fce17a79ed88ed3b79622197e7`，Pages`1bb8232d-13e9-4116-9944-70e19a590253`，build`b887f088730a12dc1a90a0153223089f2df88734460cb6fc7631aca800f19f43`；21文件和功能通过，上传一次。首次owner恢复修复仅更新桥接，豌豆API运行`ca5c97c2462a970a460560dadc1cc069ee65e454`，无需重新发布不变的前端。

豌豆安装版本化代码和8个带SHA的桥接/FBT管理依赖，使用已存在的Node24/Python3.13及新装cloudflared2026.10.0。两端访问口令校验与应用VAPID配对，本机bearer和机器登记key独立；仅通过已验证SSH传必要配置，无凭据或聊天记录进入Git/公开包。实际配置和回滚路径在远端项目CURRENT及私有安装回执。

API与连接器均以原版FBT local登记登录启动/KeepAlive，loopback绑定；Codex没有重启。初次隧道启动超过管理器短健康窗口，临时service-only配置明确保持ready=false，真实握手/自动续登记变200后再由正式200配置接管同PID，临时配置删除；网络对照未证明需要改Node或系统网络，因此未永久修改。API升级曾遇bootout/bootstrap竞态并回滚，随后先stop等待卸载、再up成功，tunnel保持原PID/版本。失败与恢复均保留在回执，未伪造最终健康。

真实公网验证两台独立登录与catalog、两机health/匿名拒绝、消息目标隔离。自动恢复修复后另建专用冷启动验收，只提交一次创建及initialQuery，完全没有手工open：原owner为desktop/resumed/v11，恰好1轮、1条user、1条final与原requestId/Query/marker一致，0工具调用；格得catalog无这条远端线程。原测试和新测试使用各自唯一回执，不重放旧请求。两个专用验收会话作为真实链路证据保留，既有用户会话未用于试发。

最终955项完整回归，66项双引擎流程、真实冷启动与独立原owner回读通过。`live-cold-check.json`和`remote-cold-readback.json`保存精确元数据；`wandou-install.json`、`wandou-connector.json`、`wandou-api-upgrade.json`保存各层部署/清理结果。浏览器与真实Mac验证不替代iPhone主屏幕长期使用验收。
