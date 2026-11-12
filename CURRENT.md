# Pocket 当前状态

维护日期：2026-11-12。独立CR与生命周期重构完成：2635整仓测试、146同build浏览器流程通过，核心修复均经其他审查者复验。格得API已一次保护切换到a6af18c/PID44982，原2queued及凭据／偏好保持，Codex／connector未重启。共享网页仍为上轮f5aae23／e753f4a6／Pages91deec47；本轮在上传前遇Cloudflare401，正在续期，尚未上传。豌豆本次SSH仍超时，未更新；Documents权限仍待本人。

## 下一次先看

- 本轮架构与生命周期：[独立CR和归属](docs/design/2026-11-12-independent-cr-and-ownership.md)。上传终结／认证session所有者／ready取消恢复、前后台版本水位、读取取消及派发完成政策集中。最终状态看下方版本表与本轮总验收。
- 上传和缓存：[上传与图片缓存](docs/design/2026-11-12-upload-pipeline-and-image-cache.md)、[上传包装](docs/design/2026-11-12-uploaded-user-envelope.md)。网络预算、容量、实际accepted权威、原文与显示分离保持。
- 文件与图片：[常见文件预览](docs/design/2026-11-12-common-file-previews.md)、[图片契约](docs/IMAGES.md)。图片目录权限仍待本人确认；不要把缓存、403提示或前台读取成功当成后台授权已恢复。
- 本轮之前各次完整发布流水已原样移到[历史摘要](HISTORY.md#2026-11-12-独立架构审查前的接续摘要)，与各设计记录共同回溯。旧数字、失败和未验证边界保持，不用旧回执代替当前检查。

## 继续方式

用途保持为手机查看和接续 Mac 上的 Codex 原会话。欧吉安已认可统一、安静的视觉方向，后续精修完整操作路径，优先减少重复入口、反馈和阅读占位，不重新推倒整套UI。设计复盘见[顺手标准](docs/research/2026-10-11-pocket-interaction-retrospective.md)。

开发按新的用户反馈继续，不恢复旧“持续打磨 Pocket”heartbeat：2026-09-30用户取消，10-01回读为PAUSED。这与Pocket服务、用户已提交队列和通知的运行无关。Claude接入仍延缓；Happy/HAPI只作为阅读模型的参考，没有迁入其runner/hub。

**内置录音转写暂缓（2026-11-07，欧吉安确认）。** 继续沿用微信／豆包输入法的语音转文字。Hermes客户端研究中的内置录音/ASR小样不进入当前开发；只有本人明确恢复该方向时再接续。切会话/断线恢复的协议经验保留作后续连接改造参考，本轮没有发现需独立立项的Pocket同类故障。来源见[研究后续取舍](docs/research/2026-11-07-hermes-clients-for-pocket.md#同日后续取舍)。

2026-11-05新增[对外价值与竞品复核](docs/research/2026-11-05-pocket-value-and-differentiation.md)：更新HAPI已能导入/同步旧Codex会话的事实，加入官方Remote与Bridge直接对照；建议macOS单拥有者Alpha与外部同场景验证，未做竞品实机、用户招募或公开发布，不改变当前开发优先级。

## 最近已验证版本

| 范围 | 已核对记录 |
| --- | --- |
| 公网与本机 | [x.fangs.cc](https://x.fangs.cc) / [threads.local](https://threads.local)；API loopback4397、连接器健康4399，配置在 `config/` |
| 公网前端/网关源码 | 仍为上轮`f5aae23515e9d2098bb56997b556d0c46cf06a65`；本轮前端4f13d753待发布 |
| 两机API源码 | 格得`a6af18c8ce79eeb2e22c6341d3ce69c255d3a3ad`/PID44982；豌豆最后确认`fc86637f601cc2e7024c5b80eae9250322341139`，本轮SSH超时未重新核验或切换；格得connector12894/Codex不动 |
| 前端build | 共享公网/本地dist及格得API内置 `e753f4a697c5b869697fdaa1530d7266738292c28cbf135ca67bf334581b1d08`；豌豆内置最后确认`f9ac7165…` |
| Pages部署 | 网页源`f5aae23515e9d2098bb56997b556d0c46cf06a65`；`91deec47-9575-4be4-9708-73e58b17a833`；单次上传exit0/ready、243/243资源/功能、独立三资源SHA一致 |
| 本次验证 | 2577完整全绿、94同版浏览器、356不可变API与6临时HTTP；真实上传包装/PNG200与原SHA；预取/提交/存储独立CR。iPhone实际吞吐、挂起和Documents授权另验 |
| 本次证据 | `.local/qa/upload-flow-2026-11-12/verification.json`，private-image-cache／transcript-prefetch-parallel／uploaded-envelope同日证据及原红例/设施修正；API、Pages、独立回读和清理分层保留 |
| 本次数据与运行 | 格得API一次保护切换及网页单次上传；旧2queued/凭据/偏好/订阅保持，Codex/connector未重启，无模型发送/归档/原数据/目录授权修改。豌豆SSH超时，最新完整接续包保留；OAuth单次28scope续期，原权限不变、目标200，无未决 |

上述最新发布已回读完成，不重复上传。后续涉及运行维护时再查实际进程、服务配置和公网；旧发布与详细描述沿对应设计记录及[整理前快照](HISTORY.md#2026-10-23-接续整理前快照)回溯。

## 必须保持的产品决定

| 主题 | 当前行为与权威入口 |
| --- | --- |
| 阅读状态 | 客户端按电脑＋来源scope＋thread ID保存版本水位，不存正文。有效运行中仅排除列表未读表现，结束后按水位判断；实际可见阅读立即标读，新鲜桌面已读提示只推进对应版本。原生旧true不反弹。见[阅读状态](docs/design/2026-10-22-pocket-read-state.md) |
| 单向合并边界 | 原生只有会话级布尔标记，没有逐消息水位。服务端将提示绑定精确内容，至少两次间隔2秒复核；未知、运行中或扫描失败撤销候选。列表运行互斥只影响呈现，不推进已读或改变桌面提示规则 |
| 阅读与输入 | 默认单条输入栏，展开保留原textarea、草稿、选区和IME；错误在对应卡片/输入条内轻量呈现。见[单条输入栏](docs/design/2026-10-13-reading-composer-and-row-state.md)、[反馈收敛](docs/design/2026-10-22-reading-errors-and-sort.md) |
| 导航与排序 | 分类/项目、状态、排序是独立维度。全部/关注/置顶保持；Pocket关注与Codex置顶独立。创建按创建时间，活动及列表显示时间按最后消息时间，不能用点击时间冒充。见[智能排序](docs/design/2026-10-14-smart-navigation.md) |
| 多机与模型 | 电脑信息只在设置，记住选择，原owner/目录/模型/权限不跨机。支持同型号思考强度；新建保留目标桌面的有效默认强度，不能统一硬编码Ultra。跨型号仍未开放。见[多机](docs/design/2026-10-17-multi-machine.md)、[模型](docs/design/2026-10-18-model-settings.md) |
| 发送与缓存 | 自动直接发送默认开，只影响新提交并逐条保存策略；旧队列不升级，未知不重放。状态预取最多32项，正文固定8候选/8并发，未读加权，运行约5秒／未读约30秒可再次验证，当前交互优先；较新缓存可先于实时响应展示，后台不连接或标读。上传16路、图片读取8路并使用12MiB内存／64MiB私有IDB；见[本轮上传与缓存](docs/design/2026-11-12-upload-pipeline-and-image-cache.md)、[直发](docs/design/2026-10-22-auto-direct-send.md)、[预取](docs/design/2026-10-22-active-thread-prefetch.md)、[活跃阅读接续](docs/design/2026-11-11-failed-turns-and-live-prefetch.md) |
| 消息与附件 | 用户长Query可展开；文件引用与Codex标记走统一受控解析。附件、下载、发送回执不借阅读缓存扩大权限。见[消息组件](docs/design/2026-10-22-message-components.md)、[附件](docs/design/2026-10-10-attachments.md) |

其它功能和代码路由只在[AGENTS](AGENTS.md)维护；能力对照见[DESKTOP-PARITY](docs/DESKTOP-PARITY.md)。

## 阻塞、未决记录与验证缺口

- **Bridge研究发现条件性回执风险与帧边界（2026-11-05，未修产品）。** [研究与接续](docs/research/2026-11-05-codex-mobile-bridge-inputs.md)：仅params投影携带clientMessageId，通过完整入口字段/envelope校验后，实际loadHistory在内存SQLite上将匹配unknown用于accepted/出队；源码分发AppIPC拒绝65MiB合成帧。无真实会话/用户数据库/模型；无userMessage项不能证明未持久化，原生生产时序/实际帧/影响待查，不称已发生现实故障、不核销旧回执、不重放或清队列。诊断、扫码和持续订阅是候选输入，未改变开发优先级或发布状态。

- **root-only恢复仍有原生能力限制，已加明确保护（2026-11-11）。** 当前CLI会恢复关联子树；现在关联根请求返回restore_scope_conflict，未知图返回restore_scope_unconfirmed，独立/叶会话的真实恢复保持。原2项持续失败已通过明确拒绝/归档标志/正文哈希及新增叶正例修复，并非删断言或假装实现了root-only原生能力；完整全绿。最终图检查与原生事务之间没有条件CAS保证，继续取舍见[11-11审查](docs/design/2026-11-11-codebase-review-refactor.md)。旧兼容证据留原研究，不能再把旧2fail当当前测试状态。

- **历史读取仍有明确边界**：分页源上限512MiB、单记录8MiB，超限会解释而非假称全部加载；游标失效可重新核对。压缩兼容已经解决；本轮7个旧样本文件仅有session_meta，不能从文件名或解压成功推断里面有对话正文。原生云端缺少本地记录时不凭空补内容。事实与取舍见[历史分页](docs/design/2026-10-28-history-pagination.md)。
- **原生标读写回未稳定恢复**：10-22重启后的Codex仍有双listener/readback_unconfirmed证据。当前主线不依赖写回；不因蓝点不一致重启Codex、批量补标或改原存储。旧局部成功只证明当次对象，见[原生同步历史](docs/design/2026-10-05-read-state-sync.md)。
- **归档仍可能长期等待writer**：原会话或spawn子树被桌面持有时，独立CLI/RPC不能完成。共享原Core的stdio适配器只做过隔离原型，未安装，真实GUI与桌面副作用未验。用户要求“Tabbit调研”及相关子会话先保留，已取消请求不得恢复。见[归档owner研究](docs/research/2026-10-16-archive-owner-route.md)。
- **旧发送未知结果与队列**：本轮未重放或清除旧条目。09-30记录只作检索入口 `.local/qa/connectivity-2026-09-30/dispatches.json`；下一次操作先查当前账本与原历史，不凭历史中缺少文本判定未发送。
- **真机与通知**：浏览器/CDP验证不等于iPhone PWA、真实键盘、锁屏通知或长期切网。豆包语音手动切回可以填入文字，自动唤回未解决；见[原排查](docs/research/2026-10-09-ios-doubao-pwa-return.md)。清站点数据/重装PWA会失去浏览器阅读水位，跨手机已读同步未实现。
- **文稿图片读取仍待系统授权**：本轮已确认目标图片登记正确、后台被macOS拒绝访问Documents，权限提示已上线；本人尚未报告已开启实际Node的文稿权限，目标GET仍403。接续先核实际读取与授权状态，不重放／搬移会话或修改TCC库。证据和明确操作入口见本轮图片条目。
- **其余范围**：共享桌面队列、分叉、工作树创建仍未接入；慢owner拖延后台串行队列的长尾待观察。仍为个人部署，未公开开源，不能承诺任意账号即装即用。

## 运行维护与恢复入口

- **停留连接发布已完成。** 最新prepare曾暴露两项子测试硬读仓库默认Python而忽略机器配置（连带父测试失败）；仅测试改用生产已有的配置解析后，远端288项通过。另一个本地全测偶发来自夹具半写global JSON，已改原子发布并保留半写返回unknown的负例，生产标读代码未改。失败/修复证据留最新QA；不是新连接功能的原生运行故障。安装包、分片及从未启用的95dc候选已清理，当前5b/回退ae1/依赖0b5与连接器版本保留。

- **本轮已完成，不重复上传或切换。** 首次豌豆传输中断后按32KiB校验片续传，整包SHA一致才安装；第一次服务切换因切换前已经存在的续约失败触发回退，连接自行恢复后，在独立 `retry-1/` 中校验正常基线再切换成功。部署检查与网络事件分开记录，不把这次回退说成新代码故障。Pages预检401发生在上传前，刷新CLI认证后实际上传一次并核验完成。完整操作与清理回执在最新QA目录。

- **2026-10-28 KV续约降频已上线并回读**：同址续约10分钟、KV/回执30分钟；60秒检查/失败重试和换址登记保持。网关源 `3b42e1f` / Pages `d56d7385-69ef-4e9b-9c7f-d0f238145600`，从已发布 `2804dbd` 的代码隔离构建，前端build仍为 `de9b820e…`，未夹带并行缓存开发。1482项全测、构建、30/30公开资源及功能检查通过。格得连接器PID12894实测654.228秒续约；豌豆5分钟不重复写，首次定时提交遇既有网络错误，下一分钟自动重试成功，实际721.807秒；保留失败与恢复，未记成无故障首续约。两机新租约均1800秒，公网health/身份与匿名catalog401通过，API/Codex未重启。三路全天写量下降仍为估计。契约见[手机链路](docs/MOBILE.md)，完整版本/时间与原始证据见[续约验收](.local/qa/kv-renewal-2026-10-28/README.md)；其它前端发布条目按各自事实源接续。

- 本机项目是 `/Users/fangs/workspace/side/codex-navigator`；API用稳定`config/local-service.json`（指向不可变release）和FBT local。个人Pages更新必须用`.local/compatibility/oss-preparation-2026-11-04/pages-site-compatible.json`，它显式引导ged/wandou profile；不要裸用通用build默认local覆盖现有站点。源代码内公开模板不含私人profile。
- 豌豆已验证SSH配置为 `/Users/fangs/.ssh/ged-yuzu.conf`，目标 `wandou`；远端根为 `/Users/fangs/workspace/projects/codex-navigator`。当前`.local/current`、私有API配置working_directory和launchd实际命令均已回读；具体版本以本页版本表为准。机器私有配置在 `.local/config/`。远端脚本用已验证 `/opt/homebrew/bin/python3.13`，测试也从bridge配置取解释器。
- 格得当前553834b release复用原不可变依赖，324个生产包无更动；直接回退e9a5529及依赖祖先继续保留。豌豆版本本次未重新核验，最后确认fc86637。本轮切换／停机备份／逐条保护和最新远端接续包在`upload-flow-2026-11-12/api-deploy/`，旧e9转移包由新包替代，旧回执保持；清理前按实际软链重新核验，不按日期删除。
- Pages认证失败先按[FBT认证恢复](/Users/fangs/workspace/fbt/workflows/pages-site/docs/auth-recovery.md)识别生效来源与未决记录，恢复后核对上传阶段；已上传但验证未过使用原部署 `resume --resume-verification`。不要用可能隐式续期的whoami试探未知refresh。
- 10-25历史清理：当时的临时浏览器、fixture、两次传输tar、重复baseline/fixed-dist及未启用的失败release `fa1168d…` 已清理。当时的当前/回退`0dbdf39…`、依赖与连接器release曾保留；后续引用以版本表和实际软链核验，旧清理回执在 `wandou-update-2026-10-25/final/`。旧脚本中的已删tar不是现成恢复包，继续发布须重新准备。
- 仅文档维护检查事实、链接和diff后本地commit；不跑产品部署。功能改动的验证与受控真实发送范围遵循[QUALITY](docs/QUALITY.md)。
