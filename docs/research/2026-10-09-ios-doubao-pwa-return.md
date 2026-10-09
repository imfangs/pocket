# iOS 主屏幕 Pocket 与豆包语音回跳

2026-10-09。状态：已核对代码与平台边界，原症状尚未复现或确认修复。基线 `19deda5`，当前产品源码 `4e185d0`。

## 用户报告与待区分现象

方帅通过Safari分享添加到主屏幕后使用Pocket，在豆包输入法点击开始说话，会切到豆包类似授权的界面；其他App能够自动切回来，Pocket不能。

主屏幕入口确为PWA独立窗口：manifest的display为standalone，id/start_url/scope均为`/`，并设置apple-mobile-web-app-capable。需要区分“仍停在豆包，未唤回Pocket”和“已经回来，但焦点/文字/页面丢失”。已询问手动返回是否填入识别文字，以及Safari标签页能否自动返回；本记录写入时尚未得到回答。报告手机的iOS和输入法版本尚未确认。

## 已确认的代码事实

- `src/AutoTextarea.tsx`保留同一个原生textarea，仅调整高度和内部滚动；没有在blur或后台事件中调用blur、导航或替换节点。
- `src/Conversation.tsx`普通输入通过input/change接收文字，只有正在提交时禁用。历史刷新和切后台不直接禁用输入框。
- `src/App.tsx`回前台同步目录，`src/AccessGate.tsx`复核登录。网络失败保留已登录App，没有自动刷新整页；明确登录失效才卸载App。
- 没有豆包callback、自定义原生URL scheme或输入法回跳协议。`public/sw.js`中的focus只属于用户点击通知后的处理，不能作为豆包录音完成时的后台唤回方式。

上述事实不支持直接把原症状归因于Pocket主动丢焦点。登录真正失效、当前任务从目录消失或iOS重建WebView确实可能影响返回后的页面和内存草稿，但它们是另一组待验证现象，不能替代“没有自动切回”的证据。

## 一手来源

1. [Apple：Configuring open access for a custom keyboard](https://developer.apple.com/documentation/uikit/configuring-open-access-for-a-custom-keyboard)。本轮回读说明键盘扩展沙箱不允许访问麦克风；开放访问的能力说明也未赋予麦克风访问。这解释了第三方输入法需要额外录音流程的动机，不能单独证明豆包怎样识别宿主或自动返回。
2. [WebKit：Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。manifest id用于Web App身份及Focus同步，不等于注册原生回跳scheme。[Apple原生scheme文档](https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app)要求App注册对应地址。修改Pocket名称或manifest id不是有证据的修复。
3. [豆包输入法App Store](https://apps.apple.com/cn/app/id6752316550)。10-09通过Apple iTunes Search API读到版本1.5.6、发布日期2026-09-23；这是商店版本，不能视为用户安装版本。官方描述明确写道：“可以选择麦克风一直保持，保持后使用语音不用跳转”。该功能可作为绕开跨App回跳的尝试，需要用户自行决定是否接受更长时间的麦克风占用；尚未在报告手机上验证。

公共检索没有找到能直接复现“豆包＋主屏幕PWA自动返回失败”的官方问题记录。搜索摘要或其他平台输入法故障不作为根因证据。

## 下一步验证与执行边界

在同一手机、同一输入法版本，分别使用备忘录、Safari中的Pocket、主屏幕Pocket，输入同一段无敏感信息的短句，不发送任务。观察是否自动返回；失败时用应用切换器手动回去，记录识别文字、光标、原草稿及有无登录/启动页。

- 手动回去能填字且原页面正常：优先调查豆包/iOS对主屏幕Web App的唤回兼容性；不能用修改textarea冒充已解决系统级回跳。
- 手动回去无文字或输入节点丢失：再建立Pocket页面生命周期复现，检查focus、节点身份、disabled和页面是否重建。必要的临时诊断只记录事件与文字长度，不采集正文或录音。
- Safari正常而主屏幕版失败：可先尝试Safari使用或豆包官方不跳转方式，并保留同机对照证据。

本机设备工具可列出一台已连接iPhone，但精确查询未取得豆包安装记录；未确认它就是报告手机，未操作手机界面或录音，因此不作为真机复现。相关只读证据在`.local/qa/doubao-pwa-2026-10-09/`。

本轮没有修改产品代码、输入法权限或麦克风设置，没有部署。网页可以改善回到前台之后的体验，但不能直接控制豆包结束后的系统级App切换；最终根因与修复仍待同机结果。
