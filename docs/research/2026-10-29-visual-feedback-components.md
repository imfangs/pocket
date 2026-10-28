# 网页截图反馈与自动开发会话：组件核验

2026-10-29。用户提出借鉴客户端的「摇一摇 → 截图/圈注 → 输入 → 发送反馈」，希望沿用现有反馈服务，并把反馈自动整理成Query送到当前开发会话。本文记录能力核实与建议接法；没有安装组件、启用目的地或发送反馈/Query。

## 结论

保留PostHog。它已有文字反馈、回放关联、过滤事件及签名Webhook，能承担反馈记录与自动通知；Pocket负责认证后的原始反馈、附件和投递账本。截图与圈注需增加前端模块，不能称作当前PostHog接入自带。

当前Pocket使用`posthog-js@1.438.21`，`src/usageAnalytics.ts`显式`disable_surveys:true`；「刚才不顺」是自定义`pocket_feedback_marked`/`pocket_feedback_details`事件，不是原生Survey。因此无需为自动投递先迁换现有表单。

## 已确认的能力

| 部分 | 当前核实结果 |
| --- | --- |
| PostHog Surveys | 可弹popover、提供feedback widget及自定义UI；已安装SDK题型为文字、单/多选、评分和链接，没有截图上传或圈注类型 |
| 回放定位 | `get_session_replay_url({withTimestamp:true})`可关联具体时刻；回放不等于一张截图PNG |
| 自动转发 | HTTP Webhook目的地可过滤事件/属性、自定义JSON，支持Standard Webhooks `signing_secret`及加密`secret_headers` |
| 现有项目的工具入口 | 已只读取回稳定的`template-webhook`；`cdp-functions-create`可用，写权限/配置启用尚未实际验证 |
| 免费范围 | 官方当日定价：Destinations每月10,000个触发事件；Surveys每月1,500回答。模板`free:false`表示计量，不代表没有免费额度；不以此代替实际账号额度检查 |
| 摇动 | 浏览器DeviceMotion需要权限；支持`requestPermission()`的平台要求HTTPS及用户点击等瞬时激活，不能默认静默获得传感器权限 |

PostHog Toolbar中的截图用于维护者给事件定义附图，不能把它当作终端用户反馈截图功能。

## 组件对照

| 候选 | 核实与取舍 |
| --- | --- |
| Sentry User Feedback | 反馈/截图编辑成熟，但官方明确内置截图不支持mobile，按钮会隐藏；不适合为iPhone截图新增这套平台 |
| Gleap JavaScript SDK | 官方说明移动端用页面渲染截图，产品有圈注；SDK为MIT但完整体验依赖其平台token，会叠加另一套服务，暂不优先 |
| marker.js 3 | 可独立做图片圈注和导出；Linkware要求保留可见链接/归属，去除需要商业许可，不能当作MIT无条件使用 |
| Annotorious 3.9.5 | BSD-3-Clause；React包装声明支持React19；官方支持触摸拖动框选、JSON导出/恢复和自定义保存，不强制SaaS或界面署名。适合做框选＋意见候选，但并非截图/反馈一体SDK |

Annotorious发布包的React peer range存在不规范写法，需通过隔离安装/构建核验，不能把兼容声明当成实测。没有做iPhone PWA的截屏、缩放、拖动或键盘体验验证。网页截图模块也需独立测试真实Pocket内容、图片、浮层与Mermaid。

## 用户指定的自动投递方向

目标是Pocket反馈进入[当前开发会话](codex://threads/01a10908-f0cc-7971-abc8-8d70125af187)。建议链路：

1. 已登录Pocket用户明确发送，认证接口保存原图/标注/意见、页面和版本，生成固定`feedback_id`。
2. PostHog记录反馈并关联回放；仅匹配最终提交事件，不把页面浏览、单次标记或每次编辑都转成任务。
3. 签名Webhook通知Pocket接收端；按ID取回已登记内容并验证摘要，目标会话由受控配置确定。
4. 通过现有可靠发送/队列机制投递一次Query，保存feedback_id到requestId及回执的映射；结果未知先核对，不重放。旧反馈不自动补发。

公开浏览器projectKey只能标识采集项目，外部也能构造采集事件。Webhook签名证明PostHog送达，不能单独证明用户授权；因此不能直接把任意事件正文、目标会话或路径作为可执行请求。反馈正文作为待调查资料，自动派发只在预先配置的Pocket项目/开发会话范围内。

实施前还需核验：账号目的地写权限、Webhook重试和Mac离线时的补偿、两台来源机器到固定开发会话的路由，以及截图/圈注的真实手机效果。本文是接入依据，产品状态仍回CURRENT。

## 官方来源

- [Surveys](https://posthog.com/docs/surveys/creating-surveys)、[自定义UI](https://posthog.com/docs/surveys/implementing-custom-surveys)、[结果目的地](https://posthog.com/docs/surveys/destinations)
- [HTTP Webhook](https://posthog.com/docs/data-pipelines/destinations/webhook)、[定制与秘密输入](https://posthog.com/docs/data-pipelines/destinations/customizing-destinations)、[API](https://posthog.com/docs/data-pipelines/surfaces/api)、[定价](https://posthog.com/pricing)
- [Sentry反馈](https://docs.sentry.io/platforms/javascript/user-feedback/)、[Gleap截图机制](https://docs.gleap.ai/documentation/javascript/screenshots-and-recordings)
- [Annotorious许可](https://github.com/annotorious/annotorious/blob/main/LICENSE)、[React包元数据](https://registry.npmjs.org/@annotorious%2freact/latest)、[触摸入门](https://annotorious.dev/getting-started/)、[图片标注API](https://annotorious.dev/api-reference/image-annotator/)
- [marker.js许可](https://github.com/ailon/markerjs3/blob/main/LICENSE)
- [MDN运动权限](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static)
