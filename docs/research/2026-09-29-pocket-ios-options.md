# Pocket：PWA 与自用 iOS App 的取舍

2026-10-10接续：附件与会话能力、真实输入摩擦及openGym工具链已有变化，当前判断见[openGym封装评估](2026-10-10-opengym-ios-wrapper-assessment.md)。下文保留09-29的事实基线与当时取舍。

核验日期：2026-09-29。范围：对照当前 Pocket 代码、项目事实源与 Apple / WebKit 官方资料，研究形态和分发选择；没有创建 App、开启通知、修改认证、配对设备或操作 App Store Connect。研究建议须先讨论选定，再实施。

## 判断

**当前继续保留 PWA 主入口；只有要把 Pocket 变成手机系统中的“收集与接续入口”时，原生 App 才有清楚的增量。** 启动动画、查看任务、发文字、排队、停止、回答问题和大部分通知需求都不足以单独支撑重写。

最值得讨论的原生用法是：在 Safari、相册或其他支持系统分享的 App 中，把选中的链接、文本、截图分享到 Pocket，选一个已有 Codex 任务并加一句要求；或者通过快捷指令/动作按钮，直接向某个常用任务追加一条经过确认的指令。它减少的是“复制→切 App→找任务→粘贴”的操作，是否高频到值得维护一个 App 尚待真实使用验证。

**原生只是增加手机入口，不改变执行位置。** 手机仍通过 Pocket 的服务访问 Mac，再由 Mac 桥接原 Codex owner；不能因此绕过私有 IPC 限制、获得尚未开放的新建/改名/归档方法，也不能让睡眠或离线的 Mac 继续执行。手机后台保活和 Mac 任务运行是两个问题。[P1][P2]

## 当前基线与增量

本次读到的版本基线是 CURRENT.md 的 2026-09-29 启动与文案发布（源码 `a5178ba`），不是重新做线上验收。当前 `public/sw.js` 只缓存公开资源并处理离线页，没有 push 处理；manifest 没有 `share_target`；附件尚未接入；聊天草稿在页面内存 Map，已提交待发正文才进入 Mac 私有数据库。当前 PWA 真机冷启动、长时间后台恢复仍待手机反馈。[P1][P3]

| 诉求 | PWA 能做什么 | 原生新增价值与限制 | 对 Pocket 的判断 |
| --- | --- | --- | --- |
| 从其他 App 收入文本、链接、图片 | 当前没有接收入口。网页的 `navigator.share` 是向外分享，不能据此推断接收能力；本次没有真机确认当前 iOS 的 Web Share Target 覆盖 | Share Extension 可读取宿主提供的初始文本、链接、图片等附件，允许选择目标任务、预览与添加要求；具体宿主可能只分享链接、预览图或部分内容，不能任意读取整个 App | **最强原生候选。** 先讨论是否常用；附件还要打通手机→Mac→原 owner，做 App 本身不会完成后半段 [A1] |
| 完成、失败、等待我处理通知 | iOS/iPadOS 16.4 起，加入主屏幕的网页可经用户主动操作申请 Web Push，并显示通知和角标；无需加入 Apple Developer Program | 原生能做更丰富的通知动作/系统衔接，但同样需要推送注册、事件来源、过期判断和服务端投递；不是“原生才有通知” | **可先在 PWA 验证价值。** 只通知完成/失败/需用户处理，正文最小化，点开后重读真实任务状态 [A2][A3] |
| 快捷指令、Siri、动作按钮 | 手工快捷指令可打开 URL；在设计合适认证 API 后也可以组合网络动作，当前 Pocket 尚无这项接入 | App Intents / App Entities 让系统理解“某个任务”和“追加待发/打开待处理”等动作，提供系统参数选择，和 Shortcuts、Spotlight、控件、动作按钮衔接 | **第二强候选。** 先从“打开指定任务”“确认后追加待发”两项起；不把“允许审批”做成无内容核对的一键动作 [A4] |
| 拍照、选图、上传文件 | 浏览器已有媒体采集 API；当前项目也已有备份导入的文件选择。图片聊天缺的是附件协议与 UI，不是“网页不能拍照” | 原生更方便集成拍照、扫描、照片选择与上传恢复，但照片读写权限、宿主分享类型、文件大小和 Mac 端接收仍需逐项处理 | **不是迁移的独立理由。** 先做单图链路即可验证大部分需求 [A5][P3] |
| Face ID 与登录凭据 | WebAuthn / passkeys 可使用 Face ID / Touch ID；当前 Pocket 是口令与 Cookie，尚未接通 passkey | 原生可用 Keychain 保存设备凭据，并用 LocalAuthentication 保护读取/进入敏感页面；可做设备级撤销与会话恢复 | **增量在凭据和本地访问策略，不是 Face ID 独占。** Face ID 不能代替服务器鉴权，也不能直接复用仅限 Mac loopback 的 CLI token [A6][A7][P2] |
| 主屏幕 Widget | 当前仅有主屏幕图标和网页；网页角标适合轻量“有待处理”信号 | Widget 可直接显示“待我处理 2 项”“最近继续的任务”。但刷新由系统预算和调度控制，即使使用 WidgetKit push 也不是保证实时 | 适合明确下一步和快速返回；应显示更新时间/失联状态，不能把旧快照当实时状态 [A8] |
| Live Activities / 灵动岛 | 当前网页没有这项系统展示 | 可显示用户主动关注的一项任务的运行/待处理/完成。Live Activity 自身不能联网，须由 App 或 ActivityKit push 更新；官方说明 active 最长 8 小时，锁屏残留最多额外 4 小时 | 有趣，但优先级低于收集、通知、附件；不宜每个后台任务都占灵动岛，不显示虚假的百分比进度 [A9] |
| 中文键盘、首屏、后台恢复 | 现有 PWA 已做 visualViewport、草稿/阅读位置在页面存活期间保留、前台静默重读及启动画面；系统杀进程后不是同一保证 | 原生输入、导航与状态恢复更可控；单纯套 WKWebView 仍主要使用网页输入和生命周期。原生也会被挂起/终止，网络与后台任务仍受系统限制 | **先以真机摩擦决定投入。** 不能承诺装成 App 就更快/永不丢状态；若增设手机持久草稿，需单独决定私人数据存储、清理和恢复边界 [A10][P1][P3] |

Web Push 的接收可以由系统完成，不需要页面一直打开；这并不让网页获得任意静默后台工作能力。原生可以申请有限的后台执行或系统托管传输，但不能用普通远控 App 保证无限 WebSocket 常连。可靠做法仍是：命令编号与回执、Mac 侧持久状态、事件推送、手机回前台重新核对。[A3][A10]

## 三种形态

1. **继续 PWA**：保留现有访问与发布路径，最适合继续打磨任务整理、正文阅读、输入、附件与通知。当前推荐。
2. **轻量 iOS 配套 App**：保留 PWA 与现有后端，以原生分享扩展、App Intents、Keychain、通知为重点；聊天页初期可复用网页。适合验证系统入口的增量，成本低于全量重写，但需处理 App/扩展凭据共享、认证、文件临时存储和两套入口的一致性。只是包一个 WKWebView，收益很小。
3. **完整原生客户端**：当高频真机使用已经证明输入、长历史、系统入口有明显瓶颈，再迁移列表/聊天/输入。需要重新维护 Markdown、代码块、队列、审批、断线恢复等，不能因为界面更像 App 就假定总体收益更高。

共享后端不代表可原样使用当前认证。当前 HTTP 接口依赖同源 Cookie、Origin 与 CSRF 校验，local CLI bearer 仅限 loopback。原生扩展或 App Intents 若直接调用 HTTP，需专门设计作用域受限的设备身份、吊销与防重，不放宽既有 Origin/Host 保护来迁就新客户端。[P2]

若选定原生实验，最小验证可以是一个明确场景：从 Safari 分享一个链接、从相册分享一张截图，选择同一个已有任务，加一句要求，Mac 接收后回读准确文本/字节与原任务记录；断网不误报已发，重试不重复。只有在方帅确认采用后才进入此实验。它验证“系统收集入口是否省步骤”，不需要先重写聊天界面。

## TestFlight 只给自己使用

**可行。** 使用自己的 Apple Developer Program 团队，在 App Store Connect 建立 App 和一个 internal 测试组，只把自己加入即可；不用公开链接，也不必发布到 App Store。但“只给自己”描述的是测试组分发范围，TestFlight 构建仍上传并由 Apple 处理，不是仅保存在个人设备上的离线安装。[A11][A12]

- **开发者资格**：TestFlight 属于 Apple Developer Program 的分发能力；Apple 官网当前标示年费 99 美元，实际本地区域价格以账号结算为准。已有有效会员则一般无需为多一个 App 再买一份会员。本次没有读取个人会员或团队状态。[A13]
- **Internal tester 条件**：最多 100 位，必须是对该 App 有访问权限的 App Store Connect 用户，角色为 Account Holder、Admin、App Manager、Developer 或 Marketing。不能仅把任意邮箱标成“内部测试”。自己作为该团队 Account Holder 是合适路径。[A11][A12]
- **审核边界**：内部测试按 Apple 文档流程在构建处理/合规信息完成后分发，不走外部测试要求的 TestFlight App Review。外部测试即使只邀请另一位个人，也属于 external 流程，首次提交需要完整 beta review；同版本后续构建可能不需完整 review。Beta review 通过不等于 App Store 正式上架审核通过。[A11][A14]
- **失效**：每个 TestFlight 构建只能测试最多 90 天，到期不可继续作为该测试版本使用。适合持续更新的自用工具，但有周期性重新构建上传的维护负担，不能当作永久安装。[A15]
- **Internal Only 构建**：Xcode / Xcode Cloud 支持标记 TestFlight Internal Only；此类构建只能加内部组，不能提交外部测试或给商店用户。将来改变分发对象需重新选择构建/分发方式。[A12]
- **几个独立状态**：本地编译通过 → 签名归档/上传成功 → Apple 处理完成与必要合规信息完成 → 加入自己所在内部组 → TestFlight 设备端接受/安装 → 真机流程验收。任何前一步成功都不证明后一步已完成。[A12][A15]

如果只想很快试一次，免费 Apple Account 也能经 Xcode 安装到自己的设备，但 Apple 当前文档说明 Personal Team 的相关 provisioning 有 7 天期限，需要重建重装；这不是 TestFlight，也不是最省维护的长期自用分发路线。[A16]

## 待确认与证据边界

- 本次是源码/官方文档研究，没有真机或 TestFlight 操作；没有确认方帅的 Apple Developer Program 有效期、App Store Connect 团队/角色或设备 OS 版本。
- 官方 Web Push 起始支持版本为 iOS/iPadOS 16.4；Apple Developer 文档是在线滚动版本。本文没有把最新 SDK 新能力全部当作现有设备可用，若选择具体方案需再锁定最低 iOS 和 SDK 版本。
- PWA 的 Web Share Target 在目标设备上的当前覆盖、快捷指令与当前网页认证能否直接组合，均未实测。原生 Share Extension 文档证明系统 API 存在，不证明任意来源 App 会提供期望的完整内容。
- 任务事件订阅、推送到达/点击恢复、网络切换、锁屏/强退后的可靠性尚未验证。前端形态不能弥补 Mac 端事件来源、IPC 权限或主机在线性的缺口。
- 项目禁止把私人聊天数据直接加入 PWA 离线缓存；未来若需要手机端持久草稿或分享待上传箱，必须明确新增数据范围、加密/备份与删除语义，不能自动扩大现有策略。

## 依据

### 项目事实源

- [P1] [CURRENT.md](../../CURRENT.md)：2026-09-29 启动/文案与主题发布、PWA 真机边界；[外部研究输入](2026-09-29-external-research-intake.md)：附件及官方 Remote 重叠，先讨论再实施。
- [P2] [ARCHITECTURE.md](../ARCHITECTURE.md)、[项目 AGENTS.md](../../AGENTS.md)：原 owner、只读来源、Mac 持久状态与 HTTP 认证边界。
- [P3] [public/sw.js](../../public/sw.js)、[manifest](../../public/manifest.webmanifest)、[Conversation.tsx](../../src/Conversation.tsx)、[Dialogs.tsx](../../src/Dialogs.tsx)、[conversationFeed.ts](../../src/conversationFeed.ts)：本次实际读取当前实现；代码存在不视为新增真实体验验收。

### Apple / WebKit 官方来源（2026-09-29 读取）

- [A1] [Share Extensions](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html)（Apple 归档机制说明）；[Supporting suggestions in your app’s share extension](https://developer.apple.com/documentation/Foundation/supporting-suggestions-in-your-app-s-share-extension)（当前文档）。
- [A2] [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)（2023-02-16）；[WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)（2023-03-27）。
- [A3] [Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)（2025-03-27）：Web Push 使用 APNs、不需 Developer Program，以及静默后台和可见通知的边界。本文不依赖所有目标设备已经支持 Declarative Web Push。
- [A4] [App Intents](https://developer.apple.com/documentation/AppIntents)、[Adopting App Intents to support system experiences](https://developer.apple.com/documentation/AppIntents/adopting-app-intents-to-support-system-experiences)、[Action button](https://developer.apple.com/design/human-interface-guidelines/action-button)。
- [A5] [MediaRecorder API](https://webkit.org/blog/11353/mediarecorder-api/)（2020-11-23）：示例通过 getUserMedia 采集摄像头/麦克风并生成可预览/上传的 Blob。
- [A6] [Meet Face ID and Touch ID for the web](https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/)（2020-10-19）；[Passkey use in web browsers](https://developer.apple.com/documentation/AuthenticationServices/passkey-use-in-web-browsers)。
- [A7] [Accessing Keychain Items with Face ID or Touch ID](https://developer.apple.com/documentation/LocalAuthentication/accessing-keychain-items-with-face-id-or-touch-id)。
- [A8] [Keeping a widget up to date](https://developer.apple.com/documentation/WidgetKit/Keeping-a-Widget-Up-To-Date)、[Updating widgets with WidgetKit push notifications](https://developer.apple.com/documentation/WidgetKit/Updating-widgets-with-widgetkit-push-notifications)。
- [A9] [Displaying live data with Live Activities](https://developer.apple.com/documentation/ActivityKit/displaying-live-data-with-live-activities)、[Starting and updating Live Activities with ActivityKit push notifications](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)。
- [A10] [Choosing Background Strategies for Your App](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app)、[Extending your app’s background execution time](https://developer.apple.com/documentation/UIKit/extending-your-app-s-background-execution-time)。
- [A11] [TestFlight](https://developer.apple.com/testflight/)：internal 角色与 external 首次 App Review。
- [A12] [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)：App 访问权限、分组、Internal Only 与 90 天。
- [A13] [Apple Developer Program](https://developer.apple.com/programs/)：当前会员价格及 TestFlight 能力。
- [A14] [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)：外部组、提交 beta review 和分发步骤。
- [A15] [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)：上传、邀请、下载、90 天失效。
- [A16] [Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account)：免费 Personal Team 与付费会员差异、7 天 provisioning。

检索 Apple 框架文档时使用 Xcode DocumentationSearch 官方索引；其返回内容包括 API 条件和原始 documentation URL。网页资料通过公开 HTTPS 实际读取；没有读取或发送任何真实私人任务正文。
