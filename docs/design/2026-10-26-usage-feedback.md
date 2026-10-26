# Pocket 使用反馈与 PostHog

2026-10-26。欧吉安确认采用[选型方案](../../../research/2026-10-26-product-usage-feedback.md)，随后提供本人已建立的 PostHog 项目，并授权完成接入、发布和验证。本轮内容屏蔽专题按本人要求暂不展开。

## 范围与入口

- PostHog Cloud US，项目 `688532`，选择 Free 有额度上限方案；没有绑定支付方式或升级付费。
- [事件](https://us.posthog.com/project/688532/activity/events)、[回放](https://us.posthog.com/project/688532/replay/home)、[产品分析](https://us.posthog.com/project/688532/insights)。先筛选 `environment = production`；合成验收使用 `qa`，不能混作日常使用证据。
- 客户端公开采集配置位于 `config/usage-analytics.json`。`projectKey` 是官方明确用于浏览器的项目采集 token，仅用于上报，不是具有查询/管理权限的个人 API key。个人 API key、Cookie、登录口令不进入此文件。
- 仅对配置中的正式 origin、已登录的 App 启动分析；退出或认证失效停止。开发和临时预览默认不采集，QA 构建须显式覆盖 origin 并标记 `qa`。
- 页面标题进入“会话信息”，点击“刚才不顺”立即标记当前片段；原因和最多500字说明可选，补充与原标记共用 `feedback_id`。该操作不发送会话消息、不修改原任务。

## 采集与事件口径

固定 `posthog-js@1.438.21`。SDK及录制器通过同站点的懒加载chunk载入，避免录制器再等一次外站JS加载。加载和网络失败不阻塞Pocket；初始化前仅保留最多100条内存事件，退出会清除。客户端确认只表示已交给采集链路，不等于服务端已持久接收。

PostHog项目已启用Session Replay。第一版关闭额外的自动点击、热图、Web Vitals、Surveys/Product Tours及自动异常采集，使用具名产品事件与现有请求错误入口。一次手动`$pageview`支持Web Analytics。前端沿用SDK输入默认处理；不采集请求/响应正文、头部或控制台日志。没有修改原桌面owner、发送编号、队列、草稿或已读水位。

| 事件 | 触发与判定 |
| --- | --- |
| `pocket_usage_started` / `$pageview` | 已登录App的SDK初始化；登录页不计 |
| `pocket_conversation_opened` | 详情挂载后的首帧；每次真实进入生成`visit_id`，React开发期预演取消 |
| `pocket_content_visible` | 正文、提问、过程摘要、空状态、提交/队列卡片实际进入可见区域；每visit一次，不等于读完 |
| `pocket_composer_focused` | 每visit首次聚焦会话输入框；不记录逐键输入 |
| `pocket_submission_started` | 新提交，按`request_id`唯一；`mode`区分直接/排队，`attachment_count`记录附件数 |
| `pocket_submission_checked` | 核对旧请求；不增加新发送分母 |
| `pocket_submission_receipt` | 该浏览器本次跟踪请求的回执状态变化；同状态去重，accepted/cancelled不被迟到回执覆盖 |
| `pocket_submission_visible` | 精确`clientMessageId`的非截断用户消息进入视口；不是模型完成，也不推进已读水位 |
| `pocket_submission_wait_ended` | 提交等待结束，注明是否仍属于当前视图；不等于成功 |
| `pocket_visibility_changed` / `pocket_page_hidden` | 前后台和页面离开/BFCache；离开不直接计作失败 |
| `pocket_conversation_closed` | 详情关闭/切换，记录本次是否看到了内容、是否留有草稿；浏览器强杀不能保证事件送达 |
| `pocket_request_failed` | transcript/history/submit失败；记录操作、HTTP状态和错误码，正常Abort不记失败 |
| `pocket_feedback_marked` / `pocket_feedback_details` | 标记片段及可选原因/说明，按`feedback_id`合并 |

公共属性包括 `environment`、`machine_id`、`frontend_version`、`display_mode`；SDK提供自己的session/匿名设备关联。会话行为加`thread_id`、`visit_id`；发送加`request_id`，回显另保留`submission_visit_id`以区分跨会话返回。当前只跟踪本页面启动后的最多100个提交，重载不恢复这份统计内存，也不会把旧历史当新发送。

`elapsed_ms`是总历时，`foreground_ms`扣除了页面隐藏时间；后者仍是前台停留，不宣称用户始终在专注或等待。点击发送、收到accepted、看到原用户消息是三个独立时点。当前不测“此次指令导致的首个模型回复”：对同轮steer和并发消息，仅靠turnId不足以建立可靠因果关系。

## 怎样据此改产品

先查看`pocket_feedback_marked`关联的session，再对照回执状态、失败事件和回放，提出可复现的问题。需要比例时以同一版本、平台与闭合观察窗口的唯一request/visit作分母；不要直接使用默认按人计数的漏斗冒充每次发送的成功率。unknown、未等到结果、关闭和采集缺失分别保留。

测试数据均标记`environment=qa`；只看一次合成流程不能断言真实用户痛点已减少。观察一段真实使用后，再根据问题频率决定原竞品参考中的功能优先级。没有新增定时任务或恢复已暂停的“持续打磨Pocket”。

Agent当前可使用本人已登录的PostHog页面查询事件与回放。本轮未安装全局MCP或生成长期个人查询密钥；未来需要无人值守分析时另行接续官方MCP，不把公开采集token当查询凭据。

## 验证与接续

- 7项journal回归覆盖前后台计时、状态去重、精确回显、跨visit迟到回执、取消终态、反馈关联与失败隔离。
- 独立只读审查发现并修正：取消后迟到queued污染状态、提问卡漏记可见性，以及队列不在原正文观察根内。观察根现包含正文与队列，内部滚动裁剪由IntersectionObserver处理。
- 隔离浏览器使用合成会话API，不调用真实Codex执行；PostHog上报为真实服务。SDK默认过滤`navigator.webdriver`，QA配置显式使用官方`opt_out_useragent_filter`并标记`qa`；正式配置保留默认bot过滤，不能把自动化过滤误报为SDK失效。
- 完整验证与发布结果回到[CURRENT](../../CURRENT.md)；本轮证据在`.local/qa/usage-2026-10-26/`。`browser.mjs`保留合成发送、反馈、原草稿、真实SDK事件/回放和锁定/SDK阻断场景。
- 本轮npm审计提示原有Vite7.3.6/source-map-js1.2.1开发依赖问题；与HEAD版本一致，未由PostHog新增。暂未扩展为工具链升级，原始审计见证据目录。

停用采集：将公开配置的`enabled`设为false后正常构建发布。该配置纳入前端build ID，安装中的Pocket会沿现有显式更新与草稿保护流程发现新版本；已经打开的旧网页需完成正常更新。
