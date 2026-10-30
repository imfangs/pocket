# iOS 主屏幕应用的顶部模糊

2026-10-30。欧吉安确认，上一版 `6cc465b4fcf2` 去掉应用背景滤镜后，问题仍然存在：关闭新建弹窗或会话详情，列表的“全部”和加号从中间向上变模糊；打开再关闭菜单会恢复清晰。前一轮滤镜清理是已发布但未解决原现象的尝试，不能继续视为有效修复。

## 原因与修复

新版 iOS WebKit 会在原生层绘制 scroll edge effect。它不属于网页CSS，所以检查 `filter` / `backdrop-filter: none` 或桌面WebKit截图不足以排除它。

固定上游源码 `169d2d3a12b0fbb128b2aee41db1a2064df5768c` 的相关机制：

- [LocalFrameView.cpp](https://github.com/WebKit/WebKit/blob/169d2d3a12b0fbb128b2aee41db1a2064df5768c/Source/WebCore/page/LocalFrameView.cpp#L2485) 从顶部采样点及其祖先识别有背景的fixed/sticky容器；普通static元素不具备资格，不要求当前sticky已有偏移或额外正z-index。
- [WKWebViewIOS.mm](https://github.com/WebKit/WebKit/blob/169d2d3a12b0fbb128b2aee41db1a2064df5768c/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm#L2430) 的常规路径通过顶部color extension是否存在控制原生模糊；特殊visible-inset/hard-effect分支仍存在，不能只凭一个样式绝对承诺所有系统版本。
- [Page.cpp](https://github.com/WebKit/WebKit/blob/169d2d3a12b0fbb128b2aee41db1a2064df5768c/Source/WebCore/page/Page.cpp#L5844) 会保留仍有renderer的旧边缘。Pocket菜单关闭时只移出屏幕，节点继续存在；详情和弹窗关闭时卸载。这与“开关菜单会恢复”的反馈相符。

[Outline的同类修复](https://github.com/outline/outline/pull/14238/files)也处理了iOS已安装网页顶部模糊覆盖标题按钮：为已有sticky标题提供实色背景。Pocket标题已有不透明背景，但缺少fixed/sticky身份。

修复只在 `src/pwa.css` 的手机媒体查询中，为 `.workspace-header` 增加 `position: sticky; top: 0`，使列表本身持续提供实色顶部边缘。保持原flex占位、尺寸、padding和独立列表滚动；不增加z-index、transform、全页scrollTo或刷新补丁。详情、键盘、焦点、inert、消息与发送策略均不改。

## 验证状态

- 1,882项完整回归与构建通过，独立CR通过。
- Chromium/WebKit、320/390/1280px、明暗主题12组布局对照确认候选不改变标题、加号、列表几何；手机顶部采样从无定位祖先变为实色sticky容器，桌面保持原样。这只是原生机制输入的验证。
- 最终候选 `92f5211694d0cc136a603a6ccdb58fac9079e954454d53ea6509c565be8ee483` 的28组双浏览器检查覆盖12次详情返回、菜单与新建开关；交互和状态清理正常，不把该结果视为iOS模糊复现。
- iOS27原生Safari的首次新建关闭没有复现，标题与加号区域截图前后像素一致。
- iPhone17模拟器、iOS27主屏幕PWA已通过 `navigator.standalone` 与 `display-mode: standalone` 确认（402×812 CSS、DPR3）。已捕获对应红样本：开关菜单前后的原生像素差在标题和加号上半部，至物理y306以下归零；标题边缘方差4864.9→6504.4，加号2279.7→2464.0。PWA启动时就可能已有模糊，不能把“启动”和“关闭新建框”相同当成阴性；应以菜单恢复后的清晰画面为基线。
- 原生A→B→A已闭合：新document的static版本关闭新建/详情后变糊；仅加sticky/top0后，新建关闭与清晰基线在物理区域 `(0,186,1206,354)` 的RGB差异为0；换回新的static document，详情返回后模糊再次出现。几何、viewport高度812及offset0保持，排除菜单偶然刷新。
- 最终包 `92f521…` 在没有CSS注入的独立PWA document中重新验证：首次打开、新建关闭和详情返回都与清晰基线逐像素相同。`compare.py` / `pixel-comparison.json` 保存自动断言。初次sticky截图因测试点在键盘动画前的旧位置、dialog实际未关闭而作废；最终采样均先核对dialog/detail/menu状态，未将中间帧记成通过。

原生模拟器已确认修复所述机制与两条触发路径；物理iPhone上的版本和实际使用仍以更新后的反馈为准。本机内置网页已回读同一构建；公网尚未发布。

取证：`.local/qa/top-blur-research-2026-10-30/` 保存固定官方源码、Outline补丁与hash清单；`.local/qa/top-edge-2026-10-30/` 保存布局、最终包及回归结果；`.local/qa/top-blur-native-2026-10-30/` 保存原生样本和事件。合成接口不访问真实任务，不进行真实发送或新建。

## 发布阻塞与接续

本轮没有调用deploy或上传新版。Cloudflare登录凭据过期后，CLI续期长时间未完成；官方device页面曾持续空白，官方refresh的单次curl尝试在TLS阶段超时，结果未确认而没有重放、没有写回配置。最后一次在浏览器页面恢复后，Wrangler仍在取得device code之前返回`fetch failed`。认证临时页面和进程均已清理，原scope保持；最终一次公网版本回读也在连接阶段超时，不把它记成线上验证通过。

网络恢复后，沿 `.local/qa/top-edge-2026-10-30/login-publish-account.sh` 或同版本Wrangler的官方登录恢复现有账号，先核对账号/权限与当前Git状态，再使用项目pages-site配置**deploy这个新版本**，并完成资源及功能回读。不要resume上次`9e08a4fc…`部署来假称新版本已经上线。原生和代码验证已完成，无新代码或新反证时不重复创建模拟器。

认证诊断在`auth-recovery-summary.json`、`auth-refresh-once.json`和`auth-final-attempt-summary.json`。原生清理在`top-blur-native-2026-10-30/cleanup.json`：一次性设备、53811/53812服务与镜像均已删除/关闭，剪贴板同步恢复，约16MB中间截图已清掉，关键证据与2.8MiB基线保留。
