# 交互 HTML 预览

2026-11-07。用户指出：Pocket附件多数是自己或Agent生成的作品，默认禁用JS的限制与主要使用场景不相称。此次将默认预览从静态改为可交互，延续[文件/嵌图通道](2026-11-07-html-file-preview.md)，不修改原文件或Mac执行权限。

## 取舍和实现

允许原HTML的脚本、事件、表单控件，以及常见HTTPS脚本/CSS/图片/字体/媒体和网络请求。没有额外启用按钮或逐次确认，移除静态提示。外部资源不再承诺零请求；作者脚本和加载的第三方代码可读取本预览的内容。这是正常网页运行能力，信任边界与此前静态模式不同。

预览仍与Pocket主页面分离：HTTP公开shell不含私有文件，用opaque sandbox运行；不开放same-origin或顶层导航。预览无法读取Pocket父DOM、Cookie或存储，Pocket原API跨站/Origin检查保持。基本隔离不妨碍页面内搜索、筛选与绘图；不是将文件JS放进Pocket主DOM，也不把文件代码直接作为Mac指令。

父CSP原script-src self不变。独立HTTP shell有自身策略，Worker仅对shell和extensionless别名覆盖CSP（不append继承策略），_routes涵盖这两个路径；其他公开壳与API策略保持。新shell/运行时代码公开托管但无用户数据，私有HTML和批准的内嵌图仍只在认证读取后的客户端内存内，通过绑定frame/source/origin/32hex nonce的一次初始化消息送入预览，不上传服务器。

保留原件下载、源码切换、同iframe状态、阅读位置和草稿；框内Escape通过仅能关闭本预览的消息恢复到原入口，IME/defaultPrevented及作者自己打开的dialog优先。私件不进入rrweb记录，ph-no-capture标记继续保持。基础iframe隔离仍意味着访客没有Pocket存储或原生设备权限；不把可执行JS当成整个客户端权限。

标准HTML解析保留原脚本和控件，批准的本地图仍替换为data。去掉覆盖预览策略的原meta CSP和会重载空shell的meta refresh；原始文件字节不变。源文件/嵌图授权和大小预算仍由既有API负责。新增serialized projection 16MiB上限，覆盖合法原始输入在实体转义后膨胀的实际边界，超限明确退回源码而非空白。

## 验证与历史

实际选集原脚本默认只显示13个推荐项目，这是作者原设计；选择全部后21项，搜索SumOne→1项、清空→21项。双浏览器21张图全部解码，原样式/源码/下载保持。合成测试包含inline点击、搜索、HTTPS外部脚本/样式/图片、同frame状态、父DOM/Cookie/storage负例及真实Worker Origin:null403/upstream0；验证隐私与关闭，不能继续用旧“所有脚本不运行、所有网络为0”的断言掩盖新需求。

静态render helper作为兼容契约保留，现行交互功能使用独立helper/runtime。原静态版和其当时证据保留，不改写旧结论。已发现并修复两项具体协议/预算缺口：parent重复ready重复交付，以及projection超限runtime静默拒绝。当前源码、完整回归及最终发布回读由CURRENT维护。证据`.local/qa/html-interactive-2026-11-07/`。未做实体iPhone或新的目视审美验收。

Node源码也只对精确shell/alias应用同一独立策略，端口0 HTTP双浏览器bootstrap和inline JS通过；普通静态资源/API保持原policy。当前两机运行的是上一版不可变API/内置静态UI，本轮不重启或冒充它们已升级，手机共享Pages是交互目标。外链_top/_parent转普通_blank，保留新窗口且不替换Pocket；已核对WebKit原先回退popup请求确非主页面导航，未泛化过滤异常。

最终源码对应build cbb95494377cb121efeeef015913dea25abe043880553447afe91828339bf8b2：133浏览器/设施、20专项、67定向纯测、真实选集2浏览器通过；完整2103中2101通过、2项旧原生恢复范围失败，无跳过。机械检查无新增发现，12个独立CR源哈希保持匹配。发布前数据与源身份分开记录，不把浏览器结果当成实体手机验收。
