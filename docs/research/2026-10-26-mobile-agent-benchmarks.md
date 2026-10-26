# T3 Code、Happy、HAPI：手机体验中值得 Pocket 借鉴的部分

2026-10-26。用户询问三者移动端是否打磨得比较好，以及哪些功能／设计值得借鉴。本轮是分析与取舍，不实施产品修改或部署。Pocket 对照 HEAD 为 `a9b652a8df3bd803c71bd27e2943a7849a8d8097`；当前发布事实从 [CURRENT](../../CURRENT.md) 读取，未重跑公网或实体手机验收。

## 判断

**同日用户反馈后的调整：** 欧吉安指出“好像这4项我们用的其实不太多吧”。原先排序缺少使用频率与实际困难的证据，以下四项改作参考候选，不作为当前实施优先级。先观察发送、阅读、输入与切回前台等现有流程；产品选型与最小试点见[真实使用反馈方案](../../../research/2026-10-26-product-usage-feedback.md)。尚未接入采集或验证候选价值。

**T3、Happy 已有正式移动 App 与持续迭代，可以作为手机产品参照；HAPI 有不少细致的原生交互实现，适合作源码参照。不能据此断言三家的键盘、滚动、切网都比 Pocket 更好。** 本轮查看的是官方商店展示图、发布说明与固定源码，没有实际安装三家原生 App 做同机横评。

重点借“找得到、看得完、退得回、输入不丢”的机制。Pocket 仍保留原 Codex App owner 路线；不因 UI 借鉴换成竞品 runner／hub。新的功能也应保持已认可的安静界面，不扩大为手机 IDE。

## 来源与成熟度边界

| 对象 | 当前可确认 | 未确认 |
| --- | --- | --- |
| T3 iOS | Apple US lookup 为2.1.0，10-24北京时间发布，iOS18+；2.1.0说明包括紧凑composer、离线消息队列、会话内查找、原生PR审阅、Live Activities相关改进。约4.87分／160条评分 | 中文IME、真实键盘、锁屏／切网和我们日常长会话体验；本会话此前只实测T3本机网页 |
| Happy iOS | Apple US lookup 为1.8.0，10-07发布，iOS15.1+；说明为重大UI更新与Happy Harness支持。约4.87分／1041条评分 | 商店截图是否完整反映新版本全部界面、多人／多会话语音的实际效果及当前手机体验 |
| HAPI native | 官方文档与源码提供SwiftUI/UIKit和Android客户端，含审批、草稿、附件、diff、通知、滚动状态；iOS17+ | 已读官方入口主要给构建／签名流程，未确认公开App Store成品渠道；未安装运行。文档还保留原生/网页、iOS/Android能力差异 |

评分是地区、时间与用户样本的聚合，不是与Pocket对比的实验。本轮App Store评论RSS未取得条目，不能解释成没有用户评论，也不引用未读到的评价。

源码固定：T3 `62245d8e3ad5858abe6c5c0e2e8fba42ed245e9f`；Happy `d95fc8b0fa30db0927fad960fc22aad9f338880c`；HAPI `7f7d87186689bc94aab236e270f6d43ee517e0ef`。main源码与商店安装包不是同一个验收版本。

## 保留参考的四项机制

### 1. 会话内查找，点结果直接回到原文

**问题：** 手机翻长对话寻找一个旧决定、文件或约束，成本比桌面高。标题搜索不能代替会话正文查找。

**参照：** T3 iOS2.1.0发布说明明确支持会话内搜索消息和计划；移动端 `threadMessageJump.ts` 将跳转绑定 threadKey＋messageId，完成后消费请求，未显示过的旧请求30秒失效，避免日后普通打开又发生旧跳转。消息定位是结构化动作，不是只在当前屏幕高亮文字。

**Pocket 落点：** 会话菜单内放查找；结果显示说话人、片段和匹配处，点开加载邻近上下文并定位。正文范围受当前历史通道约束，不能把只搜了80条说成搜索了全部历史；检索/预加载不标读，定位后的真实可见阅读仍走现有水位。

**验收样本：** 120条消息中的旧决定可以找回；折叠过程内命中能展开；搜索时切会话不串结果；跳转后新回复不抢阅读位置；失败或只搜部分历史时不显示假的“无结果”。

这与今天 [Pi Pocket研究](../../../../study/research/2026-10-26-pi-pocket-for-pocket.md) 的第一候选一致，本轮是补充标杆证据，不另起一份实现清单。[T3跳转源码](https://github.com/pingdotgg/t3code/blob/62245d8e3ad5858abe6c5c0e2e8fba42ed245e9f/apps/mobile/src/features/threads/threadMessageJump.ts)

### 2. 先在会话里看交付物，再决定下载或继续修改

**问题：** 格得给出研究稿、页面或代码改动后，手机如果只能下载或跳出聊天，就很难紧接着指出具体问题。

**参照：** T3移动端文件卡片可进入预览，媒体预览保留自身source，避免消息streaming重启fetch/player；T3商店展示手机diff，Happy展示消息内文件卡和独立diff阅读器。Happy `DiffFilesList` 默认非split布局，支持文件折叠、按需请求正文；超过2000行变更时先折叠，仅为已展开且进入虚拟列表的部分构建diff。

**Pocket 落点：** 先从已有文件能力里的Markdown／纯文本只读预览做起，保留下载；再增加“变更文件列表→单文件统一diff”。标清比较基线、实际来源与是否完整，不把整个共享checkout的改动都算成当前会话产物。返回会话恢复原位置与草稿。

**验收样本：** 不下载即可读完研究稿；大文件有明确范围；旧消息的文件版本不被新文件冒充；预览关闭不跳底；两任务同目录时diff归属不混。版本要求来自Pocket现有文件校验与Pi Pocket研究，不声称这几张竞品截图已经证明其历史文件版本冻结。

现有 `MessageFile.tsx` 已有受控下载、机器/路径/尺寸/版本边界，不从零造文件通道，也不开放任意宿主路径。前期[Pi Pocket候选](../../../../study/research/2026-10-26-pi-pocket-for-pocket.md)继续作为同一决策入口。[T3文件预览](https://github.com/pingdotgg/t3code/blob/62245d8e3ad5858abe6c5c0e2e8fba42ed245e9f/apps/mobile/src/features/threads/ThreadInlineFilePreview.tsx)、[Happy diff](https://github.com/slopus/happy/blob/d95fc8b0fa30db0927fad960fc22aad9f338880c/packages/happy-app/sources/components/diff/DiffFilesList.tsx)

### 3. 把“暂存想法”和“排队执行”明确分开

**问题：** 读回复时想到几个后续点，未必想立即打断或提交。单条当前草稿与待执行队列不能完全代替“稍后再决定”的内容。

**参照：** HAPI iOS Scratchlist 是同一输入框上方的紧凑抽屉。Save draft不发送；关闭保留未保存输入；Take draft保留原存档。输入框已有内容时提供Append或先存当前输入再取；只有显式Add to send queue才发送，接受后才移除草稿，删除失败的重试不重发消息。[原生使用说明](https://github.com/tiann/hapi/blob/7f7d87186689bc94aab236e270f6d43ee517e0ef/docs/guide/native-apps.md)、[转换与附件保护](https://github.com/tiann/hapi/blob/7f7d87186689bc94aab236e270f6d43ee517e0ef/ios/Packages/HapiKit/Sources/HapiClient/Chat/ScratchlistTransfer.swift)

**Pocket 取舍：条件性候选。** 已有当前草稿、附件、待发编辑和unknown账本，不重复开发这些。若实际存在多条想法需要暂存，再做很小的草稿抽屉；不借此恢复用户删掉的备注、安排日期或管理页。即使不加草稿匣，也可借鉴“恢复内容不能覆盖当前输入”的清晰分支。

**验收样本：** 存下来不触发任何发送；取出不会覆盖正在输入的文字或附件；加入队列成功但清理失败时，重试不会第二次发送；切机／切会话不串草稿。

### 4. 把返回、滚动和键盘当成一条连续操作链

**问题：** 找旧内容、打开文件/工具详情、回到会话时，若位置丢失或突然跳到最新，阅读会反复中断。

**参照：** HAPI原生滚动把“用户是否想跟随最新消息”与“当前几何位置是否在底部”分开。向上拖动会取消跟随；图片加载或视口变化不能误判为主动看历史；旧消息插到上方保留message ID和offset。打开检查层保留阅读意图，关闭不自动跳最新；工具组先摘要，进入详情后再分层查看。旧分页无进展会暂停并保留恢复入口，不误报已到对话开头。[滚动契约](https://github.com/tiann/hapi/blob/7f7d87186689bc94aab236e270f6d43ee517e0ef/docs/native-chat-scrolling.md)、[tail-follow状态](https://github.com/tiann/hapi/blob/7f7d87186689bc94aab236e270f6d43ee517e0ef/ios/Packages/HapiKit/Sources/HapiClient/Chat/ChatTailFollowState.swift)

**Pocket 落点：** 与上面的查找／预览一起定义返回层级和滚动锚点；只返回一层，保留原textarea、IME和草稿。现有[发送连续性修复](../design/2026-10-25-send-ui-continuity.md)已保护迟到回执与用户上滚，不推翻它。HAPI的UIKit／Compose实现不是React PWA可直接复制的代码，只借行为与测试场景。

**验收样本：** 看旧回复时收到新内容不跳底；点开预览再返回仍在同一句；键盘开合不丢输入；快速返回不穿透到列表；加载早期历史、图片变高与切后台恢复同时出现仍保住阅读锚点。

## 保留我们已有的，不机械复制

- Pocket已上线单条阅读输入栏、状态与控件就近表达、输入焦点保持、已读水位和原owner保护。T3商店图也使用紧凑输入栏，但不是我们需要重做的功能。
- T3队列支持编辑／重排／Steer，正在编辑的条目不会再次装载覆盖编辑稿；Pocket已有多项类似保护。优先复用错误场景，不因竞品有拖拽就增加重排功能。[队列展示逻辑](https://github.com/pingdotgg/t3code/blob/62245d8e3ad5858abe6c5c0e2e8fba42ed245e9f/apps/mobile/src/features/threads/threadQueueControlPresentation.ts)
- 保留独立停止和unknown核对，不按某个主按钮的外观改变发送／停止语义。旧9月Happy/HAPI反例不作为当前缺陷结论。
- 运行中与未读互斥仍是CURRENT明确未完成项；这是真实既有需求，可按原契约接续，不需先引入新竞品框架。
- 原生Live Activities、锁屏交互、实时多会话语音可以作为将来体验样本，但不是PWA直接搬一段代码就有的功能；当前不据此新建原生壳或迁移执行器。手机完整终端、stage/revert/merge也不进入本轮建议范围。
- 剪贴板问题保持用户“先观察”的决定，不借此重开修改。

## 反例提醒：功能多不等于所有细节都能照抄

HAPI官方原生指南明确：iOS目前没有Rename/Delete/显式Reopen UI，多项功能只在Web；多hub的通知点击先按active hub找会话，找不到时需要切到所属hub。Pocket已有两机语义，应继续把通知绑定正确机器与会话，不能借其展示方式带入这项限制。这是官方文档边界，不是本轮真机复现的bug。

## 视觉观察与证据范围

本轮受控查看了六张Apple商店展示图：[联系表](../../../../study/research/2026-10-26-mobile-agent-ux-evidence/mobile-reference-contact.jpg)。1–2是T3聊天/diff，3–6是Happy会话、语音、diff和列表。

- T3聊天图以正文为主，底部单条输入；diff独立占据主要阅读区域。
- Happy展示消息内文件卡、独立diff页和分组会话列表；语音图含宣传性放大圆圈，不能把它当作实际遮挡布局。
- 这些图足以比较层级和能力入口，不足以测量触控大小、中文IME、流畅度或真实网络恢复；没有以不同内容/主题的商店图给三家打分。HAPI没有本轮视觉证据，判断来自原生文档与源码。

原始商店元数据、11份固定源码及哈希、截图来源与视觉结论留在[证据目录](../../../../study/research/2026-10-26-mobile-agent-ux-evidence/README.md)。本轮初始建议为查找定位与原地阅读优先、返回连续性随之一起做、草稿抽屉待需求验证；**同日用户反馈后不再沿用该优先排序，先取得日常使用证据。** 四项保留为可回查的设计参照；没有改产品代码、发布、启用使用采集或新增自动化。
