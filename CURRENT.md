# Pocket 当前状态

维护日期：2026-11-12。常见文件预览、同消息图库和归档分类入口已上线：普通JPG文件卡可预览并下载，PDF/SVG/现代Office/ZIP/音频按类型展示；图片左右切换保留缩放、焦点与阅读，归档回上方分类、底部只设置。源e9a5529/API26770、网页978d80e/buildc7be8a18/Pages5afc4f01；2484全测、102同版浏览器、284不可变API和243资源回读通过。实际指定JPEG预览200/50294字节等于原件并正常解码；旧2queued及凭据/偏好/订阅保持，Codex/connector未重启。此前Documents目录许可仍待本人，豌豆未更新，最新接续包保留。

## 下一次先看

- **常见文件链接与同消息图库已上线（2026-11-12）。** [契约与格式](docs/design/2026-11-12-common-file-previews.md)：实际指定JPEG普通file link旧版仅下载，原件原本200；新files/image复用登记能力、格式/8MiB/签名/目录/inode核对，实际新端点200/image/jpeg/50294字节等于原件，浏览器解码1100×904。正文图／图片文件卡／附件按单消息注册、顺序／去重／scope／32窗口快照；单指原比横滑48px切图、放大拖动仍平移，按钮/键盘/张数、加载失败可切走，同dialog／旧图事件／读节点／草稿／IME／回焦保持。归档移上方分类无数量，底部设置图标+文字；原筛选和归档处理不变。PDF惰性同源Worker/CMap/字体与画布预算、静态SVG、现代Office有界Worker内容/ZIP目录、nativeaudio受控512MiB Range生命周期，原下载/HTML/文本/视频保持。新增库仅前端dev构建依赖，324 API生产图不变；定向补丁后npm audit0。14Office／6PDFSVG专项及独立资源CR，媒体短EOF漏helperP2修复409并独立复验；开发PDF资产和模块MIME也已实证修复。最终2484全绿、102同版浏览器(图库/分类32+旧52+JPG8+PDFSVG音频4+Office6)、284 inactiveAPI/临时HTTP通过，无skip。JPEG/PDF/SVG旧断言、WebKit焦点/Blob/媒体request分类、loading图缓存与toolbar SVG计数等设施错误分别保留。格得不可变APIe9a5529一次保护切换/PID26770，旧2queued、凭据／偏好／订阅及原所有者保持；网页源978d80e/buildc7be8a18…/Pages5afc4f01…单次ready、243/243资源/功能与独立version/profile/App/PDFWorker/CMap正常DNS/TLS哈希一致，重build全部246文件与已测release逐字节相同。urllib静态读取被HTTP拒绝的传输对照单独保存，未重传。无模型消息／真实归档／Codex源或系统授权修改，Codex/connector不重启；此前Documents图仍待本人授权，Office为内容预览，物理iPhone/全部codec不作保证。证据`.local/qa/file-previews-2026-11-12/verification.json`；豌豆原fc未连接更新，最新`api-deploy/wandou-continuation.json`完整包替代旧0f传输包，无未决Pages。

- **图片权限原因与重试提示已上线，实际访问待本人授权（2026-11-11）。** [图片契约](docs/IMAGES.md#mac-文件访问权限)：实际目标catalog cwd正确、两路正文有图片引用，828274字节PNG在前台读取成功，原后台两路GET均404；对应PID与实际Node的TCC DocumentsFolder请求明确authValue0，排除引用／目录／容量问题，但不据此猜测旧版Node是否曾授权。EPERM/EACCES现在403＋固定原因，其他原生失败仍404，原403／415／409保持，路径／errno不出站。只有已登记图片加载失败后才一次3秒／1KiB有界诊断，scope／响应机器／客户端版本保持，成功body取消；重试／切会话／卸载使旧诊断失效，中英原地提示，原查看器与输入／选区保持。旧16浏览器负例全部失败→最终20专项＋4既有查看器回归同build通过，2364全测／217 inactiveAPI／6临时HTTP及独立CR绿；4项无关URL期待纠正单独保留。格得API0f1e0d2/PID48040一次保护切换，原2queued和凭据／偏好／订阅保持；目标最新GET已只读确认403明确原因，**目录权限未报告开启，未恢复200，不要把提示改进当成图片修好**。需要本人在Mac「文件与文件夹」核对实际Node并允许文稿，若列表没有则继续实际授权入口调查，不改TCC库或扩大图片根。共享网页源d27060d/builda71da0ae…/Pages2cbfa6c6…单次ready、38/38与功能及独立version/profile/App JS一致。无Codex／connector重启或原会话／模型发送；证据`.local/qa/local-visual-2026-11-11/verification.json`。豌豆仍fc未升级，最新接续`api-deploy/wandou-continuation.json`，旧9c转移包由本轮完整包替代。

- **失败原因与未读／运行正文预取已上线（2026-11-11）。** [实现与边界](docs/design/2026-11-11-failed-turns-and-live-prefetch.md)：实际「开曼 - 经营总控」两次服务繁忙失败原生／保存结构已只读核对，修复旧保存`task_complete.error`被当成功、列表终态归idle以及详情丢失原因；独立有界`turnFailures`按原轮次显示，不合成AI正文、不猜工具失败为整轮失败，当前运行／等待优先，后续重试保留前次原因。预取保持8候选／1并发，未读加权优先，运行约5秒／未读约30秒可重新调度，版本变化及时读取、运行结束再核对一次；常规目录poll不再取消正文读取，前台输入／发送／读取仍优先，隐藏／离线暂停。较新的已认证同scope缓存在本次实时响应前先展示，选区／输入／阅读意图保持，版本地板防目录追赶与淘汰导致3→2回退；后台不标读，可见且入场稳定后才记水位。2338全测、10失败与真实App/L1缓存交接浏览器、68相关回归及三个方向独立复核全绿。格得不可变API9c577fa一次切换、193 inactive测试／临时HTTP6项及保护数据回读通过，旧2条queued、凭据／偏好／订阅保持；只读真实native history保留2次原因；当前saved快读仅11条且未含旧失败，有界窗口是可能原因，未凭消息数断言唯一病因，不承诺所有旧失败始终在首窗口。共享网页源5550a4e/buildb8fb9714…/Pagesf765406e…单次exit0/ready、38/38与功能及独立version/profile/App JS一致。Codex／connector未重启，无实际发送、连接、停止或原数据修改；豌豆离线未上传／切换，接续`turn-failure-2026-11-11/api-deploy/wandou-continuation.json`。iPhone挂起不持续执行，第9个未读可能不在固定工作集，不承诺全部未读瞬开；证据`.local/qa/turn-failure-2026-11-11/verification.json`，无未决Pages上传。

- **弱网列表反馈减轻已上线（2026-11-11）。** [静默同步](docs/design/2026-11-11-quiet-list-sync.md)：用户截图中44px反复提示收为固定2px槽，已读目录普通同步不自动播报；实际catalog/status pending才动画，重试等待静态，native HTTP200 unavailable／unknown／TTL不累积网络失败。明确offline立即提示；其它失败需单链3次／30秒且没有另一列表路由在失败后证明可达，pending保留失败链、真实success清除、后台/scope重置。旧挂起请求迟到timeout污染展示诊断的独立负例已修并通过，不改变原runtime／缓存权限。首屏无缓存恢复入口保持；旧活动/通知断言仅改展示契约。40专项（12新/8活动/20通知）、56发送/列表追加/来源浏览器和2286全测全绿；暂停虚拟时钟前2个边界设施错误保留。源80452bf/buildf06716b2…/Pages4305e937…单次exit0/ready、38/38与独立version/profile/App JS一致，实际iPhone弱网不作直接实测承诺。仅共享网页，无API/Codex/connector重启或模型操作；OAuth一次28scope续期，首次只读DNS失败后的verify重试GET200，无未决。证据`.local/qa/list-sync-feedback-2026-11-11/verification.json`，CR另browser-list-sync私有报告。

- **列表底部上滑加载更多已上线（2026-11-11）。** [列表展开](docs/design/2026-11-11-list-load-more.md)：已认证目录每次明确向下阅读意图加80，96px触底范围／手势安静后读取，按压与动效先稳定；scope＋limit防一手势两批，恢复／轮询／刷新／选择／横滑／inert不误加载。滚动根、原行节点与焦点保持，按钮备用及10个scope窗口仍在。同步锚点与提交前新滚动接管，真实React旧版回拉200px→修复保持；慢150ms滚轮漏触底负例也修复。14永久浏览器旧2过12失败／同版14通过、46发送/返回/弱网列表、32相关纯测与2276完整全绿；手机触摸为合成，WebKit wheel桌面缩390，真机惯性仍待使用。源7121f9c/builddfe23629…/Pages2a3fc830…单次exit0/ready、38/38与独立version/profile/App JS一致，只改共享网页；无新owner/来源导入或Mac API操作。可变QA默认报告路径误写已迁回并用未改的历史frozen文件恢复，原默认字节未冒称找回；细节在本轮私有note。证据`.local/qa/list-load-more-2026-11-11/verification.json`，无未决上传。

- **代码库CR与职责集中已完成（2026-11-11）。** [审查与取舍](docs/design/2026-11-11-codebase-review-refactor.md)：creationArrival统一临时输入与固定确认期限，明确取消／关闭预填也释放无入口副本；阅读模型集中纯投影和精确缓存水位，raw回执／权限保持。HTTP25秒／消息18秒／旧回执10秒，附件显式190秒；未知不重放，后续接受优先。关注来源检查与原统一修订保护并存；HistoryActionReconciler捕获读取起点的accepted／unknown，只用负向证据核对已有操作，pending留自身RPC。root-only恢复有子会话或未知图时明确拒绝，真实叶／独立恢复仍通过；无原生图CAS保证，不称完整解决原生能力。最终2268全测全绿、30同版浏览器／此前114宽回归／三个方向复核／179不可变API测试／临时端口HTTP通过；同来源关注修订误报经完整setter回读撤回，测试设施失败单独保留。API源码6f167c8／web090869e/build26d70f40…／Pagesf6cde136…单次上传ready、38/38与独立version/profile/App JS一致。格得一次API切换、两条旧queued和凭据/偏好/订阅保持，Codex/connector未重启；豌豆Tailscale Online=false、SSH banner超时与relay离线，未上传/切换。私有总验收`.local/qa/stage-cr-2026-11-11/verification.json`；远端接续`api-deploy/wandou-continuation.json`，保留同SHA13.8MB包，上线前先复核源与数据；无未决Pages操作。

- **最新一轮来源与滚动连续性已上线（2026-11-11）。** [实现与边界](docs/design/2026-11-11-live-source-scroll-continuity.md)：只读目标结构native77/saved19、3重复ID与非前缀final，不能由结构断言所有可选字段完全重复。展示精确去重与冲突key、同scope安全旧前缀＋fresh尾段、两路feed的唯一可见消息锚点让位于新滑动；原ID/raw、回执/运行/停止/阅读水位保持。首版108浏览器/43纯测及独立CR通过并完成独立部署；随后第二代理发现交错轮次边界，负例旧13过1失败，收紧分支后最终14专项浏览器/44纯测/四组结构模拟和独立复核通过，回退final位置差约0.125px、均到末尾。完整2208中2206过、原2项恢复差异无skip。最终源95fcdfb/buildabac6330…/Pagesff6bcdd3…单次上传exit0/ready、38/38与独立version/profile/App JS一致，首版7ed2af9/1cf44715回执独立保留，没有重传。仅共享网页，API/Codex/连接器和原数据未改；OAuth过期后单次28scope续期及账号/项目GET200验证。自然iPhone惯性/完整现象仍待使用反馈，私有证据`.local/qa/scroll-rebound-2026-11-11/latest-verification.json`。

- **历史加载后新滚动优先已上线（2026-11-11）。** [滚动接管](docs/design/2026-11-11-history-scroll-takeover.md)：飞象工作台下滑回跳调查，只读结构19条/hasMore/idle；发现并真React双浏览器复现通知→新滚动140→440→commit旧锚拉回140，hook在DOM提交前撤销已被新scroll接管的锚点，真实prepend仍同消息offset/不关历史/不换根。5新/31相关纯测、代理8及Root最后48同版TAP浏览器、构建通过；完整2181中2179过、2旧原生恢复失败无skip。首轮广回归启动错误缺明细保留，单独2/最终48复验绿，不指定未证实环境原因，也不冒称目标手机全部现象唯一病因。源ad6df56/buildf405d33f…/Pages0fef017f…单次上传exit0/ready、38/38资源/功能与独立公网version/profile/App JS一致，仅共享网页，无业务服务/owner/发送。OAuth有效未续期，无未决，私有证据`.local/qa/scroll-rebound-2026-11-11/verification.json`与scroll-history子QA；原生手机惯性和目标完整现象仍待反馈。

- **会话引用逐层返回已上线（2026-11-11）。** [返回栈](docs/design/2026-11-11-conversation-back-stack.md)：内容卡片/链接A→B→C，按钮/右滑C→B→A→列表；同ID不加层，列表/通知root，32父ID按machine/scope本页隔离。未知目标成功commit才push，新选择/来源变化取消迟到引用；missing/excluded跳过、归档可读保留。存储异常不阻断back URL恢复；草稿/原阅读位置沿既有cache、回父详情不抢列表focus，最终back清task URL。12纯栈/18含通知目标、10新最终同版浏览器、56既有通知/卡片/导航回归及独立CR通过，最后URL try小改此前56与最后10分别保留build身份；完整2176中2174过、2旧原生恢复范围失败无skip。源f77806c/build478c95bc…/Pagesc428ea7c…单次上传exit0/ready、38/38资源/功能与独立公网version/profile/App JS一致，仅共享网页，API/原owner/数据/Codex/connector和真实发送不操作；原生手机手势未实测。OAuth有效未续期，无未决操作，证据`.local/qa/conversation-stack-2026-11-11/verification.json`。

- **新建会话卡片已上线（2026-11-11）。** [消息组件](docs/design/2026-10-22-message-components.md#2026-11-11-新建会话卡片)：assistant顶层created-thread在首次适配前保留结构parts，变80px最小的整卡a，真实标题/项目或cwd末端/确知状态、统一18/16px图标；idle不猜完成，普通任务链接仍内联。代码/引用/list/HTML/details/用户/文件不升级，原raw/id/role与copy可读链接保持，完整源第一引用定义共用。当前machine+scope目录和fresh状态Context复用，无新GET/owner/发送，排除或跨机元数据不取，缺信息轻提示。原会话的2个目标已只读核对真实目录元数据；8新手机中英/双浏览器、16既有结构化/语言/图标、13新与37相关纯测、只读CR/构建通过，metadata更新保持article/anchor、键盘/修饰键与草稿导航通过。完整2164中2162过，2项旧原生恢复范围失败无skip。源8f1a152/build8e668858…/Pages6b44bb7d…单次上传exit0/ready、38/38资源/功能及独立公网version/profile/App CSS/JS一致；仅共享网页，API/数据/Codex/connector和实际owner不操作，没有真机目视或新截图验收。OAuth仍有效未续期，无未决操作。证据`.local/qa/message-task-cards-2026-11-11/verification.json`。

- **摇动恢复、其他折叠与弱网列表连续性已上线（2026-11-10）。** [摇动](docs/design/2026-10-29-feedback-infrastructure.md#2026-11-10-摇动权限恢复)：保存偏好与本页权限分开，可信运动样本被动确认，未知提供明确恢复按钮；只手势请求、关闭后的迟到grant不重开，原反馈目标/截图/回执保持。用户当次关开后允许已恢复，新按钮未真机验。[其他](docs/design/2026-10-30-compact-settings-and-controls.md#2026-11-10-其他默认收起)：高级改其他默认收起，复用AnimatedDetails/44px/16px图标，直发true/缓存128保持。[列表缓存](docs/design/2026-11-10-list-activity-cache.md)：machine/scope本页最后确认的运行/等待投影统一标签/计数/过滤/rank，顶部一次未同步提示；明确新事实撤销，unknown不推进确认水位，权限/发送/停止/dots仍fresh。本轮容量P2（160fresh误限128）与明确refresh被pending旧读吞掉的竞态已实证修正，原大列表/时间期待未放宽；所有失败日志保留。旧全套283中279过/4容量失败→容量候选78中77过/1refresh竞态→最终b4bdcd83同版50受影响+7设施全过，子18/14浏览器与独立CR/91聚焦亦过；完整2151中2149过/2旧原生恢复失败无skip。源2c74125、Pages28d79d7a…单次上传exit0/ready，38/38资源/功能及独立公网version/profile/App JS/CSS匹配；仅共享网页，无API/Codex/connector或真实消息/反馈/owner操作。OAuth单次续期原28scope/targetGET200，无未决操作。内存运行状态不跨reload；stop终态receipt后两路GET持续失败时列表需下一次合格GET撤销，见契约边界。证据`.local/qa/shake-recovery-2026-11-10/verification.json`与`list-activity-{cache,cache-capacity,refresh}-2026-11-10/`，原历史测试输出污染已标明来源并修中性默认路径，不伪造旧回执。

- **扩大界面并行实操已上线（2026-11-09）。** [记录](docs/design/2026-11-09-expanded-interface-qa.md)：三个子代理按导航/输入恢复/阅读分工，主代理检查登录与设置并统一集成。5处缺口修复：键盘空结果恢复保持焦点，异步/阻塞回答不接受其他ID的回执，文件Markdown代码可Tab进入，口令显隐保留编辑焦点与选区且不劫持键盘/非编辑激活。错配回执为合成异常反例，未证明生产发生。原正确的队列、计数、项目、媒体/HTML隔离、草稿与请求身份保持。19文件267/267同版浏览器、独立20/20及真实服务类合成回执3组通过，完整2130中2128过、2项既有恢复失败保持。源60cfef9、buildc0f9dc74…、Pagesf55c3a92…单次上传exit0/ready，38/38资源与功能、独立公网index/version/profile/App主脚本一致。仅共享网页/Worker，无Mac API/Codex/connector或真实发送/审批，实体iPhone/AT/原生WebKit横滚未验；本轮未调用续期，无未决操作。证据`.local/qa/interface-expansion-2026-11-09/verification.json`。

- **附件状态工作台与可读性已上线（2026-11-09）。** [记录](docs/design/2026-11-09-attachment-state-workbench.md)：真实组件冻结10种状态/组合，发现同前缀文件名省略后难区分、双操作挤窄文字；仅草稿卡CSS修复，完整名称换行，failed/unknown状态显式选择器让双操作按空间换行，单按钮短文件保持紧凑。独立复验抓到WebKit动态`:has`失效，已用现有状态属性修正；永久回归保护失败→键盘重试→未知→GET核对→已上传→移除，不重传核对。最终160工作台、24布局+4长英文动态链路、36附件专项、8 CSS缩放及独立定向通过；首轮整包165/165，完整2130中2128过、2项既有恢复失败保持。源9fb0ae1、build06d7b6fa…、Pages617d78e0…单次上传exit0；首读35/38后沿同一部署resume到38/38与功能通过，独立公网index/version/profile/App CSS完全一致。OAuth过期后单次续期28scope不变、目标GET200。仅共享网页，无Mac API/Codex/connector或实际发送，实体iPhone/浏览器菜单缩放未实测。证据`.local/qa/attachment-states-2026-11-09/`。

- **高级设置归组已上线（2026-11-09）。** “最多缓存会话”和“自动直接发送”移到通知/反馈后、版本/退出前的「高级」普通可见section，英文Advanced；清除嵌套旧留白，16px组内节奏/44px控件保持。[记录](docs/design/2026-10-30-compact-settings-and-controls.md#2026-11-09-高级设置归组)。直发原本默认true，本轮沿用；已保存false和旧队列策略不升级，缓存默认128与选项保持，没有启动trim。8中英/320-390/两浏览器实际设置UI、8既有多语言/图标浏览器、21偏好/多语言纯测、独立只读复核/构建通过；完整2130中2128过、2项旧原生恢复范围失败无skip。源c1bea98、build80c54dc1…、Pagesba65c420…单次上传exit0/ready、38/38资源/功能及独立公网version/profile/CSS匹配；仅共享网页，无API/Codex/connector或真实发送，OAuth有效未续期，无未决操作。证据`.local/qa/settings-advanced-2026-11-09/verification.json`。

- **通知短标题与自填回答框可见性已上线（2026-11-09）。** [通知](docs/NOTIFICATIONS.md)仅展示`【已完成】会话名`／`【失败】会话名`／`【待处理】会话名`，清空重复正文、不加来源，整体120字符/缺名Pocket/未知状态fallback、加密和machine/thread点击保持；系统署名不属于可隐藏参数，不推定用户所见来源一定来自系统。[回答框](docs/design/2026-10-10-optional-question-prompts.md#2026-11-09-键盘弹出后回答框保持可见)：异步题卡/同步请求只按编辑与实际视口显露所属滚动区，8px/双RAF/有限迟到重采样；明确阅读持续暂停至新编辑，不改焦点/节点/选区/IME/草稿/回执或共享键盘/CSS。原build86e3的8个基线可见性失败均复现，新build23216dd0…8/8新增、163/163整包浏览器通过；32通知/61输入定向/独立7纯测＋阅读意图探针CR通过，无剩余P1/P2。完整2130中2128通过，2项旧原生恢复范围失败无skip，未放宽。源53f16d8、Pages e5b8eb93…单次上传exit0/ready、38/38资源/原功能与独立公网version/profile/SW/App JS一致。仅共享网页/Worker，API仍fc86637，不做真实push/回答/owner或服务操作；实体iPhone键盘与通知未直接验收。OAuth过期后单次续期原28scope保持、targetGET200，无未决操作。证据`.local/qa/compact-notification-keyboard-2026-11-09/verification.json`、`question-input-visibility-2026-11-09/`与`question-input-review-2026-11-09/`，均私有。

- **筛选间距已按反馈收回（2026-11-08）。** 用户只希望略微松一点，首轮space-between把中文常见间距拉到约35px过度。现自然靠左形成一组，固定6px（原2px）；英文390–409为3px、≤389为1px，完整标签/计数/44px及中英手机一行保持。[纠正依据](docs/design/2026-11-05-filter-sort-row.md#2026-11-08恢复适度间距)。528组实际编译CSS几何（新增409/410边界，无inline覆盖）及16排序/英文/图标浏览器、独立尺寸复核/构建通过；完整2122中2120过、2项旧原生恢复范围失败无skip。源f59cea2、build86e3cb77…、Pages50d0042d…单次上传exit0/ready、38/38资源/功能通过，独立公网version/profile/CSS匹配。仅共享网页/Worker，本轮未改Mac API/重启Codex或connector；旧通知/heartbeat保持。证据`.local/qa/filter-spacing-correction-2026-11-08/verification.json`；几何可用与审美判断分开，首轮经过测量仍被用户纠正的历史保留。

- **通知入口、均匀留白和heartbeat尾段已上线（2026-11-08）。** [通知](docs/NOTIFICATIONS.md)：最新会话名、正确machine/thread、已知先进入/未知弱网重试、401/StrictMode/禁存储恢复、新选择优先且不重载旧草稿；独立5项入口问题闭合，37纯测/20浏览器通过。[筛选行](docs/design/2026-11-05-filter-sort-row.md#2026-11-08均匀留白)：space-between/440px上限、361–389英文适配，432几何/16单排序通过，图标/完整标签/计数/44px保持。[结构化尾段](docs/design/2026-11-05-structured-message-presentation.md#2026-11-08普通回复末尾的heartbeat结果)：严格完整顶层终端结果，single-line paragraph/multiline html共用schema，正文/独有结果/图片链接保留，代码示例及raw/id/role/权限保持；32定向/19独立/实际两消息SSR/原8浏览器通过。根最终55定向、155浏览器设施、两路独立CR及私有profile构建通过；完整2122中2120通过，2项既有原生恢复范围失败无跳过。功能/两机API源fc86637、PID73369/53703，各一次stop/up；保留凭据/scope/原队列订阅和Codex/connector，9e7回退/依赖保留。前端发布源54a9f87、buildf9ac7165、Pages332333cd…单次上传exit0/ready、38/38资源/功能与独立公网version/profile/SW一致，双机health200/匿名catalog401。OAuth单次续期原28scope保持/targetGET200，无待重试操作。真实iPhone/APNs未测试；没有QA实际发送/owner/重放或公开源码。三份私有QA入口见下方证据。

- **HTML交互预览已上线（2026-11-07）。** 用户明确认为自用附件默认禁JS过保守，[新契约](docs/design/2026-11-07-interactive-html-preview.md)：默认原脚本/事件/表单及普通HTTPS资源，独立HTTP shell/opaque iframe、不放宽Pocket主CSP或API/Mac权限；原件、同frame/草稿/隐私保持，source/origin/nonce一次交付与Escape归属验证。20项交互双浏览器、67定向、新版实际选集搜索21→1→21/图片21及独立CR通过；完整2103中2101通过、2项旧原生取消归档范围失败。最终build`cbb95494…`，整包133项全部通过；发布源05b63d0、Pages11a05a8f…单次上传exit0，38/38资源/原功能及独立公网version/profile/shell唯一策略一致。OAuth过期后单次续期、原28scope保持、targetGET200，无未决操作。只共享网页/Worker发布，Mac API保持9e7be97且不重启；Node源码精确shell路由已补并port0验证，当前两机旧内置页面仍是静态b528。证据`.local/qa/html-interactive-2026-11-07/`。

- **HTML文件预览已上线（2026-11-07）。** [契约](docs/design/2026-11-07-html-file-preview.md)：默认静态页面/源码切换，认证原cap+文档子目录栅格嵌图，FD/预算/opaque iframe/CSP与rrweb保护、原件下载保持；实际选集双浏览器21/21图片与原样式通过，8张jpg实际PNG兼容。最终Pages构建`b52851cf…`、131浏览器/设施与最后18项新版复验及专项通过；完整2090项2088过、2项既有原生取消归档范围失败，不能报全绿。两机API源`9e7be97`（功能18ab924）、本机PID57219/豌豆81869；两机各一次stop/up，原凭据/登录/scope/policy/metadata/保护记录/Codex/connector保持，Ged两条dispatch queued身份/状态保持、Wandou0，无切换窗口API账本业务发送变化。Ged真实目标会话只GET签发→preview21/0及原download相同SHA，未打开owner。Pages`ecdaad84…`单次上传exit0、36/36资源/原功能/独立公网version和双机profile一致；原OAuth仍有效、targetGET200，不续期/轮换。公网两机health200、新preview匿名401；无可用公网用户session，未把仅loopback localToken外发，不宣称该层fresh登录/私件auth GET通过。证据`.local/qa/html-preview-2026-11-07/`，无未决外部操作。

- **整体界面精修已上线（2026-11-05）。** [本轮契约](docs/design/2026-11-05-impeccable-refinement.md)：重命名相同错误去重并保持有效ARIA，英文脏草稿确认动作组8px换行间距，≤360触摸展开输入动作收紧但44px/字号/草稿/节点保持，手机文件预览关闭44px图标给标题让位，排序菜单同注册表16/1.75图标与原勾选保持。弹窗60个基线状态、阅读144组、新增40项及最终113项浏览器/设施与独立CR通过；私有双机profile Pages构建`8d54a5d42dde…`通过。完整回归顺序复验2058中2056通过、2项原生取消归档范围失败，无跳过；不能声称全测全绿，差异见下方未决事项。发布源`37d2b71`，Pages`e1ff123c…`单次上传exit0、35/35公开资源与原功能通过，公网version/双机profile独立一致；Cloudflare单次续期原28scope保持，无未决。证据`.local/qa/impeccable-sweep-2026-11-05/`，未重启API/Codex/连接器，真实会话和公共历史副本保持。

- **筛选与排序同排已上线（2026-11-05）。** 源`26cd368`，[设计](docs/design/2026-11-05-filter-sort-row.md)：未读CircleDot、运行CirclePlay、关注Star与当前排序glyph同排16/1.75，排序位于关注右边；搜索移标题栏原sort槽，原ref/快捷键/焦点/展开保持，归档/隐藏仍可排序。用户明确中英都紧凑一排，320/390＋128/32＋选中加粗三模式80组全过，图标/文字/计数不藏/不缩/不横滚；英文mobile Follow短名（title/aria完整）、320safearea限制局部拓宽与12px，390常规13px；4控件44px高，长标题ellipsis。12排序/英文＋2图标/2最终几何Tab通过；根最终2,058全测/73整包浏览器/构建通过；发布源215d145，build57da0bf3215d…，Pages9e4e30c9…单次上传exit0、35/35公开资源/原功能、独立公网version/private双机profile一致，只共享网页/Worker，无API/Codex/连接器重启或真实send，没有待续外部操作。原排序公式/独立筛选/目录与草稿、API/Codex不变。证据`.local/qa/filter-sort-row-2026-11-05/integration/`及子验收；历史bundle保持旧固定边界。

- **最终集成已上线：统一XML展示、排序语义与消息区焦点（2026-11-05）。** XML源`9174460`：[记录](docs/design/2026-11-05-structured-message-presentation.md)，known heartbeat/subagent纯registry、严格schema+continuation/代码citation保护/第一引用表、安全details及unknown XML inert，普通rawHTML仍旧隐藏，角色/id/raw/文件授权不变；指定「每日 - 修炼」实际Pocket700字从整条XMLcode恢复正文+折叠，两个cwd外文件明确Mac提示、0媒体请求。排序源`690efc4`：Sparkles/CalendarPlus/History＋智能/创建/活动短标签，44px高/默认透明/一行/记忆和过滤草稿保持，6浏览器+24手机几何通过。蓝框源`b5ee81a`：UA focus-visible保留问题实证，region scope pointer/touch/programmatic无框、真实keyboard有框，不blur/prevent/改节点，24相关+4双浏览器过、8组基线滚动一致。最终完整2,058、实际整包71浏览器/设施、构建通过；XML17独立CR/80针对/6flow过，真实材料只privateQA。证据`.local/qa/frontend-integration-2026-11-05/`及三子目录；发布源`c540a74`、build`5a4596f04e51…`、Pages`0681bb14…`，个人双机profile单次上传exit0、35/35公开资源与原功能、独立公网version/profile一致；仅共享网页/Worker，API/Codex/连接器未重启或真实send，公开历史仍固定旧边界不改bundle。没有待续认证/上传。

- **REA与安全扫描已完成（2026-11-05，只读代码，待处理项明确）。** [记录](docs/research/2026-11-05-rea-security-scan.md)：本机REA6.4无专门GitHub secret入口；本地解析492JS/0失败，图partial/facts非漏洞数。Gitleaks8.30全历史/目录三组各16命中，15源码SHA256＋1sessionStorage键名，独立重hash292文件均一致确认误报；原exit1保留不放宽规则。脱敏候选2d2fa4a的3,243对象/10私人规则/30编码变体零命中，未上传源码/测试真实tokens。生产依赖audit0，开发vite7.3.6/source-map-js1.2.1有2high包汇总，升级与验证待授权实施；条件Low：image父目录本地写入竞态、直接反代保留CF-Connecting-IP可改变登录IP预算，两者合成复现但无匿名接管/密码破解，70入口边界测试通过。未修安全业务/改历史/重启或生产攻击；不是完整渗透/公开认证。证据`.local/qa/rea-security-scan-2026-11-05/`，当前渲染修复另行接续。

- **运行三点已居中上线（2026-11-05）。** 仅CSS增加justify-content:center，状态/恢复代次/消息节点不变。2,045全测、24组中英/亮暗/320/390/768双浏览器几何中心误差0、行高20/margin8不变与原6流程通过。源`34e30d4`、build`5419a5505016…`、Pages`71dbcaf2…`。首次deploy在上传前GET401，核对已过期且无未决后单次refresh、原28scope保持、目标GET200恢复；真正上传仅1次，35/35资源/原功能与独立公网version/private双机profile匹配。仅网页，API/Codex/连接器未重启。证据`.local/qa/working-dots-center-2026-11-05/`，设计与原状态保护见[运行三点](docs/design/2026-11-04-conversation-working-dots.md)。本地脱敏历史仍是下条固定边界，不默默改写已验收的bundle。

- **脱敏历史本地副本已完成，三点工作反馈已上线。** [历史记录](docs/research/2026-11-04-sanitized-history-copy.md)：以`dd7e013`为固定源码边界，367个私有main提交全部映射（包含最初365和本轮UI/准备提交）＋1个明确public bootstrap＝368，副本HEAD`2d2fa4a`；初始178个空提交披露，日期/父链/意图一一核对，3,243全对象均可达，无原对象残留/私人值/remote/reflog/alternates，634文件与源清单SHA全匹配。净仓库`.local/exports/pocket-public-history-2026-11-04/`与约3MB同名`.bundle`已验证全量roundtrip；未push或公开。最终完整2,045/公开1,872测试、公开构建、35文件private-marker及独立审查通过。原已有历史/7项private配置保持；正常追加UI/维护提交是授权迭代，未重写原Git。[运行三点](docs/design/2026-11-04-conversation-working-dots.md)源`3b72330`、网页发布源`dd7e013`：最新内容下方3点，仅新鲜原owner真实运行显示，缓存/accepted/排队/等待/断网/终态不假跑；activityEpoch绑定请求起点，堵后台/pageshow旧在途复亮，阅读/节点/焦点/选区保持、reduce静态。59完整浏览器及最后6双浏览器受影响复验、CR通过。build`92bfebf04a0f…`、Pages`4e4b5c8a…`只上传一次，35/35资源、原功能与独立公网version/private双机profile匹配；只共享网页，API/Codex/连接器未重启。无待续外部操作，真机/目视与Alpha公开门槛保留。证据`.local/qa/history-copy-2026-11-04/`、`.local/qa/working-dots-2026-11-04/`。

- **Agent搭建入口与开源隐私防护已补齐（仅源码/文档，未公开或部署）。** 中英文README提供可复制搭建指令、macOS/Node26/Python3.11+/Codex登录/自有HTTPS前置条件与宏观SVG/交互HTML架构图；自定义config全程携带，doctor与真实手机/发送验收分开，普通输入内存与阅读/反馈持久缓存分开。已发现并移除测试/fixture里的私人公共域名，源码导出增加edge适配器、准确双语与6项架构/许可资产；合成入口将7组依赖已安装App的套件显式分类，完整测试保留原生覆盖，公开遥测关闭的验证兼容。默认数据在源码外，`.gitignore`扩展；导出写入前扫描已知本机私人值，privacy:check核对实际index（含重命名）、导出真实文件树与SHA，CI补源码边界检查。最终全测2,041、净导出1,868项合成检查通过，guard/安装专项见[隐私回执](docs/research/2026-11-04-open-source-privacy-boundary.md)；独立安装契约/文档链接/实际导出构建/35个公开构建文件marker检查与架构9/9及四尺寸验收通过。未做目视/实体手机、新Mac首装或公开GitHub CI；两机API/公网版本/现有数据未变。**旧613文件冻结包含测试域名，仅保留历史证据，不能发布；私有原Git历史含个人部署资料，公开必须从最新已检查导出创建新仓库。** 本轮证据`.local/qa/agent-selfhost-docs-2026-11-04/`与`.local/qa/open-source-agent-entry-2026-11-04/`；原许可/新Mac发布门槛继续存在。

- **图标规范统一已上线。** [规范](docs/design/2026-11-04-icon-system.md)：129个Lucide节点用AppIcon，辅助16/操作18/导航20及1.75线宽，13px状态/11px实心停止和既有插图例外明确；普通角色禁随手size/stroke，Radix勾选/品牌/上下文数据环保持。44px纯图标/复制/行快捷/附件目标，toast16、空态32、清空按钮44+输入右56余量。2,032全测、53完整浏览器/设施、独立132屏采样及最终10+4+2组针对复验通过，原文/动作/节点/中英筛选/焦点保持。源`5ecdd19`、build`ab559f31a18a…`、Pages`c5284b2a…`单次上传，35/35资源、原功能、公网version与private双机profile匹配；仅网页，不更新API/Codex/连接器。目视预算限制下用实际DOM/命中验证，没有真机或真实写入。证据`.local/qa/icon-system-2026-11-04/`。

- **排序图标已随选择变化。** [排序菜单契约](docs/design/2026-11-04-compact-sort-menu.md)：智能用排序条、创建用日历、活动用时钟；18px图形、原44px按钮/焦点/勾选及中英文布局保持。2,029全测、8项针对双浏览器和独立复核通过；网页源`38a3e0f`、build`f416d5b5b5b0…`、Pages`0bc78403…`单次上传已核35/35资源、原功能及公网version，private双机profile保持。本轮只共享网页更新，两端API/内置前端保持上一版，无重启。证据`.local/qa/sort-icon-2026-11-04/`。

- **自部署准备版个人部署已上线并回读。** [部署契约](docs/design/2026-11-04-selfhost-personal-deployment.md)：API两机不可变`da53fa3`，网页/Worker`7e24660`、build`1ef5620b64d2…`、Pages`2dff18cb…`。个人ged/wandou profile和cookie/偏好保持，未启用通用强新口令或重置原账号；VAPID、access、relay/反馈、原auth_sessions、source scope、直发策略、交付/附件及隐藏/关注一致，格得原1条queued保持、豌豆0。两机stop/unloaded/up各一次成功，Codex/连接器/本域代理不重启，旧源码和停机备份保留。2,029全测、51浏览器＋4双机链路、豌豆161+6HTTP及恢复mock通过；35/35公网资源与功能、公开version/profile另行对照。格得真实公网登录/只读/退出及cookie属性通过；豌豆无持久明文，fresh公网登录未做，旧session/凭据保持和loopback认证200/公网health200+匿名401通过，不伪称该层通过。已完成单次上传和切换，无待续认证/部署。证据`.local/qa/deploy-selfhost-2026-11-04/`。

- **第一轮自部署开源准备已完成（2026-11-04，源码未公开；个人激活见上条）。** 用户授权“直接优化一波”，当前准备为macOS单拥有者Alpha。已实现bundled桥接与独立配置、120条公开npm/SHA512且版本/图不变、local/MyMac默认公开投影、可信自有HTTPS/Host/Origin/CSRF、setup/doctor/用户服务、强新口令与旧会话保持、源码白名单/FD安全导出、MIT/第三方库存/中英安装文档/固定Action CI。全测2,028、浏览器51、CI合成2,001、协议154+配置10及导出包10HTTP检查通过；独立导出613文件哈希匹配、隔离公开依赖图编译成功、setup幂等/doctor空App拒绝/5个Python入口不需FBT。安全复核3项导出/锁/服务边界均修复，失败与正确结果分层保留。证据`.local/qa/oss-readiness-2026-11-04/`，代码与发布门槛见[新评估](docs/research/2026-11-04-self-hosted-open-source-readiness.md)。公开前仍需真实新Mac/iPhone、实际代理/升级回滚验收、react-remove-scroll-bar2.3.8原始许可文本/公共基线审查及正式repo/tag。源码已本地存档`c5caeaddef890bf0e66c834327e6839bcc9fc261`，冻结613文件到`.local/exports/pocket-0.1.0-alpha.1-source-c5caead.tar.gz`（SHA256见私有frozen-source回执，约1.9MB，published:false/sourceDirty:false）。个人兼容配置已保存在`.local/compatibility/oss-preparation-2026-11-04/`，本轮后续已用于私有激活；原desktop-bridge.json/凭据未改，API升级与公开壳见上条，Codex/连接器未重启。此处源码导出仍非公开发布。

- **紧凑排序菜单已上线。** [契约](docs/design/2026-11-04-compact-sort-menu.md)：加号左侧单个排序图标，智能/创建时间/活动时间勾选，显式选择幂等并记住模式；分类/项目/活动筛选/搜索及桌面当前会话、草稿和消息节点保持。移除常驻两个排序按钮和英文第二排，筛选44px；中英320px和英文390/768px多出56px阅读空间，其他原单行再少6px。英文极窄128/32计数及双选中也不换行；菜单使用标准勾选占位与软色高亮，最小对比5.206:1。最终2,003全测、49项正式浏览器/设施及独立复核通过，34/34公共资源、原功能和公网版本匹配；只上传一次至Pages`67bcc4ba…`，源`c2668cd`、build`59f117acba96…`。无API/Codex/连接器重启或真实写入，既有认证有效，无待续部署。证据`.local/qa/sort-menu-2026-11-04/`。

- **英文版精修已上线。** [本轮契约](docs/design/2026-11-04-english-polish.md)：119个英文词条更自然紧凑；仅英文状态槽66→96px，修复状态/时间挤占标题，信息页动作与ID使用场景短标签；手机筛选和排序/搜索分组，320px搜索与内容边界对齐。缓存选项改为完整插值，中文文本保持。最终包2,000全测、45项正式CSP浏览器/设施、中文40屏零几何差异、独立复核和一次机械检查通过；草稿/原节点/选区及中性初始焦点保持。网页`073700e`、build`51824aac68ae…`、Pages`58cb397b…`只上传一次，34/34资源、原功能及公网版本另行回读通过。仅网页更新，API/Codex/连接器保持；图片检视预算已满，本轮以实际DOM尺寸、文字范围、命中与交互验证为准，未目视/真机。证据`.local/qa/english-polish-2026-11-04/`。

- **中英界面已上线。** [多语言契约](docs/design/2026-11-04-internationalization.md)：默认按系统语言选择简体中文/英文，其余回退英文；设置可手动选择并本地保存，跨标签同步。覆盖主要界面、相对时间、媒体/反馈和加载/离线页，真实正文/项目/模型名称与源状态不翻译，不重挂输入与会话。使用固定i18next依赖和919个英文词条，新增英文README。2,000全测、最终41项双浏览器/设施和独立复核通过；34/34公开资源、原功能检查及公网版本另行比对通过。网页`b0642c1`、build `084a27fe422c…`、Pages `2c5e833a…`只上传一次；两机API/Codex/连接器保持。证据`.local/qa/i18n-2026-11-04/`，没有未决发布或认证操作。

- **左滑等待反馈减法已上线。** [隐藏契约](docs/design/2026-11-03-hidden-conversations.md)：关注/取消关注、隐藏/取消隐藏点击后只显示居中转圈；移除按钮“处理中…”与行内可见“正在保存…”，读屏状态和失败原因保留，列表项不再因等待增高。1,991全测、35项浏览器/设施回归、8项双浏览器等待状态及几何检查通过，独立CR通过；网页`ed308f7`、build `3ae0e1b60111…`、Pages `4b2e8adb…`已回读32/32资源及功能。仅网页发布一次，未更新或重启两机API。证据`.local/qa/swipe-spinner-2026-11-03/`；物理iPhone效果仍以实际使用为准。

- **会话隐藏与焦点修复已上线。** [隐藏契约](docs/design/2026-11-03-hidden-conversations.md)、[焦点规则](docs/design/2026-10-15-inspector-entry-focus.md#2026-11-03-返回列表的竖线与弹窗默认焦点)。两机API为`f29bf5b`；网页源码`7f191e2`、build `e7486b251e35…`、Pages `5ec3cd63…`，32/32资源及功能通过。1,991全测、35项正式CSP浏览器/设施检查、媒体30项专项与独立CR通过。隐藏可从菜单恢复；触摸返回与阅读弹窗默认中性焦点，表单输入/键盘导航保留。API正常stop/up的前后凭据、记录、原Codex/连接器均核对保持，不再重复切换/上传。证据`.local/qa/hidden-2026-11-03/`。

- **阶段性CR与重构已上线。** [本轮范围](docs/design/2026-10-31-stage-refactor.md)：运行时代码`1a99bb7`、验收/契约`5efe5d0`，发布源码`efab002`；1,954全测、正式CSP下14项浏览器前后对照＋7项故障回归、80项分页专项及独立CR通过。11-01核对源码/候选未变，当前凭据无未决记录，单次自动续期2.173秒、原28项scope保持，账号/项目HTTP200；仅上传一次至Pages `24175280…`，build `09f6c5e7b370…`，32/32资源与功能通过。10-31未决refresh未重放；原控制协议/DOM/样式保持，后端取消等下一阶段候选已记录。

- **会话信息稳定布局与缓存已上线。** [契约](docs/design/2026-10-31-info-dialog-cache.md)：定时任务加载/空态同一行；模型摘要与计划详情30秒页面内缓存、过期保留显示后台读，鉴权/来源清理撤销迟到结果，模型权限和回执不缓存。1,950全测、独立CR、四组高度/重复打开与20项边界浏览器检查通过；build `6648d57ec3e5…`、Pages `c2cb0c81…`已回读32/32资源及功能通过。命令行网络超时后沿同次部署换浏览器核验并续验，只上传一次；证据`.local/qa/info-cache-2026-10-31/`。

- **关闭按钮初始高亮已修并上线。** 设置与会话信息弹窗仅在初开聚焦中性标题，Tab和关闭归还焦点保持，新建/改名输入聚焦不变。40组页面、22项交互边界、1,938全测通过，build `d8d0b9adcf98…`已发布至Pages `2445c9ea…`，32/32资源和功能检查通过；见[焦点记录](docs/design/2026-10-30-compact-settings-and-controls.md#2026-10-31-初始焦点)。Cloudflare登录恢复已回流FBT d3b5d37，正式helper已完成本次发布所需续期与目标HTTP200验证。

- **本轮UI已上线并回读。** [设置与控件](docs/design/2026-10-30-compact-settings-and-controls.md)：设置与会话信息更紧凑、字段对齐，修复嵌套Modal标题margin；创建加号/排序默认透明。过程消息取消整条复制，一小时后移除时间页脚，普通回复/子任务结果/代码复制保持。1,887项全测、58组布局/边界检查、消息动态/阅读锚点检查与独立CR通过；统一build `b2fe8f9db218…`，其中已保留并回读手机实色sticky顶边。Cloudflare登录已恢复、目标项目已核对；Pages `f00227d4…`只上传一次，32/32公开资源通过。Node功能探针遇网络超时后，保留原四项断言改用实际curl请求完成核验，最终ready=true。

- **后台正文预取已上线并回读。** [契约](docs/design/2026-10-31-transcript-prefetch.md)：复用原rank、有效未读加200，当前交互优先；状态32项，正文固定8候选/1并发，前台同ID接管、已有版本跳过、不标读或制造点击。网络退避与全局抢占冷却保持弱网节制；1,938全测、独立CR、真实App慢网/接管/容量和hook边界通过。build `11e85a69a43d…`已发布至Pages `3edca700…`，32/32文件及原功能检查通过，只上传一次。连接保留已确认的详情5秒/输入策略，本轮不新增后台打开未点开的会话。

- **已随本轮UI发布：iOS顶部滚动边缘模糊。** [修复与接续](docs/design/2026-10-30-ios-header-scroll-edge.md)。iOS27主屏幕PWA复现用户所述上半部模糊、菜单恢复；仅加手机标题栏sticky/top0，原生A→B→A确认效果，最终无注入包的新建关闭和详情返回均与清晰基线像素一致。1,882项全测、12组布局对照、最终28组双浏览器与独立CR通过。候选build `92f5211694d0…` 已在本机回读。14:57 UTC通过同一官方device协议的curl传输恢复凭据，原28项权限不变，目标账号项目已HTTP200回读；认证证据在`recovery-evening/`。此修复已合入`b2fe8f9d…`并发布到`f00227d4…`，不重复上传。本轮认证/模拟器/fixture均已清理，不重启Mac服务。证据在`.local/qa/top-edge-2026-10-30/`、`top-blur-native-2026-10-30/`和`top-blur-research-2026-10-30/`。

- **已上线但未解决用户现象：详情返回模糊的滤镜清理。** [记录](docs/design/2026-10-19-visual-system.md#2026-10-30-标题栏背景模糊复查)。用户最新确认：关闭新建弹窗或详情后，“全部”和加号上半部分仍模糊，开关菜单会清除；此前“进详情再返回变糊、开菜单恢复”的反馈继续有效。移除菜单/弹窗和实色消息下多余的全部背景滤镜，保留压暗、发送光晕及文字扫光。1,882项全测、构建、12次返回循环等明暗主题28组浏览器样本和独立CR通过；真机残留未直接复现，不宣称根因及效果已完全证实。证据`.local/qa/opaque-top-2026-10-30/`。原Cloudflare登录已恢复且权限未扩大；仅上传一次最终版，资源超时沿原部署回读，最终32/32文件和项目功能通过。公网与本机build `6cc465b4fcf2`，没有服务重启或待续部署。

- **最近已上线：未验证CLI版本改为warn。** 用户明确取消仅因版本未列入清单而阻止操作。[新策略](docs/design/2026-10-13-desktop-compatibility.md#2026-10-30未验证cli只告警)：合法可运行版本继续真实RPC，stderr有界告警进服务日志；真实探针/权限/归属/结果与unknown保护保持。本机1,882项全测及0.166隔离协议通过；豌豆0.164的25项针对回归、旧/新create对照及新建→改名→归档→恢复关键链通过。两机API已切到b896，队列/操作记录、凭据、scope、反馈配置与发送策略核对保持，Codex和连接器未重启。豌豆初次10文件矩阵420秒超时不计通过：隔离CLI初始化会遗留插件git网络子进程，已清理仅本次测试组并保留诊断；后续采用有边界验证。公网登记异常在prestop前自然恢复，两机公网health已独立读回正常。证据`.local/qa/cli-version-warning-2026-10-30/`，不重复发布或切换。

- **最近已上线：XML结果与引用尾段兼容。** [解析修复](docs/design/2026-09-30-codex-markup-and-current-questions.md#2026-10-30xml结果后跟引用信息时变成代码框)：只消解完整heartbeat/子任务包装之后的纯记忆引用尾段，正文中的代码/JSON及未知格式保护保持。截图原消息从486px代码框恢复到142px正常正文，文章链接与复制可用；55项相关回归、独立CR、最终包76项双浏览器及公网32/32文件/功能通过。初次全测受新版CLI前置阻挡38项，现已进入上条warn修正，不能把初次结果写成全量通过。仅网页，无真实发送/连接/归档；证据`.local/qa/heartbeat-citation-2026-10-30/`。

- **最近已上线：顶部下拉加载更早消息。** [滚动意图与分页](docs/design/2026-10-28-history-pagination.md#10-30顶部下拉自动读取)：向上翻到顶部后，松手/滚动停稳才加载，一手势一批；滚轮支持，恢复/程序scroll不连载。复用原reader与三页窗口，慢结果遇到移开、输入或选字先保留；fresh下拉可复用已加载结果或重试普通错误，expired与较新/重核结果保留明确入口。返回最新/提交/手动操作取消候选，键盘收起与触摸返回边缘有保护，手动按钮保持。1,866全测、手势与收键盘19项、独立CR及最终包80项双浏览器通过，公网32/32文件与功能回读通过。仅前端，无真实发送/连接/归档或Mac服务重启；WebKit触摸与键盘为合成验证，物理iOS惯性效果待使用。证据`.local/qa/earlier-auto-2026-10-30/`。

- **最近已上线：中性银色扫光。** 用户已明确确认蓝色版能看到，随后要求白/灰/银色质感。[当前配色](docs/design/2026-10-29-request-title.md#同日改为银灰质感)采用浅色灰银、深色银灰边＋白色中心，保留1.08秒周期、带宽及120/180ms状态缓冲。1,854全测、最终WebKit亮暗/动态降级、独立CR与受控目视通过；公网32/32文件及功能回读通过。最低配色对比4.695:1，暗色约31–33%墨迹变化超过16级，避免退回初版弱信号。仅共享网页更新，无Mac服务重启或真实发送；银色版体感待使用反馈。证据`.local/qa/request-title-silver-2026-10-30/`，补充样本在前一轮QA目录的`neutral-final.json`；原可见性诊断和[客户端版本](docs/design/2026-10-30-client-version.md)继续按各自文档接续。

- **最近已上线：会话视频播放。** [视频契约](docs/design/2026-10-29-message-video.md)：助手回复的本地MP4/M4V/MOV/WebM（含图片语法引用）使用原生内联播放器、进度控制和下载；按需Range传输，512MiB/16路/64KiB背压，普通文件20MiB边界保持。1,831全测、60项原生HTTP、24项固定包、独立CR与32/32公网文件通过。给定真实H.264样本已在正常Chrome/WebKit入口播放并seek；同一节点保持，公网这次完整传输约22–26秒，初始探针过短超时已校准，未为此改播放器。两机API/网页均已更新，Codex与连接器未重启，无发送/改名/归档。实体iPhone全屏未直接验收；证据`.local/qa/message-video-2026-10-29/`。

- **最近已上线：Impeccable全路径精修。** [本轮契约](docs/design/2026-10-29-impeccable-sweep.md)：共用固定header/滚动body和顶层Escape保护；搜索/口令完整点击范围、44px目录及显隐控件；问题/队列编辑不再误撑开主composer，图片转文档首点不再被滚动抢走；设置开关统一、未读去重复底色。1,792项全测、此前全路径检查、最终包24+72项受影响复验、独立视觉/CR及32/32公网文件通过。07b5候选发现BODY-focus busy缺口后未发布，修复后的8da9才上线。本次仅网页，无Mac服务重启或真实会话操作；物理iPhone仍待使用。证据`.local/qa/impeccable-sweep-2026-10-29/`。

- **最近已上线：反馈弹窗留白。** [同日精修](docs/design/2026-10-29-feedback-infrastructure.md#同日反馈弹窗的留白与滚动修正)：修复section漏接内容padding，手机/窄屏/桌面分别20/16/24px，与标题对齐；补底部安全区，固定关闭入口，正文与截图分别滚动，沿用键盘visualViewport。1,786项全测、150项尺寸/状态/键盘检查、独立CSS与视觉复核通过；公网32/32文件与功能检查通过。只更新共享网页，无API/连接器/Codex重启或真实发送。实体iPhone仍待使用；证据`.local/qa/feedback-spacing-2026-10-29/`。

- **最近已上线：可复用截图圈注反馈。** [实现与验证](docs/design/2026-10-29-feedback-infrastructure.md)、[Feedback Kit](packages/feedback-kit/README.md)。设置「反馈问题」及详情「刚才不顺」可截图、框选并写说明；摇一摇默认关闭，需明确开启。离线先记文字，联网补图；独立草稿、认证持久记录、PostHog签名回调、跨机转发与固定requestId复用现有队列，未知不重放。1,786项全测、88项最终包双浏览器、168项远端＋最终7项宿主测试和独立CR通过。两机各一条合成反馈已经送达本开发会话，四个图片文件与提交字节一致，重复回调后各只有一条原生用户消息。PostHog两条目标已启用；这是链路验证，不代表实体iPhone摇动与长期弱网体验已验收。证据`.local/qa/visual-feedback-2026-10-29/`及`.local/qa/feedback-host-2026-10-29/final-summary.json`；不要重复提交验收反馈。

- **最近已上线：停留5秒提前连接。** [触发与边界](docs/design/2026-10-28-dwell-connection.md)：连续可见、在线且无待发/未知/管理阻塞时尝试一次；输入仍有独立机会，并立即接管同一单飞打开，无需等被动lookup。后台/切换/弹层取消计时，skipped不新增错误或访问时间。1697项全测、288项远端测试、50项最终包双浏览器与独立CR通过；只读公网、31个发布文件及功能回读通过。连接会按需打开Mac会话，不是纯网络预热；未进行用户会话的真实自动打开或发送试验、未实测内存/电量，实体iPhone仍待实际使用。证据 `.local/qa/dwell-connection-2026-10-28/`。

- **最近已上线：更早消息入口边界。** [22:20反馈与补修](docs/design/2026-10-28-history-pagination.md#同日2220的入口反馈)：该反馈当时使用分页前旧`5779fd…`，已说明回列表点击顶部更新；更新后的本人效果未确认。同时独立修复原生/保存历史的80条及16万字符预算遗漏（含部分裁剪），轮内分页和相关来源合并也保留入口；单条24k和无关分叉不误报。当前仍点击按钮加载，没有新增触顶自动连载。

- **最近已上线：加载更早消息与压缩历史。** [历史分页](docs/design/2026-10-28-history-pagination.md)支持主动加载、较新窗口及返回最新，保持阅读锚点、输入/选区与长Query；仅旧页展示，不参与发送回执或已读。普通和同名 `.jsonl.zst` 来源共用有界只读worker；完整单页也能补回原4MiB尾窗口之外的内容。1643项全测、123项远端测试、最终包双浏览器18项与独立CR通过；格得公网实际读取80+80条，压缩样本从12条尾部补全55条，豌豆用20条分页验证20+25条连续历史。没有真机复验；证据 `.local/qa/history-pagination-2026-10-28/`。

- **同轮反馈修复已上线。** [子任务通知](docs/design/2026-10-28-subagent-notifications.md)把XML/JSON改成紧凑状态与可展开结果，保留可读复制；隐藏正文不提前标读，修复复制后焦点交接导致按钮上移22px的失点击及动画中取消边界。[派生Query](docs/design/2026-10-28-delegated-query.md)仅投影明确create_thread委派格式，按同轮次/共有ID补首条请求，已知委派来源不进入同文回显候选。真实会话原生9条与保存记录正确合成10条，1837字符请求指纹保持；缓存和公网回读也已验证。相关浏览器/CR证据在 `.local/qa/subagent-notification-2026-10-28/`、`.local/qa/delegated-query-2026-10-28/`。

- **已记录：Pocket开发一个月的札记。** 项目[迭代复盘第十一节](docs/research/2026-10-11-pocket-interaction-retrospective.md#十一pocket-一个月使用经历怎样留在产品里)保存主体，Life札记索引与Daily Paper已回读；稳定ID `note-20261028-pocket-one-month-retrospective`。本次在途历史分页不计入札记当时的完成成果。

- **最近已上线：键盘打开时右滑返回。** [交互契约](docs/design/2026-10-15-motion-implementation.md#2026-10-28-键盘打开时的边缘返回)：取消输入焦点对消息区边缘手势的总禁用，完成后才blur/返回，短滑取消保留输入；IME、选区、新输入、代码表格与多指保护保持。1569全测、38项目标回归、32项源码/10项最终包双浏览器和独立CR通过；31/31公网资源和功能回读通过。仅网页改动，物理iPhone未直接复验；证据`.local/qa/keyboard-swipe-back-2026-10-28/`。

- **最近已上线：客户端缓存条数设置。** 设置新增「最多缓存会话」，可选20/50/100/128默认/200/500；已手动选择的值保留；同浏览器跨电脑共用，仍受30MiB/7天限制。降低立即按LRU淘汰副本，提高不预取，不清认证/草稿或影响列表数量。1565项全测、34项偏好/存储专项与独立CR通过，设置行为、跨标签/真实IDB与最终手机几何检查通过，31/31公开文件及功能回读通过。实现与边界见[缓存契约](docs/design/2026-10-28-reading-cache.md)，证据在`.local/qa/cache-settings-2026-10-28/`。该次只更新网页；当时待发布的后端历史缓存/图片解析修复已随本轮历史分页更新到两机。

- **2026-10-28仓库CR，前后端已全部发布。** [代码质量记录](docs/design/2026-10-28-code-quality.md)：修复迟到认证响应影响新登录、预连接绕过历史缓存10项上限、首批旧历史误占新Query位置，以及图片截断解析/重复定义权限不一致；开启TypeScript未使用项检查。最终1557项全测、隔离构建、Chromium/WebKit共20项界面检查与独立CR通过；证据在`.local/qa/code-quality-2026-10-28/`。登录检查使用源码，首读Query顺序使用最终构建，均为合成接口；前端认证/Query交接修复已随本次缓存设置网页发布，后端历史缓存/图片权限解析随后已随历史分页更新到两机API。物理iPhone未直接验证。截断消息的内嵌图片采取保守关闭；下面的已发布版本仍是线上基线。

- **最近已上线：分层阅读缓存。** [缓存契约](docs/design/2026-10-28-reading-cache.md)与[组件选择](docs/research/2026-10-28-cache-components.md)。采用idb，20会话有界内存＋初版50会话/30MiB/7天IndexedDB（当前默认128，见上方缓存设置）；认证后先展示缓存，后台核对，退出/401跨标签清理。只存阅读投影，回执/权限/读水位不借缓存更新。GET 304与sync 204减少未变正文传输，旧接口兼容；跨标签版本、迟到来源、相同正文写盘频率均有保护。1540项全测、源码36项/最终包23项浏览器、独立CR通过；合成gzip正文约20KB→条件响应0B。网页31/31公开文件、两机API53项远端检查和公网认证回读通过；两机目录/正文/历史均实际304，豌豆sync实际204。实体iPhone长期效果待实际使用。

- **最近已上线：滑动正文收键盘。** [交互契约](docs/design/2026-10-13-reading-composer-and-row-state.md#2026-10-28-滑动正文收起键盘)：主输入框聚焦时主动纵向触摸收键盘，保留草稿/选区与阅读位置；自动scroll、IME、选字、横向内容与返回边缘保持。收键盘期间暂停近底跟随，视口稳定后按实际位置恢复。1482项全测与构建通过，独立CR修复多指最后触点在消息区外结束时的阅读保护泄漏，48项专项与最终包23项双浏览器冒烟通过，30/30公开文件及功能回读通过。缓存后续落地见上条；完整消息增量仍未实施。

- **最近已上线：新建、阅读与弱网连续性。** [创建确认](docs/design/2026-10-09-creation-and-send-feedback.md#2026-10-28提交后回列表行内确认)：提交立即回列表，蓝色进度在首Query明确accepted后转绿，仅异常额外提示；保留失败输入/原ID，后台核对和新建标题预取，首次读取失败自动退避重试。[输入滚动](docs/design/2026-10-25-send-ui-continuity.md#2026-10-28输入测量期间保持阅读位置)修复WebKit测量输入高度导致的93px反复跳动。[文本文件](docs/design/2026-10-22-message-components.md)支持MD/TXT等页内预览，关闭恢复、原件下载及同次预览字节复用；顶部toast半透明/blur已撤下。1475项完整回归、创建178项/预览92项/输入48项双浏览器验收、统一包34项冒烟与独立CR通过，30/30公网资源及功能回读通过；没有新增持久正文缓存或缓存库，缓存现状与后续测量点见[架构](docs/ARCHITECTURE.md#阅读缓存与传输)。

- **最近已上线：首开加载反馈。** [反馈复核](docs/design/2026-10-28-feedback-loading.md)。真实首开到内容可见约13.3秒，正文区无状态；现在无缓存首读显示明确读取提示，单路先空不提前进入空态。1442项全测、38项双浏览器、独立CR及30个公网文件/功能回读通过。读取总耗时原因未定位，本轮不宣称提速。另一条标题反馈已确认当时Pocket正确回读了原生保存的Query摘要，当前名称也与Codex一致；未改同步或重放命名。

- **最近已上线：Impeccable设计精修。** [审查与修改](docs/design/2026-10-28-impeccable-polish.md)。独立视觉/技术评审后，提前披露缺失必填目录、把无正文错误恢复放回阅读区、清除归档/设置4px命中重叠、提高placeholder对比并校准模型/上下文触控与字段间距。完整路径另复现并修复既有首字符丢失：原生编辑事件的预连接后置到下一任务。1436项全测、创建/恢复/几何/输入专项及独立视觉通过；30个公网资源/功能与本机公开构建已回读。仅网页更新，未改后台或真实会话，物理iPhone/原生IME未直接复验。

- **最近已上线：定时检查正文空白。** [消息标记修复](docs/design/2026-09-30-codex-markup-and-current-questions.md#2026-10-28定时检查正文空白)。真实会话中的heartbeat包装被Markdown当作HTML整块隐藏，内容本身没有丢失；现在触发显示“定时检查”并可展开原检查内容，回复显示message说明，DONT_NOTIFY不隐藏历史。1432项完整回归、11项专项、184项真实样本双浏览器、独立CR及30个公网文件/功能检查通过。只更新网页，原消息/定时执行/回执/已读不改，两机服务未重启；物理iPhone尚未直接复验。

- **最近已上线：Query原位交接。** [发送连续性](docs/design/2026-10-25-send-ui-continuity.md#2026-10-26query在同一行更新)。新建和旧会话的提交/队列/正式消息合为阅读区稳定行，状态和操作在行内更新，消除跨区搬移与旧卡焦点滞留；完整原文/附件、unknown、草稿和滚动保护保持。无编号早到正文只作有界等待；读取失败或18秒超时后恢复独立记录，此时可能同文并存，不能误认身份。1421项全测、32项双浏览器场景、248帧首个操作区贴底检查、最终CR及30个公网文件/功能回读通过。仅共享网页更新，两机API与Codex未重启，更新后真机体验待观察。

- **最近已上线：新建首条消息与标题。** [契约与取证](docs/design/2026-10-26-create-delivery-and-title.md)。真实回放确认创建后待发、手动直接发送和旧Query标题；连接就绪现唤醒本会话队列，保留FIFO/原策略/unknown，停止代次保护覆盖整轮与timer。刚创建并打开的会话在60秒内每5秒补一次目录同步。1401项完整回归、124项队列组合、18项标题浏览器与独立CR通过，30个公网文件/功能回读通过。格得API已更新，重启前后9条待发和发送/暂停账本及凭据哈希一致；豌豆后台未变。更新后真机效果仍待自然使用验证，连接本身的慢读取未作提速承诺。

- **最近已修复：PostHog正式CSP阻断。** [纠错记录](docs/design/2026-10-26-usage-feedback.md#同日纠错正式-csp-拦截了上报)。用户提交真实反馈后只查到QA记录，发现正式站与本机HTML的connect-src仅self；原fixture漏带正式响应头。现在只放行两个PostHog必要域名，8项旧策略复现、34项带CSP浏览器、1378项全测及30个公网文件/功能检查通过。网页与格得Pocket API已更新，队列/派发/分组/备注/置顶哈希保持，仅sourceInfo正常刷新。原反馈此前未入库；15:40用户补交的“测试一下”已在production由CLI读回，标记/说明共用反馈ID，并查到对应18秒录制。CLI本人授权、项目/schema/只读SQL已验证，0.18.12目标参数按AGENTS的新入口。

- **最近已上线：运行中排除未读。** [阅读契约](docs/design/2026-10-22-pocket-read-state.md#2026-10-26运行中与未读的列表呈现)已补齐此前漏做的方案：有效运行中不计入标签、数量和筛选；水位保留，结束后按实际阅读判断，等待操作不变。1377项完整回归、83项定向、60项双浏览器、独立CR及30个公网文件/功能回读通过。原全测发现一项测试时钟偶发性，已固定测试时钟并补异时钟合并回归，产品阅读存储未改。仅共享网页更新，无Mac服务或Codex重启。

- **使用反馈与回放的初始验证（后续发现正式CSP漏验，以上条纠错为准）**：[PostHog接入](docs/design/2026-10-26-usage-feedback.md)。本人项目688532，Free方案及Session Replay已启用；发送/回执/可见内容/前后台分开观测，会话信息加入“刚才不顺”。1373项全测、34项Chromium/WebKit与SDK阻断验证、30个公开文件与功能回读通过。合成事件已在真实PostHog回读，两段录制入库；独立回放页已实际显示Pocket画面并可重新播放。列表内嵌播放器本次曾加载失败，改从Share→Open in new browser tab验证成功。原owner、发送与阅读水位不变，未新增自动化；实体手机和真实使用痛点仍待自然使用取得证据。

- **最近已上线：状态与阅读空间**：[实现与取舍](docs/design/2026-10-26-status-reading-space.md)。已知压缩与accepted回执可回到单条输入栏，保留上下文详情/核对和停止；按对应控件去掉已知重复的压缩、审批、连接和归档说明。1366项全测、最后25项定向、116项双浏览器与29个公网资源/功能回读通过。390px测试场景底部由约214.4缩到46px，正文增加约168.4px；unknown/pending、附件、IME和必要错误保护保持。

- **剪贴板先观察**：[原生结果与边界](docs/design/2026-10-09-startup-and-query-entry.md#2026-10-26paste出现但未预填)。用户反馈框内粘贴有时成功、有时失败，并明确先观察。当前组件在iOS26.5 Safari、iOS27 Safari和27主屏幕Web App中均通过合成文字的原生Paste；这不代表用户真机问题已解决。保留现有自动读取与手动恢复，暂不继续改动，等新的实际现象再定位。

- **最近已上线：新建确认延迟修复**：[定位与验证](docs/design/2026-10-25-create-confirmation-latency.md)。近期格得实际创建约3秒；前端现对已登记的新建请求立即独立核对，不再等待4秒空闲计时或慢旧归档批次。同ID单飞、后台/离线暂停、恢复及时检查，未知不重放。合成后端已就绪场景的额外反馈由3810/7404ms降至54/92ms；1354项全测、浏览器计时、独立CR与29个公网资源/功能回读通过。实际手机耗时不由合成计时保证。

- **最近已上线：重命名快速清空**：[交互契约](docs/design/2026-10-11-rename-and-management.md#2026-10-25快速清空名称)。名称右侧清空按钮可一键删除原标题并留在输入框；空白名称禁用保存，未决操作保护保持。1344项全测、73项双浏览器检查及29个公网资源/功能回读通过，只更新共享网页。

- **已完成：豌豆更新与附件恢复**：[本轮契约](docs/design/2026-10-25-wandou-update-and-attachment-recovery.md)。CLI0.164精确版本通过142项真实隔离验证；豌豆API与内置网页已切换到 `1d6da5c`，公网附件修复也已发布。空稿附件列表失败不再强迫大面板，条内保留轻量重试，真实附件保护保持。1344项全测、远端170项、44项浏览器、独立CR和29个公网资源通过；目录/scope/型号读取正常，未重启Codex或连接器。

- **最近已上线：发送画面连续性**：[输入与发送连续性](docs/design/2026-10-25-send-ui-continuity.md)。普通发送保留输入焦点，确认后不再误缩为一条；迟到回执不覆盖等待期间的上滚位置。IME、明确收起和键盘导航保持。1342全测、48项双浏览器与833帧消息交接检查通过；29个公网资源及功能回读通过，仅网页更新，系统键盘/PWA真机尚未直接验证。

- **10-25发送等待候选，部分已处理**：[调查结果](docs/research/2026-10-25-updates-and-send-experience.md)。发送POST无deadline、等待回执锁按钮、跨会话队列串行与重复history曾隔离复现。10-26已针对新提交连接就绪后的等待增加本会话唤醒；普通后台扫描仍串行，其余候选未实施。CLI兼容与豌豆更新已完成此前阶段；后端仍按需发布，未安装自动更新任务。

- **最近已完成**：[引用、刷新和控件](docs/design/2026-10-23-annotations-refresh-controls.md)。问题优先、引用紧凑披露；刷新反馈不叠加且来源失败不假报成功；顶部选中态增强但保持克制。1342项全测、两阶段双浏览器、独立CR/视觉与29个公网资源/功能检查通过。仅网页发布，原始消息/回执/阅读水位与两机服务保持。

- **已完成且无需重做**：Pocket阅读水位＋单向吸收桌面已读，以及详情横滚/右滑返回修复均已发布、回读并清理。没有待续上传、服务切换或未完成的本轮外部操作。
- **继续方法**：先读[AGENTS](AGENTS.md)和本页，再沿对应设计入口看代码与回执。普通接续不用重读全部历史；需要原始取舍时看[HISTORY](HISTORY.md)。

## 继续方式

用途保持为手机查看和接续 Mac 上的 Codex 原会话。欧吉安已认可统一、安静的视觉方向，后续精修完整操作路径，优先减少重复入口、反馈和阅读占位，不重新推倒整套UI。设计复盘见[顺手标准](docs/research/2026-10-11-pocket-interaction-retrospective.md)。

开发按新的用户反馈继续，不恢复旧“持续打磨 Pocket”heartbeat：2026-09-30用户取消，10-01回读为PAUSED。这与Pocket服务、用户已提交队列和通知的运行无关。Claude接入仍延缓；Happy/HAPI只作为阅读模型的参考，没有迁入其runner/hub。

**内置录音转写暂缓（2026-11-07，欧吉安确认）。** 继续沿用微信／豆包输入法的语音转文字。Hermes客户端研究中的内置录音/ASR小样不进入当前开发；只有本人明确恢复该方向时再接续。切会话/断线恢复的协议经验保留作后续连接改造参考，本轮没有发现需独立立项的Pocket同类故障。来源见[研究后续取舍](docs/research/2026-11-07-hermes-clients-for-pocket.md#同日后续取舍)。

2026-11-05新增[对外价值与竞品复核](docs/research/2026-11-05-pocket-value-and-differentiation.md)：更新HAPI已能导入/同步旧Codex会话的事实，加入官方Remote与Bridge直接对照；建议macOS单拥有者Alpha与外部同场景验证，未做竞品实机、用户招募或公开发布，不改变当前开发优先级。

## 最近已验证版本

| 范围 | 已核对记录 |
| --- | --- |
| 公网与本机 | [x.fangs.cc](https://x.fangs.cc) / [threads.local](https://threads.local)；API loopback4397、连接器健康4399，配置在 `config/` |
| 公网前端/网关源码 | `978d80ea7e3a51388ce687a0f7af780be53a3735`；同消息图库／常见文件预览／归档分类，原状态预取与弱网反馈保持 |
| 两机API源码 | 格得`e9a552913d33be8e36c25af09bfbd10ae7eab914`/PID26770；豌豆仍`fc86637f601cc2e7024c5b80eae9250322341139`，本轮未连接或切换；格得connector12894/Codex不动 |
| 前端build | 共享公网/本地dist及格得API内置 `c7be8a180c72a73c82abc4cfb2609743c9ddcc42dbbbaa07689bae14f9b65219`；豌豆内置仍`f9ac7165…` |
| Pages部署 | `5afc4f01-32c3-4543-8bdb-ba1047bf39f4`；单次上传exit0/ready、243/243资源/功能、独立五资源哈希一致 |
| 本次验证 | 2484完整全绿、102同版浏览器、284不可变API、真实JPEG200/bytes/hash/解码、独立CR/开发资产/module MIME/资源预算验证；物理iPhone及全部原生codec另验 |
| 本次证据 | `.local/qa/file-previews-2026-11-12/verification.json`、actual-jpg-preview/decode、独立CR、原红例/设施对照、API与Pages/静态回执；图库及菜单早期证据留image-gallery-2026-11-12 |
| 本次数据与运行 | 格得API一次保护切换及网页单次发布；旧2queued/凭据/偏好/订阅保持，Codex/connector未重启，无真实发送/归档/源数据/目录授权修改。豌豆未连接、最新完整接续包保留；OAuth原有效仅verify，无本轮续期或未决 |

上述最新发布已回读完成，不重复上传。后续涉及运行维护时再查实际进程、服务配置和公网；旧发布与详细描述沿对应设计记录及[整理前快照](HISTORY.md#2026-10-23-接续整理前快照)回溯。

## 必须保持的产品决定

| 主题 | 当前行为与权威入口 |
| --- | --- |
| 阅读状态 | 客户端按电脑＋来源scope＋thread ID保存版本水位，不存正文。有效运行中仅排除列表未读表现，结束后按水位判断；实际可见阅读立即标读，新鲜桌面已读提示只推进对应版本。原生旧true不反弹。见[阅读状态](docs/design/2026-10-22-pocket-read-state.md) |
| 单向合并边界 | 原生只有会话级布尔标记，没有逐消息水位。服务端将提示绑定精确内容，至少两次间隔2秒复核；未知、运行中或扫描失败撤销候选。列表运行互斥只影响呈现，不推进已读或改变桌面提示规则 |
| 阅读与输入 | 默认单条输入栏，展开保留原textarea、草稿、选区和IME；错误在对应卡片/输入条内轻量呈现。见[单条输入栏](docs/design/2026-10-13-reading-composer-and-row-state.md)、[反馈收敛](docs/design/2026-10-22-reading-errors-and-sort.md) |
| 导航与排序 | 分类/项目、状态、排序是独立维度。全部/关注/置顶保持；Pocket关注与Codex置顶独立。创建按创建时间，活动及列表显示时间按最后消息时间，不能用点击时间冒充。见[智能排序](docs/design/2026-10-14-smart-navigation.md) |
| 多机与模型 | 电脑信息只在设置，记住选择，原owner/目录/模型/权限不跨机。支持同型号思考强度；新建保留目标桌面的有效默认强度，不能统一硬编码Ultra。跨型号仍未开放。见[多机](docs/design/2026-10-17-multi-machine.md)、[模型](docs/design/2026-10-18-model-settings.md) |
| 发送与缓存 | 自动直接发送默认开，只影响新提交并逐条保存策略；旧队列不升级，未知不重放。状态预取最多32项，正文固定8候选/1并发，未读加权，运行约5秒／未读约30秒可再次验证，当前交互优先；较新缓存可先于实时响应展示，后台不连接或标读。见[直发](docs/design/2026-10-22-auto-direct-send.md)、[预取](docs/design/2026-10-22-active-thread-prefetch.md)、[活跃阅读接续](docs/design/2026-11-11-failed-turns-and-live-prefetch.md) |
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
- 格得当前e9a5529 release复用9e7不可变依赖，324个生产包无更动；直接回退0f1e0d2及依赖祖先继续保留。豌豆仍fc86637。本轮切换／停机备份／逐条保护和最新远端接续包在`file-previews-2026-11-12/api-deploy/`，旧local-visual转移包由新包替代，旧回执保持；清理前按实际软链重新核验，不按日期删除。
- Pages认证失败先按[FBT认证恢复](/Users/fangs/workspace/fbt/workflows/pages-site/docs/auth-recovery.md)识别生效来源与未决记录，恢复后核对上传阶段；已上传但验证未过使用原部署 `resume --resume-verification`。不要用可能隐式续期的whoami试探未知refresh。
- 10-25历史清理：当时的临时浏览器、fixture、两次传输tar、重复baseline/fixed-dist及未启用的失败release `fa1168d…` 已清理。当时的当前/回退`0dbdf39…`、依赖与连接器release曾保留；后续引用以版本表和实际软链核验，旧清理回执在 `wandou-update-2026-10-25/final/`。旧脚本中的已删tar不是现成恢复包，继续发布须重新准备。
- 仅文档维护检查事实、链接和diff后本地commit；不跑产品部署。功能改动的验证与受控真实发送范围遵循[QUALITY](docs/QUALITY.md)。
