# 浏览器截图、标注导出与摇动

- `captureFeedback(root, {signal, viewport})`：捕获指定根内的当前网页可见区域，返回`{blob,width,height,mime}`。`viewport`使用布局视口坐标，默认读取visualViewport；不会截图其他App、系统键盘或手机状态栏。宿主应先固定上下文，在导航/退出时abort，避免把新页面配给旧反馈。
- `normalizeFeedbackImage(blob)`：读取PNG/JPEG截图并按浏览器解码方向归一化，边长最多2048、最终每图最多2MiB；先检查文件和图像尺寸，再解码。HEIC/GIF/SVG不是此模块的手动输入格式。
- `renderFeedbackAnnotations(capture, annotations)`：使用与原图绑定的归一化矩形，依次绘编号和短说明。保留原Blob，不在用户图片上原地覆盖。
- `toFeedbackImage(capture, kind)`：序列化到共享合同。没有标注时仅发送original，避免无用的第二张图。
- `requestShakePermission()`：只能由用户点击启用时调用。`bindShakeFeedback({permission,enabled,onShake})`在已授权且页面可见时检测3次明确峰值，含5秒冷却；`enabled`可在反馈面板打开时返回false。返回值负责移除全部监听。
- `observeShakeReadiness({onReady,onReset})`：被动确认本页收到可信、有限的运动样本，不请求权限、不打开反馈；不可把持久的开启偏好当成本页授权。隐藏/离开/失焦后清空就绪证据，宿主可在下一次有效样本自动恢复；无样本只表示未确认，不能推断拒绝。恢复授权仍由明确手势调用上面的权限函数。

截图采用固定`modern-screenshot@4.7.0`（MIT）。默认保留系统字体与常见布局/文字/SVG绘制属性，不下载外部字体；宿主使用特殊CSS或字体时应重新做截图对照。采用viewport裁剪、屏外块占位和受控图片插入，避免完整旧消息树以及lazy image的native clone触发额外请求。普通图片优先复用已载入且Canvas可读取的像素；其它资源限可见、同源、32项/合计8MiB。可见或有布局的iframe/video等嵌入媒体会给出可恢复的手动截图提示。

允许`img-src blob:`以显示本地草稿和解码；其余无需放宽Pocket的正式CSP。库短期使用同源隐藏iframe计算默认样式，结束和失败均清理。升级库时必须回归post-order clone hook假设、屏外图片不重拉、viewport偏移与滚动、密码清空及CSP；不要只验证“返回了PNG”。

2026-10-29：合成像素场景和真实Pocket组件（60条合成消息）在Chromium/WebKit通过。后者1197节点，优化后的同机单次约0.1/0.3秒；WebKit与完整属性基线像素一致，Chromium约0.063%像素差。它不是实体iPhone性能结论。详细回执保存在项目`.local/qa/feedback-capture-2026-10-29/`。
