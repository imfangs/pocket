# 客户端版本与排查

2026-10-30。用户在反馈“看不到标题扫光”时提出：请求和问题上报应带客户端版本，避免只知道最新发布了什么，却不知道出问题的页面运行哪一版。

## 单一来源

沿用`bin/build-version.mjs`计算的前端内容哈希与`__POCKET_BUILD_ID__`，不另维护容易漏更新的手填版本号。`src/clientVersion.ts`统一导出`CLIENT_VERSION`、`CLIENT_VERSION_HEADER`和`clientVersionHeaders()`；设置显示前12位，完整值留在title、请求及反馈。开发/Node环境使用`development`，无效值安全回退。

- 公共`api()`的所有实际出口，包括认证、JSON、原始附件PUT、403补读/重试及304/204回退，都携带`X-Pocket-Client-Version`。
- 文件预览/下载的JavaScript读取、网页更新检查同样携带版本头。网关仅透传160字符内的安全版本标签；缺失或格式错误只忽略该诊断字段，不阻止请求。
- 使用事件继续用`frontend_version`，截图反馈继续用`context.frontendVersion`，现在都引用同一常量。旧反馈草稿保留捕获时版本，发送该草稿的当前请求头可以是较新版，两者不互相覆盖。
- 原生`img`/`video`及浏览器自行下载的资源不能通过组件设置任意请求头；不为补字段改写受控媒体URL、签名参数或原生播放。第三方SDK也不注入Pocket自定义头，事件正文已有版本。

版本是诊断标签，不是可信身份或连接门槛，不替换CSRF、机器来源、内容版本、ETag或缓存key。客户端版本与Mac后端/桌面版本分开，前端更新不要求重启Mac。

## 验证与证据

本轮1,854项全测通过。版本基础层45项回归与独立CR、接线60项针对性复核通过。最终构建`a8bd26896b062730f64021d1e703a8e37e9b978af6e2f303f1de2a5177982680`在390px Chromium/WebKit和1280px Chromium的39项入口检查通过，逐条核对JavaScript API/更新请求头与设置长短版本均匹配该构建；不导入开发源码，不真实发送。证据在`.local/qa/request-title-visibility-2026-10-30/`；发布结果回CURRENT。
