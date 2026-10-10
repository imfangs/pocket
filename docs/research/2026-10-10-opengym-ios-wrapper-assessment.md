# 借 openGym 评估 Pocket 的 iOS 形态

2026-10-10。方帅要求评估：Side 新增的开源健身应用把 Web 封成了 iOS App，Pocket 是否也值得这样做。本轮只读核对源码、已有设备回执和官方资料；没有创建、构建、安装或发布 Pocket iOS App，也没有重测豆包输入法。

## 判断

**值得做轻量原生增强的对照实验，继续保留 PWA；暂不投入完整原生重写。** 实验目标是改善输入、返回后的状态恢复和系统收集入口。只有远程网址的 WebView 壳收益有限，不能承诺解决现有键盘与豆包回跳问题。

相较[09-29评估](2026-09-29-pocket-ios-options.md)，已有三个变化：Pocket 的附件上传、原会话管理、发送回执和队列更完整；用户已经报告具体的 iPhone 键盘/跨App输入摩擦；openGym 已在本机完成 Capacitor 构建、签名和安装，工具链探索成本降低。这些变化支持一次有限实验，不证明 App 体验已经优于 PWA。

## openGym 实际做了什么

项目：`/Users/fangs/workspace/side/opengym`，本次读取HEAD `b2b98d5f2af3ba2f3a37d4726f18a2b96bf763ac`。上游 [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)，研究基线 `b1cff630b3c30d8bad1f698a264d52314a029855`；个人设备构建来源 `28ef73bcffe784485084da0e4cc548b10d8c4d1a`。当前安装记录为1.4.0(2)，iPhone 14 Plus / iOS 26.6.2，本轮未操作该手机。

它将 React/Vite 的dist随Capacitor 7 App打包，并增加本地文件持久化、Keychain、原生HTTP、前后台事件、系统导出分享及本地提醒。不是只把远程网站装进一个窗口。我们的安装版本以本地训练数据模式运行；Pocket 的核心仍是访问Mac上的原任务，二者离线价值不同。

| 已核机制 | openGym 源码入口 | 能否直接推导 Pocket 收益 |
| --- | --- | --- |
| 本地Web资源，移动版不注册SW | `frontend/capacitor.config.json:4`、`frontend/src/main.jsx:25` | 可减少对远端HTML/资源首载的依赖；不能消除Pocket的认证、目录读取和Mac连接等待 |
| Filesystem数据、媒体索引和前后台flush | `frontend/src/lib/mobile.js:38`、`media-store-fs.js:15` | 可借来设计手机端草稿/待传文件持久化；PWA的IndexedDB也可改善这部分，原生不是唯一途径 |
| App回前台事件 | `frontend/src/lib/mobile.js:214` | 为恢复当前任务、输入和重新核对状态提供更明确的入口；不等于后台常连 |
| Keychain | `frontend/src/lib/coach-secrets.js:1` | 适合设备凭据；不自动继承Safari/PWA Cookie |
| 显式native HTTP adapter | `frontend/src/lib/capacitor-fetch.js:14` | 仅实现教练使用的JSON请求与整段text/json响应，不能原样替换Pocket的Cookie、二进制上传、取消和回执逻辑 |
| 文件写入后系统Share Sheet | `frontend/src/lib/mobile.js:225` | 是分享出去；接收其他App的截图/链接需要单独Share Extension |
| 本地训练提醒 | `frontend/src/lib/mobile.js:172` | 按已知日期调度，与Mac任务完成事件所需远程推送不同 |

**关键反证：openGym 的 `native-keyboard.js` 只处理Android 15。** 文件首段及79行附近明确iOS仍由WebView/visualViewport处理。项目没有iOS原生输入框、`@capacitor/keyboard`、APNs接入或Share Extension；照片选择也仍是HTML文件输入。不能把Android专用插件或“native”文件名当成iOS已具备的能力。

已有设备回执证明安装启动、中文、覆盖升级的数据一致和重启后Keychain配置保留。断网冷开、通知、全部动作媒体、照片ZIP往返、完整个人训练体验仍未验证；这些不是可直接移植的质量结论。

## Pocket 哪些地方值得增强

| 当前情境 | 原生增强的价值 | 条件与限制 |
| --- | --- | --- |
| 键盘收起后页面未恢复、输入框位置异常 | 原生键盘事件和统一resize规则可增加控制手段；必要时输入区用UIKit，正文继续Web | 仅包壳仍是HTML输入。必须消除当前visualViewport补偿与原生resize叠加，实测才算改善 |
| 豆包语音跳走后不自动返回 | 独立App身份与原生生命周期提供新的验证路线 | 没有找到豆包对这类壳的自动返回保证，不能承诺修复。若自做App内语音，才可主动避开外跳，但那是另一项功能 |
| 未发送文字/附件在WebView被回收后恢复 | 本地文件和持久草稿能覆盖当前内存Map的缺口 | 草稿持久化本身也可在PWA补；原生版要处理文件清理、凭据、升级与恢复，不能只换存储API |
| 上传期间锁屏或切App | 原生background URLSession配合本地文件/请求编号，可由系统托管上传 | 当前JS fetch不会因包壳获得后台传输。用户强退会取消后台任务，Mac离线依然无法完成；回来继续核对，未知发送不重放 |
| 从相册/Safari直接把截图、链接交给某个任务 | Share Extension可减少复制、切App、选文件等步骤，复用现有Mac附件与派发后端 | 这是较强的新增用途，需要独立实现接收分享、目标选择和凭据/文件共享，不是调用Share插件即可 |
| 冷启动和回前台 | 本地打包资源、原生启动与状态恢复有机会更稳定 | 当前PWA已有启动连续性修复，实际增量需对照；加载界面快不等于Mac任务就绪更快 |
| 通知 | 原生可以接APNs、快捷动作及系统入口 | PWA已支持Web Push，Pocket也已接入；原生需要另一条注册/投递链路，不能算封装自动附送的收益 |

模型响应速度、Mac睡眠/离线、隧道故障、桌面升级后的协议兼容，都由当前执行链路决定，不会因手机变成App而消失。

## 推荐形态与实现代价

保留React列表、阅读/Markdown、管理、队列与Mac原owner后端，增加一层范围清楚的iOS容器和桥接。先验证原生键盘事件是否足够；若仍有明确输入摩擦，再只把输入区原生化。Share Extension和后台文件传输分别接入，不先重写整套聊天界面。

三个具体成本不能忽略：

1. 本地打包页通常来自 `capacitor://localhost`，Pocket的 `src/api.ts`、`AccessGate.tsx` 使用相对URL，边缘和Mac服务要求精确同源Cookie/Origin/CSRF。需专门设计原生网络与设备会话，不能放开现有来源检查，也不能把Mac loopback token搬到手机。openGym的HTTP shim只覆盖JSON，尤其不能直接覆盖附件上传和中断语义。
2. 更新机制要分平台：当前 `PocketUpdate.tsx`、`appUpdate.ts` 和SW面向网站版本；本地bundle需要签名构建、安装/升级与前后端版本兼容。今天这种频繁的网页微调，原生随包更新会多一道交付环节。验证阶段也可临时使用远程页面保留同源，清楚区分它与最终本地打包方案。
3. iOS签名、权限、原生插件和真机回归会持续占维护精力。openGym让现成工具链可借，但不能免掉Pocket专属鉴权、恢复和通知工作。若以后公开上架，还需按Apple 4.2提供超出简单网址壳的实用价值；当前自用实验无需先做上架工程。

复用方式优先使用MIT许可的Capacitor及相应独立插件，自写Pocket adapter。openGym业务实现是AGPL，Gym visual媒体另有条件；本轮只借机制，不需要复制其业务代码或素材。

## 最小验证建议（尚未执行）

做一个可装的输入/附件对照样机，在同一iPhone、同一豆包版本、同一Mac和网络下比较当前PWA：

- 连续开合键盘、切后台回来，检查输入框/光标/阅读位置是否正确，记录是否还需手动恢复。
- 用同一句无敏感文字做豆包语音，不发送任务；核对是否自动回来、文字和草稿是否保留。必要时对比Web输入与UIKit输入，区分App身份和输入控件的影响。
- 上传一张图片时切后台/锁屏，返回后核对上传ID、状态和原字节；强退另测“重新打开后恢复并核对”，不要求强退后继续执行。
- 写一段草稿并选附件后重开，确认内容仍在；确认不会把未知派发当成未发送而重复提交。

先由这些结果决定是否继续。若输入/恢复无可感知改善，保留PWA作为主入口；若明显改善，再加“相册/Safari分享到Pocket并选任务”这一条系统收集流程。避免用图标、安装成功或一次冷启动截图替代实际收益。

## 一手资料

- [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)、[Capacitor iOS容器源码](https://github.com/ionic-team/capacitor/blob/main/ios/Capacitor/Capacitor/CAPBridgeViewController.swift)：仍使用WebView。
- [Capacitor Keyboard官方源码与README](https://github.com/ionic-team/capacitor-keyboard)：原生键盘事件、iOS resize模式；选用时锁定与Capacitor版本相容的插件，不能将主干新功能直接当作openGym v7已有能力。
- [Apple后台URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:))、[后台传输限制](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)：系统托管HTTP传输、文件上传与强退边界。
- [WebKit：iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)、[Capacitor Push Notifications](https://github.com/ionic-team/capacitor-plugins/tree/main/push-notifications)：PWA已有推送，原生APNs需另接。
- [Apple App Review 4.2](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality)：公开分发的最低功能要求，不作为本次自用试验的前置审批。
- Pocket现状与报告依据：[豆包回跳](2026-10-09-ios-doubao-pwa-return.md)、[键盘恢复](../design/2026-10-10-keyboard-recovery.md)、[附件发送](../design/2026-10-10-attachments.md)、[通知](../NOTIFICATIONS.md)。

Capacitor文档站本次直连403，键盘/推送改读ionic-team官方仓库。官方能力说明与本机源码已核对；没有Pocket iOS性能测试或豆包真机对照数据，本文的改善幅度属于待验证判断。
