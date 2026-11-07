# Hermes WebUI / Hermex：Pocket 自用能吸收什么

2026-11-07（Asia/Shanghai）。欧吉安给出两个仓库，询问是否研究过、再研究对Pocket有什么可借鉴和吸收之处。本轮沿用本会话的自用优先语境，研究和隔离验证，不安装、迁移或修改产品。

## 先恢复历史，再对齐当前对象

Hermex明确研究过：09-08的[近期iOS工程参照](../../../../side/research/recent-influential-ios-apps-engineering-practices-2026-09-08.md)，以及10-13的[Hermex专题](../../../../side/research/hermex-for-us-2026-10-13.md)。后者固定旧源码`c9efaa97d6f020df8bb8b4c91c1b36648fe72f33`，已经看过hermes-webui作为连接后端和SSE恢复协议。本轮在相关研究目录未找到单独深入webui原仓的旧专题，不能说它从未被看过。

| 对象 | 本轮不可变来源 | 它是什么 |
| --- | --- | --- |
| [hermes-webui](https://github.com/nesquena/hermes-webui) | master `f3606dd9f00942b08ebda66e7cb837a34d435e02` | Python＋vanilla JS的Hermes浏览器工作台，含手机/PWA适配、原生Hermes服务连接、会话/运行事件和工作区；不是Codex Desktop桥接 |
| [Hermex](https://github.com/uzairansaruzi/hermex) | master `75477965dc871003bca31f13ec5a021a07893157` | SwiftUI iPhone/iPad客户端；新版源码2.0以直连Hermes主机为主，webui标为Legacy，提供迁移路径 |
| Pocket | `8c88271`，本轮开始工作区干净 | Mac上原Codex会话的PWA入口，保留原owner、模型、cwd与权限；当前已上线HTML交互预览 |

两份最新LICENSE正文均为MIT。选中源码按完整Git tree的blob SHA验证；不把master代码当成已安装的商店版，未运行Hermex或Hermes后端，未核对最新商店功能。本地证据在`.local/research/hermes-clients-2026-11-07/`，没有真实对话或凭据。

**建议借输入与恢复机制，保留Pocket执行后端。** 最小、最直接的增量是引用入草稿与安全取回上一条输入；语音输入值得做小样；事件恢复契约用于后续长会话/连接优化。通知、缓存、原生分享与更宽工作台都有已有能力或平台条件，不能整体算作新缺口。

## 1. 优先小样：选一段回复，在原会话里继续追问

WebUI的[引用格式和追加逻辑](https://github.com/nesquena/hermes-webui/blob/f3606dd9f00942b08ebda66e7cb837a34d435e02/static/messages.js#L891)将选中文本转成引用，已有输入存在时追加，保持为草稿；Refine也只填入引用与提示。Hermex的[ComposerQuote](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobile/Features/Chat/ComposerQuote.swift#L3)把明确选中的引用与手输文本分开，稳定UUID使相同段落可以分别移除，发送时再组合成普通Markdown；[实际发送调用](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobile/Features/Chat/ChatView.swift#L2960)消费该结构。

Pocket已有[引用批注显示/解析](../design/2026-10-23-annotations-refresh-controls.md)，本轮src检索与Conversation读取未发现从Pocket回复选取内容、直接加入composer的入口。显示桌面已经生成的引用与手机直接创建引用是不同的任务。因此可以借一个很轻的“引用并提问”入口，不必复制原生chip组件或重新做批注展示。

真实场景：长回复里选中一条建议，带上这段原文再问“这里换成另一种做法”；有正在输入的文字和附件时保留它们，不因引用切换线程、模型或自动发送。

本轮将上游原始格式/追加/Refine函数放在stub编辑器中运行：原草稿保留、引用追加、输入事件与焦点各两次、自动提交0次，结果通过。不是Safari触控/IME或真实agent验收。后续同一390px样本验证选区捕获、已有草稿/附件、返回阅读位置、重复相同引用和主动发送。

## 2. 优先小样：把上一条提问取回草稿，而不是重发

Hermex的[ComposerRecall](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobile/Features/Chat/ComposerRecall.swift#L3)从当前会话倒序找用户正文，跳过工具/助手、系统投递、压缩标记和纯附件，去掉Steer及附件包装。[测试](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobileTests/ComposerRecallTests.swift#L25)直接调用它；[ChatView](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobile/Features/Chat/ChatView.swift#L771)提供lastSentText，composer和textView传递召回闭包。原设计的入口是硬件键盘空输入框的↑，不能描述成已经验证的iPhone触屏按钮。

Pocket有复制、待发编辑和输入保护，但本轮未见已发送文字召回入口。对手机可考虑一个轻量“重用文字”动作：先填回草稿，再由用户修改/发送，使用新的明确提交意图；不改原消息、恢复旧附件或消除unknown。已有草稿、附件或待核对提交时不自动覆盖；不能把这个入口变成未知发送的变号重试。

本轮仅核对Swift函数、测试与闭包链，未运行iOS测试。最小验证用助手/工具穿插、纯附件、Steer和注入上下文的历史样本，检查只取真正用户文字且不发送；保持当前会话/机器归属。默认用现有可见历史，无需为此持久化新的草稿或自动加载全部历史。

## 3. 值得试：Pocket内部语音转写，迟到结果不覆盖编辑

WebUI实际路由提供`/api/transcribe`及能力探测；Hermex[composer控制器](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobile/Features/Chat/ComposerVoiceInputController.swift#L146)在录音开始和每次写入前重读当前草稿；[writeTranscript](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobile/Features/Chat/ComposerVoiceInputController.swift#L808)只更新语音拥有的范围。用户编辑、草稿身份或编辑代次变化时停止回填；[测试](https://github.com/uzairansaruzi/hermex/blob/75477965dc871003bca31f13ec5a021a07893157/HermesMobileTests/ComposerVoiceDraftComposerTests.swift#L72)专门覆盖“编辑又撤销回同样文字”的迟到结果。

Pocket当前有系统输入与豆包切回的路径/保护，但未见内置录音到转写的composer接线。可吸收“结束录音→转成可编辑草稿→明确发送”以及草稿代次和范围保护，减少离开Pocket再返回的步骤。转写服务可评估既有工具接口，不因此接入Hermes执行器；原生Speech/AVAudioEngine不能直接搬到PWA。

这是产品与协议候选，不是已接通的浏览器能力。本轮读取实际调用/测试，并对固定源码1180–1309行的纯草稿合入片段做14项Swift隔离检查：英文/中文插入、替换选区、emoji/组合字符边界、空结果、逐步转写、取消恢复、用户新编辑、编辑后撤销及取消后的迟到结果全部通过。原纯代码逐字核对，仅用两个字段的ComposerSelection替身；没有录音、网络、App、Codex或真机结果，不是iOS完整测试套件。最小后续验证：固定一段中文语音，比较现有输入方式与小样；转写延迟期间编辑、撤销、切会话、移动光标和添加附件，新草稿都保持，转写本身不发送。Safari麦克风、编码、后台中止和中文效果独立验收。

## 4. 后续连接优化要借：恢复内容与游标必须一起有效

WebUI将[列表失效、每会话状态、每轮运行](https://github.com/nesquena/hermes-webui/blob/f3606dd9f00942b08ebda66e7cb837a34d435e02/docs/sse-streams.md)分成不同事件通道。列表事件只提示重读列表，不是运行终态或发送回执；同范围重复事件合并、跨范围事件退为完整刷新。[session_events](https://github.com/nesquena/hermes-webui/blob/f3606dd9f00942b08ebda66e7cb837a34d435e02/api/session_events.py#L64)的有界队列实现了这项约束。

一个有价值的具体恢复用例：[只有游标/用户行，缺少当前回复的投影时](https://github.com/nesquena/hermes-webui/blob/f3606dd9f00942b08ebda66e7cb837a34d435e02/static/sessions.js#L1827)，不能从游标之后接，否则可能只收到末尾结束事件、正文却空白。旧轮assistant正文也不能证明当前轮已有可恢复内容；有当前回复/工具过程才保留恢复位置。切走前[保留实时尾部状态](https://github.com/nesquena/hermes-webui/blob/f3606dd9f00942b08ebda66e7cb837a34d435e02/static/messages.js#L2487)，恢复不等于重新执行写入。

Pocket已有阅读缓存、分页、前后台代次、未知发送和草稿保护，不能说这些都是缺失。新增输入是未来持续连接时的完整replay/snapshot/epoch契约与反例，而不是把当前轮询直接换成SSE。Codex原owner和Hermes journal不同，必须有Pocket自己的可确认源事件；不能拿恢复游标核销发送。

本轮两个原始Node VM恢复回归通过：user-only/旧轮正文不能授权非零游标，丢失当前投影后清掉不可靠恢复位置；当前输出存在则保留。实际session_events函数的同范围多会话、跨范围与200事件突发探针通过，队列容量1，订阅清理完成。第三个前后端联动测试需要api.routes的完整依赖，隔离入口报`No module named api`，首轮exit1保存；未安装后端，未将环境缺失当上游产品故障。后续只重跑两个独立逻辑测试并保留未覆盖范围。

文档还存在历史RFC与现行实现并存：RFC的最初non-goals称per-session events未实现，但本轮固定routes已有`/api/sessions/<id>/events`派发，现行sse-streams也列为可用。根据实际路由说明已实现路径，不把旧提案文字或文档声明当完整运行验收。

WebUI隐藏标签页关闭部分SSE并用限频状态读取恢复；浏览器可能节流/挂起，这不是iPhone锁屏可靠实时运行或通知送达的证据。Pocket已有Web Push，继续按其真机闭环验收，不复制后台JavaScript轮询去替代推送。

## 重合、平台边界与本轮取舍

- **已经有的**：紧凑输入区、IME/焦点/滚动保护、会话缓存、附件/待发/unknown、引用展示和HTML预览。特别是11-07[HTML交互预览](../design/2026-11-07-interactive-html-preview.md)已允许脚本和HTTPS资源，本轮不按旧“只允许自包含HTML”的建议回退，也不重新立项同一能力。
- **保留为条件性候选**：会话内查找/消息导航。WebUI的outline默认不在≤900px手机布局出现，不能直接称手机优秀机制；其历史补读和定位方法可参考，具体界面要用Pocket手机样本判断。
- **需要原生层的**：Share Extension、App Intents、Live Activity/APNs和硬件快捷键表现。过去建议依然有平台前提，不因本轮研究新建原生壳或声称PWA获得这些能力。
- **暂缓扩面**：三栏文件工作台、Git写操作、Kanban、Profile/Memory管理。也不采用Hermex Move to Hermes迁移或WebUI自有执行器来解决原Codex的归档/共享队列限制。

建议自用试验顺序：先试引用入草稿和上一条文字召回；需要减少手机输入切换时试内置转写；长会话实测后再选择事件连接优化。以上是研究建议，不是已选定开发任务。保持原机器/会话/owner、当前未提交文字、附件与未知账本。

本轮只新增研究和接续指针。无Pocket源码/配置/运行服务/账号改动，无真实发送、自动重放、推送或安装；没有界面目视或实体手机测试。上游选中原文、Git树和探针保留本机，临时生成cache清理；真实效果仍需对应小样和反馈。

## 同日后续取舍

2026-11-07，欧吉安说明当前使用微信／豆包输入法的语音转文字，询问内置录音的增量与苹果ASR路线。格得澄清：恢复经验是未来连接改造的防护参考，未在Pocket复现上游的游标/内容丢失故障；内置录音尚无确定ASR方案，未证明优于当前输入法。欧吉安随后确认“na jiu xian zanhuan ba”（那就先暂缓吧），沿最近讨论范围记为**暂缓Pocket内置录音转写**。上文小样建议保留研究语境，不是待执行任务；当前暂停与接续条件以[CURRENT的继续方式](../../CURRENT.md#继续方式)为准。未暂停现有输入法或Pocket服务，未修改产品。
