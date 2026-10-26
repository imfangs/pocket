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

初次接入通过本人已登录的PostHog页面查询事件与回放，没有安装全局MCP。后续CLI/Skill的采用与认证状态见下节；公开采集token不能作为查询凭据。

## 后续工具：CLI 与 Skill

2026-10-26同日补充。用户要求后续方便使用，并把接入过程写成札记。

- 已安装官方`@posthog/cli 0.18.12`，命令为`posthog-cli`；来源为npm官方registry与[PostHog monorepo/cli](https://github.com/PostHog/posthog/tree/master/cli)。`--version`、`api --agent-help`、工具搜索/schema和Skill目录已实际执行。
- 当前CLI的`api`直接暴露MCP工具目录，也支持SQL查询。我们有终端，因此先用CLI，不重复增加独立MCP连接。没有运行初始化Wizard改写现有产品。
- 已全局安装官方[PostHog Best Practices](/Users/fangs/.codex/skills/posthog-best-practices/SKILL.md) 1.58.0，12个上游文件按SHA核对，来源与安装命令保存在同目录`UPSTREAM.json`。下一轮会话可发现；后续按需读具体产品reference。
- `audit-events`试装后发现依赖当前没有的`mcp__wizard-tools__audit_*`运行时，已移除试装副本。`mcp-analytics`是在MCP服务器中埋点，不是用MCP分析已有产品数据；不按名字相似误装。
- CLI查询认证已完成：用户在重新生成的授权页自行确认，凭据保存于`~/.posthog/credentials.json`，权限设为0600；US host与项目688532已回读。此前一次TLS握手失败和一次临时码过期均未生成凭据，没有关闭证书校验。本次执行的是只读查询；最终令牌scope由用户页面决定，不能把此前准备的只读选择当作独立核验过的最终scope。
- 真实`project-get`、事件/属性schema、SQL表结构与反馈记录查询均成功。查询原反馈只得到QA记录，继而定位到正式CSP阻断，见下节。安装成功与能查私人数据的两个阶段现均已验证，真实用户反馈是否入库仍需按具体记录核对。
- 发布包0.18.12实际不支持上游master README中的`api call --project-id`，会将该flag误认为工具名。已实测改用每次调用的`POSTHOG_PROJECT_ID`与`POSTHOG_CLI_PROJECT_ID`，先读目标项目；保留这项版本边界，升级后再核对实际CLI。

常用流程：首次需要使用CLI时读`posthog-cli api --agent-help`；用`api search <关键词>`找工具、`api info <工具>`确认输入，复杂字段再用`api schema`。所有Pocket调用显式指定目标项目，例如：

```bash
posthog-cli api info project-get
POSTHOG_PROJECT_ID=688532 POSTHOG_CLI_PROJECT_ID=688532 posthog-cli api call --json project-get '{}'
posthog-cli api info read-data-schema
POSTHOG_PROJECT_ID=688532 POSTHOG_CLI_PROJECT_ID=688532 posthog-cli api call --json read-data-schema '{"query":{"kind":"events","limit":100}}'
```

上述call已在当前安装实际执行成功。先核对实际事件与属性，再做分析；生产数据用`environment=production`。统计发送时以唯一request、观察窗口和状态合同为准，不用按人计数的默认漏斗替代。CLI目录/schema是随版本变化的来源，不在文档里复制全工具表。

## 同日纠错：正式 CSP 拦截了上报

欧吉安完成CLI授权后要求查找刚提交的反馈，并确认来自“刚才不顺”。只读SQL查询没有找到production反馈，最新数据也只有此前QA。回读正式站响应头发现`connect-src 'self'`，而原合成fixture没有携带该CSP；因此原先“已接入上线”的结论只验证了合成环境到PostHog，没有证明正式网页能上报。这是格得的验收遗漏。

修复只在Pages及本机HTML的`connect-src`增加`https://us.i.posthog.com`、`https://us-assets.i.posthog.com`；脚本仍限定self，frame/默认源限制保持。新增服务端/Pages策略回归，发布功能检查独立回读首页CSP、与源文件比对并核验所需连接域名。带原正式CSP的浏览器复现8项通过（明确观察到阻断、零反馈上报）；修复策略下34项浏览器检查与1378项全测通过。网页部署与本机服务均已更新；队列、派发账本、分组、备注及置顶哈希前后相同，仅sourceInfo因正常同步刷新。原Codex和连接器未重启。

证据在`.local/qa/usage-csp-2026-10-26/`：`headers-before.txt`、两组`browser-results.json`、`tests.log`、`pages-deploy.json`、`local-restart.json`、存储比较与原私有SQLite备份。此次查询时用户原反馈尚未入库；已打开的旧页面需更新/重开才能获得新CSP，不能把修复后的QA反馈当作那条原反馈或承诺旧请求会补传。

## 验证与接续

- 7项journal回归覆盖前后台计时、状态去重、精确回显、跨visit迟到回执、取消终态、反馈关联与失败隔离。
- 独立只读审查发现并修正：取消后迟到queued污染状态、提问卡漏记可见性，以及队列不在原正文观察根内。观察根现包含正文与队列，内部滚动裁剪由IntersectionObserver处理。
- 隔离浏览器使用合成会话API，不调用真实Codex执行；PostHog上报为真实服务。SDK默认过滤`navigator.webdriver`，QA配置显式使用官方`opt_out_useragent_filter`并标记`qa`；正式配置保留默认bot过滤，不能把自动化过滤误报为SDK失效。
- 完整验证与发布结果回到[CURRENT](../../CURRENT.md)；本轮证据在`.local/qa/usage-2026-10-26/`。`browser.mjs`保留合成发送、反馈、原草稿、真实SDK事件/回放和锁定/SDK阻断场景。
- 完成结果：1373项全测、34项浏览器检查和30个公网文件/功能回读通过；真实后台回读到了具名事件、两段录制，并打开[独立验收回放](https://us.posthog.com/project/688532/replay/01a176e3-0d8b-7f1d-a742-db39c010cce5)显示Pocket合成正文、发送回显和输入框，重新播放可回到00:00。
- PostHog默认回放列表过滤`> 5 active seconds`，会隐藏短验收录制；本次临时调为`> 0`后可见。列表内嵌播放器曾报`We couldn't load the replay player`，重试仍不稳定；Share→Open in new browser tab的独立页面播放通过。这是本次查看端证据，不改用户浏览器扩展或安全设置，也不声称上游加载问题已修复。
- 本轮npm审计提示原有Vite7.3.6/source-map-js1.2.1开发依赖问题；与HEAD版本一致，未由PostHog新增。暂未扩展为工具链升级，原始审计见证据目录。

停用采集：将公开配置的`enabled`设为false后正常构建发布。该配置纳入前端build ID，安装中的Pocket会沿现有显式更新与草稿保护流程发现新版本；已经打开的旧网页需完成正常更新。

札记已按`discussion-notes / N-20261026-POSTHOG`投递到[本机日常](https://daily.local/#entry=8bea14c5-eef0-4d70-beea-4bad58c19966)，revision 3、verified=true，独立get的正文与下节原文一致。

## 札记：从猜功能到看真实使用

**稳定ID**：`N-20261026-POSTHOG`

**日期**：2026-10-26

**主题**：产品反馈、PostHog、Pocket、事件口径、会话回放、Agent工具

**来源**：本次Codex对话、本文实现记录与官方资料；欧吉安明确要求记录接入过程。

**何时重看**：给下一款产品接使用分析、面对“感觉不顺但说不清”、按竞品清单决定功能，或认为埋点已接通就足够时。

### 先被纠正的是问题

讨论最初围绕T3、Happy、HAPI有哪些移动功能值得借。格得推荐了查找、文件预览、暂存草稿和返回连续性；欧吉安反问：“好像这4项我们用的其实不太多吧。”随后转向：我们怎样看到日常使用真正卡住的地方，将来做类似产品时又怎样了解用户。

这句话没有证明四项功能没有价值，却指出排序缺少依据。格得的判断是：先让现有高频路径产生可回查的反馈，再决定补哪项功能。竞品告诉我们有哪些做法，真实使用帮助决定我们现在该做哪件事。

### 为什么这次选择 PostHog

需要把三种材料串在一起：行为路径和耗时告诉我们哪里可能出问题；回放呈现前后操作与页面变化；“刚才不顺”补上用户自己的感受。单看报错漏掉不少体验问题，只看点击又很容易误读动机。

PostHog在一个产品里提供这些入口，适合作为Pocket的小范围试点。Sentry保留为技术故障排查方向，OpenReplay保留为自托管方向；rrweb只是录制与重放的基础库，现在自己搭完整平台会增加很多工作。这是针对当前目标的取舍，不是全领域排名。

### 接入顺序中值得复用的部分

1. **先确定要回答的问题。** 本次只跟踪打开会话、输入、提交、回执、实际可见与切回前台，避免一开始采一大堆没有决策用途的点击。
2. **把成功拆成不同事实。** 发起提交、原桌面接受、页面真正出现对应消息分别记录。accepted不等于模型完成，HTTP成功不等于用户已经看到。
3. **用稳定编号关联。** visit表示一次进入，request表示一次提交，feedback表示一次反馈。核对旧请求不增加新发送数；迟到回执仍属于原请求，不能覆盖取消状态。
4. **计时要知道人有没有切走。** 总历时与前台时间分别记录；前台时间也不等于专注等待。关闭、未知、失败和没采到不能合并成一个“放弃”。
5. **让主观标记足够轻。** 会话信息中的“刚才不顺”可直接标记，可选补原因。用户不必先整理一份完整bug报告。
6. **合成业务也要带上正式入口的约束，再独立回读后台。** 验证SDK不能触发额外聊天、不能影响草稿，也不能因分析服务不可达卡住Pocket；fixture必须继承正式CSP等影响行为的响应头。随后分别检查QA与正式入口的真实事件、录制和播放，不能只凭QA入库宣称生产采集可用。

### 这次真正踩到的坑

| 现象 | 证据与处理 | 下次提醒 |
| --- | --- | --- |
| 用户说已反馈，正式记录却没有入库 | 正式站`connect-src 'self'`阻止PostHog；原fixture漏带响应头。只放行两个所需域名，并把CSP纳入浏览器及发布功能检查 | 真正入口的安全/网络约束也是实现的一部分，不能只验证同一份JS |
| 自动化测试有操作，后台却没有事件 | 官方SDK会过滤`navigator.webdriver`；QA构建显式使用其测试过滤选项，且标记qa，随后真实入库 | 无事件不直接等于埋点没写对，先查SDK过滤条件 |
| 装了SDK，却还没有回放 | 项目端Session Replay尚未启用；录制器首次加载也可能晚于快速测试操作 | 分别检查客户端、项目开关和录制启动后的真实交互 |
| 初次录制器加载较慢 | 将固定版本SDK与录制器放进同站点懒加载chunk，减少额外外站JS加载 | 采集是旁路，不能为了可观测性拖慢核心操作 |
| 回放列表看起来是空的 | 默认`> 5 active seconds`隐藏了短验收录制，调到`> 0`后两段可见 | 先核对筛选与保留条件，不能把空列表当没入库 |
| 内嵌播放器报加载失败 | 同一录制从Share→Open in new browser tab打开后，实际画面与重新播放通过 | 保存与可播放要分开验收；独立入口可帮助定位查看端问题 |
| 排队消息取消后，统计又回到queued | 独立审查复现迟到回执覆盖；让统计终态与原队列store一致 | 观测代码同样需要领域状态约束 |
| 用户看到了问题卡，统计却说没看到内容 | 观察器起初只看普通消息；补上提问、过程与队列，并修正共同观察根 | 埋点应覆盖真实渲染分支，不能只覆盖理想UI |
| 官方源码里的CLI命令在已安装版本报错 | 0.18.12不支持master文档的`call --project-id`，改用每次调用环境变量并回读项目 | 主分支文档与已发布二进制分别核验，不把最新README当本机能力 |

### SDK、CLI、MCP、Skill 各负责什么

SDK放在产品里收集数据。CLI和MCP让Agent读取、分析或操作PostHog；当前官方CLI已能访问MCP工具目录，因此在有终端的环境通常选一个即可。Skill提供做事方法，既不授予账号权限，也不证明数据已经接通。

这次补装官方CLI，并保留无需专有运行时的Best Practices。没有把已经运行的Pocket再交给初始化Wizard改一遍；也没有因为名字带“analytics”就安装实际用于监测MCP服务器的Skill。公开采集token与本机查询凭据分开：前者能发事件，不能拿来查私人数据。

### 接通之后，还没有得到什么

最初1373项回归、34项浏览器检查、发布回读和真实回放验证，仅证明合成环境的路径工作；同日用户提交后查不到反馈，揭示正式CSP漏验。补上真实响应头后复现并修复，1378项回归、带CSP的34项浏览器检查和发布检查通过。这个反例比原先“测试通过”的数字更有价值。

这些验证仍没有证明用户最困扰的是哪个问题，也没有证明体验已经改善。下一步应当围绕真实反馈找到一个可复现问题，修复后用相同口径回看；旧反馈是否到达须按记录判断，不能用新增验收数据冒充。

格得从这次经历得到的判断是：工具提供证据入口；产品判断仍要把操作、页面结果和用户意图放在一起。这个判断可以迁移到下一款产品，具体事件与验收条件应重新按它的核心任务来定。

**回源入口**：[官方CLI](https://posthog.com/docs/cli)、[CLI源码和权限说明](https://github.com/PostHog/posthog/tree/master/cli)、[官方Skill打包来源](https://github.com/PostHog/context-mill)、[本项目当前状态](../../CURRENT.md)。札记保留本次历史，后续安装、授权和发布状态以上文对应事实源为准。
