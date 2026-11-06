# Pocket · 开发接续

Mac 上 Codex 的手机入口：按电脑查看和接续原会话，管理名称与归档。产品名为 **Pocket**；仓库、服务、数据目录和备份格式继续使用 `codex-navigator` / `CodexNavigator` 兼容标识。

## 开工顺序

1. 先遵循 `/Users/fangs/workspace/AGENTS.md`，再读 [CURRENT.md](CURRENT.md)：先区分已发布行为、仅已讨论的待续事项和验证缺口；确认最近已验证版本。自动运行状态以该页及实际 automation 为准。
2. 在本子仓库核对 `git status --short` 与当前分支，隔离其他任务的改动；运行命令和依赖从 [README.md](README.md)、`package.json`、`config/` 回读。
3. 按下面的任务分支加载文档与代码。只有追溯旧取舍/验证时才查 [HISTORY.md](HISTORY.md)，不用把整份流水当成当前需求。
4. 完成与本轮目标相称的实现和验证。已有功能优化、缺陷修复及对应发布沿用用户授权；纯文档维护只核对事实、链接与差异，不触发产品部署。

## 按任务进入

| 本轮任务 | 先读的契约与依据 |
| --- | --- |
| 多语言、系统语言、语言设置、英文文案与公共壳 | [多语言](docs/design/2026-11-04-internationalization.md)：i18next与本地偏好、保留来源状态/正文、不重挂表单、插值与重复键核验、公共加载/离线一致性；[英文精修](docs/design/2026-11-04-english-polish.md)：英文状态栏、上下文短标签、中文对照；[标题栏排序](docs/design/2026-11-04-compact-sort-menu.md)：三项单选、筛选恢复单行、显式幂等与桌面详情保留 |
| 左滑隐藏、隐藏分类、取消隐藏、隐藏缓存/修订 | [会话隐藏](docs/design/2026-11-03-hidden-conversations.md)：Pocket独立偏好、普通分类排除/隐藏集合找回、hiddenRevision与scope保护，保留原会话/草稿/运行 |
| 阶段性CR、历史窗口重构、提交正文回收、可重复浏览器验收 | [10-31阶段审查](docs/design/2026-10-31-stage-refactor.md)：结构/Spec分轴、历史协调职责、终态正文与防重身份分离；后端取消链路等候选有独立重开条件 |
| 会话信息打开时高度跳动、定时任务/模型摘要重复读取 | [稳定布局与信息缓存](docs/design/2026-10-31-info-dialog-cache.md)：加载/空态同一行、30秒页面内缓存、过期保留显示后台读取；模型权限/回执不缓存，修改仍实时核对 |
| 设置/会话信息紧凑布局、顶部创建/活动/加号默认透明 | [控件与信息减法](docs/design/2026-10-30-compact-settings-and-controls.md)：统一节奏、元数据两列、局部Modal标题margin、44px点击区和选中反馈保持 |
| 新建/详情关闭后标题及加号上半部分模糊、菜单开关可恢复 | [iOS滚动边缘](docs/design/2026-10-30-ios-header-scroll-edge.md)：原生scroll edge effect与CSS blur不同；保持手机实色sticky顶边，原生A/B与新建/详情两路径已验证，不能只凭桌面filter:none判定修复 |
| 客户端版本、请求诊断头、反馈原版本与设置版本显示 | [客户端版本](docs/design/2026-10-30-client-version.md)：构建哈希单一来源、请求头有界透传、旧反馈保持捕获时版本；不是连接/认证门槛 |
| 列表/详情标题扫光、请求状态、并发与结束清理 | [标题请求状态](docs/design/2026-10-29-request-title.md)：被动观察业务API、按机器/线程归属、120/180ms视觉缓冲，空闲不代表已同步成功；媒体/模型运行各用原状态 |
| 会话视频、原生播放/全屏、Range与大文件流 | [会话视频](docs/design/2026-10-29-message-video.md)：复用已登记文件能力、视频专用512MiB流、强校验与取消、同源媒体；普通文件/图片边界保持，编码可播放性另验 |
| 共用弹窗/嵌套Escape、点击命中区、问题键盘归属、媒体切换首点与控件一致性 | [10-29全路径精修](docs/design/2026-10-29-impeccable-sweep.md)：固定header/单一body、顶层关闭归属、真实点击范围、外部键盘归属及焦点交接保护；与原消息/回执策略分离 |
| 截图圈注反馈、摇一摇、反馈草稿与自动投递到开发会话 | [反馈基础设施](docs/design/2026-10-29-feedback-infrastructure.md)、[通用模块](packages/feedback-kit/AGENTS.md)：通用模块不依赖Pocket，认证记录/签名回调/固定目标/幂等回执分层；新反馈与旧标记查询分开，发布启用状态回CURRENT |
| 认证迟到响应、历史缓存上限、首批同文Query或图片引用CR | [代码质量修复](docs/design/2026-10-28-code-quality.md)：认证代次与缓存epoch独立、双路首读基线、统一缓存写入、完整Markdown权限解析；提交正文回收仍是候选 |
| 查反馈、PostHog、采集无数据或体验复盘 | 先读私有台账 `.local/feedback-ledger.json` 按反馈ID对照，再按[反馈接续](docs/design/2026-10-26-usage-feedback.md#查反馈与复盘的接续流程)查询和补记，区分已发布与效果确认；[专项验收](docs/QUALITY.md#使用反馈验收)覆盖正式CSP与入库回读。工具版本/认证与事件口径留在使用反馈文档，上线状态回CURRENT |
| 图标、尺寸/线宽/对齐、触控目标 | [图标规范](docs/design/2026-11-04-icon-system.md)：AppIcon辅助16/操作18/导航20、显式标记/插图例外，普通线宽1.75，Radix/品牌隔离与44px点击区 |
| 未读/运行/关注/排序同排、搜索位置、中英手机一行 | [筛选排序同排](docs/design/2026-11-05-filter-sort-row.md)：排序在关注右侧、搜索移标题栏，同排CircleDot/CirclePlay/Star＋模式glyph均16/1.75；英文手机Follow短label、320safearea局部宽度＋12px，文字/图标/128-32计数全保留、无wrap/scroll；该位置替代旧标题栏排序契约 |
| 消息末尾运行中三点、缓存/accepted/等待状态误亮、后台/BFCache迟到响应 | [运行三点](docs/design/2026-11-04-conversation-working-dots.md)：新鲜原owner/inProgress、精确turn终态/stop/等待hint、独立activityEpoch按请求起点绑定，保留read基线/选区/焦点/上翻及reduce |
| XML反复裸露/空白、包装后续文、details/音频图片错误 | [统一结构化展示](docs/design/2026-11-05-structured-message-presentation.md)：纯known-envelope registry/strict schema/代码和citation保护、共享第一引用定义、安全details/未知XML惰性、普通rawHTML旧隐藏，原role/id/raw不变；音频只文件fallback，不能从Markdown扩文件授权 |
| 点正文后整个消息区域蓝框、程序焦点与键盘提示区分 | `src/messageRegionFocus.ts`与`src/message-region-focus.css`：仅region按Tab/键盘滚动vs pointer/touch/programmatic意图区分，不blur/阻止事件，child自己的keyboard提示/节点/选区保持；WebKit手机ArrowUp不动的基线与PageUp验证见`.local/qa/message-region-focus-2026-11-05/` |
| REA、Git凭据扫描、开源隐私与可利用入口 | [安全扫描](docs/research/2026-11-05-rea-security-scan.md)：本机REA6.4静态partial、Gitleaks16误报人工核销、生产依赖0/dev2high、图片父目录竞态/反代IP头两项条件Low；固定候选2d2fa4a，未修安全代码/未升级，不能把扫描当公开认证 |
| Bridge借鉴、prepared输入回执、64MiB原生帧、原连接重建/手机入口诊断 | [Bridge输入研究](docs/research/2026-11-05-codex-mobile-bridge-inputs.md)：固定源码/两个隔离条件复现；params展示不能直接核销、分发IPC帧边界，产品未修/真实影响未查；上游同样未解App owner归档，持续订阅/配对按实际目标验证。[源码参考与需求信号](docs/research/2026-11-05-codex-mobile-bridge-age-and-demand.md)：Study完整clone固定main，公开约五周，178stars/下载与外部反馈口径分开 |
| 整体视觉、Radix Themes、基础控件/色阶/样式归属 | [整体视觉重整](docs/design/2026-10-19-visual-system.md)：整屏对照、tokens/结构/视觉分工、native行为保护；[独立验收跟进](docs/design/2026-10-19-independent-ui-followup.md)：variant几何、错误恢复按钮组合 |
| Impeccable精修、首次必填披露、空白错误恢复与首字丢失 | [10-28设计审查](docs/design/2026-10-28-impeccable-polish.md)：两路独立评审、局部几何与提示对比、原生input后置预连接；已记忆选择和阅读空间保持 |
| 整体精修、重命名错误重复、英文关闭确认贴紧、窄屏输入动作越界 | [11-05整体精修](docs/design/2026-11-05-impeccable-refinement.md)：翻译后去重/有效ARIA、共享8px换行动作组、小屏子控件边界与命中；预览关闭44px/排序菜单同glyph，原请求/输入/阅读保持 |
| 首开空白／无加载状态、标题反馈复核 | [加载与标题反馈](docs/design/2026-10-28-feedback-loading.md)：双路首读与缓存分开、沿前后visit定位、原生标题摘要与Pocket回读分开判断 |
| Mermaid围栏、图表阅读/源码、Worker与Pele升级 | [会话图表](docs/design/2026-10-19-mermaid.md)：三类图、闭合判断、惰性渲染/内存回收、独立图表放大、资源与不可信内容边界；固定包来源回vendor/pele |
| 详情工具栏/输入区、菜单数量、独立范围/状态/排序、未读用词 | [输入区与独立筛选](docs/design/2026-10-19-composer-and-navigation.md)：控件常驻/队列编辑/未知回执、v4维度与计数口径、未读不等于等待操作 |
| 会话型号、思考强度显示与修改 | [模型设置](docs/design/2026-10-18-model-settings.md)：有效设置优先级、同型号下一轮强度、原生条件更新/回读、未知回执与跨型号兼容边界 |
| 多机连接、设置内电脑切换、远端部署、跨机链接/资源/通知 | [多机连接](docs/design/2026-10-17-multi-machine.md)：电脑身份只在设置显示，原owner、独立路由/Cookie/草稿保护、机器私有配置；真实安装状态回CURRENT |
| 详情返回残留竖线、关闭按钮默认蓝圈、菜单/弹窗/预览焦点 | [焦点意图](docs/design/2026-10-15-inspector-entry-focus.md)：触摸和键盘归还分开；表单显式输入优先、阅读弹窗中性标题，保留真实键盘轮廓 |
| 会话图片放大、缩放、关闭与阅读恢复 | [会话内大图](docs/design/2026-10-15-image-viewer.md)：共享host、固定关闭、原图与权限边界 |
| 离线整页视觉、对齐、主题和公开壳更新 | [离线布局收敛](docs/design/2026-10-15-offline-layout.md)：独立公开页面、中轴与安全区、深链保留 |
| 列表触摸稳定、草稿退出、新建/离线恢复、搜索扩围与归档主动作 | [交互稳定与原地恢复](docs/design/2026-10-15-interaction-recovery.md)：完整路径修复与原回执边界 |
| 优先关注与Codex置顶、输入意图预连接、精简文案、消息相对时间 | [独立优先与输入意图](docs/design/2026-10-15-priority-and-composer.md)：双标记/加分、旧接口兼容、单主按钮和共享时钟 |
| 停留5秒提前连接、可见计时、被动连接与队列边界 | [停留连接](docs/design/2026-10-28-dwell-connection.md)：输入机会独立、read-first、服务端阻塞复核、skipped终态与同请求升级；可能打开Mac会话，不是纯网络握手 |
| 动效、详情转场、键盘打开时右滑返回、右滑与横滚冲突 | [五项动效实现](docs/design/2026-10-15-motion-implementation.md)：编辑焦点与导航意图分离、IME/选区保护、跟手与内容衔接；[原始评审](docs/design/2026-10-14-motion-study.md)保留取舍来源 |
| 项目导航、最近创建、关注/Codex置顶快捷分类、统一Rank、最后消息时间与状态色 | [项目与智能排序](docs/design/2026-10-14-smart-navigation.md)：独立范围、创建时间倒序、单分数公式、消息来源、行为加分、有效状态与滚动锚 |
| Query在消息与待发区搬移/重影、发送后键盘或阅读跳动 | [发送连续性](docs/design/2026-10-25-send-ui-continuity.md)：同请求稳定消息行、行内状态/队列操作、精确身份与全文保护；焦点、IME和用户滚动优先 |
| 新建回列表、行内进度、弱网恢复、确认延迟 | [列表确认](docs/design/2026-10-09-creation-and-send-feedback.md#2026-10-28提交后回列表行内确认)：立即返回、蓝转绿、失败输入恢复与后台核对；[确认延迟](docs/design/2026-10-25-create-confirmation-latency.md)保留原生耗时及同ID单飞依据 |
| 新建首Query卡在待发、自动标题滞后 | [首条消息与标题同步](docs/design/2026-10-26-create-delivery-and-title.md)：连接就绪唤醒本会话队列、停止代次保护、近期详情有界目录快刷；连接耗时与轮询延迟分开验证 |
| 新建剪贴板预填、Paste许可、读取失败恢复 | [Query与剪贴板](docs/design/2026-10-09-startup-and-query-entry.md)：默认点击内读取、保留系统许可、主动恢复与迟到结果保护；浏览器替身不能证明iPhone许可链路 |
| 手机阅读态输入区收放、滑动正文收键盘、列表状态位置 | [阅读与列表收敛](docs/design/2026-10-13-reading-composer-and-row-state.md)：主动纵向触摸与自动scroll分离、同一输入节点、焦点/IME/阅读位置保护 |
| 压缩提示重复、等待状态撑高输入区、状态完成时弹层与焦点 | [状态与阅读空间](docs/design/2026-10-26-status-reading-space.md)：精确说明去重、紧凑压缩控件、accepted与unknown区分、可见锚点及焦点归还 |
| 全局toast、消息身份标签、底部时间/复制与发送确认 | [轻量反馈与消息footer](docs/design/2026-10-12-light-feedback-and-message-footer.md)：统一Sonner样式、消息语义与待处理状态边界 |
| 操作类产品的顺手标准、功能取舍、UI 复盘或跨项目借鉴 | [迭代复盘](docs/research/2026-10-11-pocket-interaction-retrospective.md)：整体脉络、可观察标准、反例与验证办法；按目标项目重新判断适用性 |
| Logo、设置减法、标题信息入口与工具栏 | [品牌与界面收敛](docs/design/2026-10-11-brand-and-interface.md)、[矢量主稿](design/brand/README.md) |
| 整体 UI、导航、筛选、阅读层级与表单 | [工作区交互打磨](docs/design/2026-10-08-notion-inspired-workspace.md)；整体减法或同类删减再次出现时，先按[迭代复盘](docs/research/2026-10-11-pocket-interaction-retrospective.md)第4、6节审视完整路径的相邻区域，确定覆盖范围与保留理由 |
| 列表运行中/等待状态、状态过期 | [列表运行状态](docs/design/2026-10-08-running-status.md)：原owner候选读取、共享轮询与归档取消边界 |
| 未读/近期会话后台状态与正文预取、缓存接管和抢占冷却 | [正文预取](docs/design/2026-10-31-transcript-prefetch.md)：统一rank＋未读加权、固定8候选/单并发、前台接管、版本/身份边界；[状态预取](docs/design/2026-10-22-active-thread-prefetch.md)继续32项批量提示与公平轮转，不制造访问/已读或后台连接 |
| 列表、来源导入、元数据恢复、阅读缓存 | [数据与接口](docs/ARCHITECTURE.md)、[桌面列表范围](docs/design/2026-10-14-desktop-list-scope.md)、[待输入视图](docs/design/2026-09-29-input-inbox.md) |
| IndexedDB、缓存数量设置、恢复/清理、跨标签失效、304/204与读取流量 | [分层阅读缓存](docs/design/2026-10-28-reading-cache.md)：客户端条数偏好、认证后展示、纯阅读投影、来源/epoch与容量边界、条件响应及旧接口兼容；[选型](docs/research/2026-10-28-cache-components.md) |
| 阅读后清除未读、跨端重复未读、运行中排除未读、内容版本与缓存 | [阅读状态与已读合并](docs/design/2026-10-22-pocket-read-state.md)：有效运行状态仅抑制列表未读；本地水位、真实可见阅读与精确版本桌面提示保持，原生写回仅旧客户端兼容 |
| 顶部下拉加载更早消息、历史分页、压缩jsonl.zst与翻页位置 | [历史分页](docs/design/2026-10-28-history-pagination.md)：真实滚动意图一手势一批、程序scroll不连载、键盘/阅读保护；只读worker、签名游标和三页视窗保持，旧页不授控制或阅读凭据 |
| 派生会话只有回复而缺少首条Query | [委派请求投影](docs/design/2026-10-28-delegated-query.md)：仅精确create_thread委派格式、稳定ID/轮次、原生共有锚点与只读来源标记；普通工具输出不转成用户消息 |
| 用户引用批注、列表刷新反馈、顶部筛选/排序选中态 | [本轮契约](docs/design/2026-10-23-annotations-refresh-controls.md)：问题优先、引用披露、请求反馈互斥与轻量选中表面 |
| 新提问选项、回答/忽略与重复显示 | [可选提问](docs/design/2026-10-10-optional-question-prompts.md)：新题选项直接展示、精确投影去重、草稿与未知回答保护 |
| 最终回复后的过程折叠、展开状态与选区保护 | [过程折叠](docs/design/2026-10-11-completed-progress.md)：明确轮次、当前问题、缓存和布局后标读 |
| subagent_notification的XML/JSON裸露、子任务结果与复制 | [子任务通知](docs/design/2026-10-28-subagent-notifications.md)：完整已知格式、紧凑披露与安全Markdown；原role/ID保持，包装不授予文件或执行权限 |
| 历史、发送、排队、停止、压缩、提问或审批 | [会话契约](docs/CONVERSATION.md)；正文与执行状态分离读[文字优先](docs/design/2026-09-30-transcript-first.md)，慢发送/未知回执读[发送修复](docs/design/2026-09-30-send-reliability.md) |
| 手机上传、附件草稿、图片/文件发送及队列恢复 | [附件发送](docs/design/2026-10-10-attachments.md)：私有落盘、原owner输入、上传/发送编号及文件保留边界 |
| 手机键盘、返回、草稿、刷新恢复 | [验证与改进](docs/QUALITY.md)、[连续性修复](docs/design/2026-09-30-steady-interaction.md) |
| Markdown、定时消息正文空白/XML代码框、Codex专用标记、本地图片 | [消息标记](docs/design/2026-09-30-codex-markup-and-current-questions.md)：heartbeat/子任务的纯引用尾段单独消解，内部代码与完整shape保护；原文从Pocket只读接口核对，Codex展示投影可能省略引用。图片边界见[图片契约](docs/IMAGES.md) |
| Markdown/TXT等文件页内预览、下载与预览字节复用 | [消息文件](docs/design/2026-10-22-message-components.md)：受控文件权限、1MiB文本预览、关闭恢复、按当前预览下载；文件内容不继承会话组件权限 |
| HTML页面、文档嵌图与源码切换 | [HTML预览](docs/design/2026-11-07-html-file-preview.md)：认证原cap、子目录栅格图/FD及预算、parse5与opaque iframe、静态控件/片内锚点、原件下载与rrweb屏蔽；不放宽父CSP或执行脚本 |
| Pocket 前端更新或丢输入风险 | [安全更新](docs/design/2026-09-30-safe-app-update.md) |
| Codex 升级后连接失败、协议不兼容或内置 CLI 变化 | [桌面兼容](docs/design/2026-10-13-desktop-compatibility.md)：App/CLI未验证版本仅作诊断告警，不作准入门槛；真实探针/RPC/归属/结果继续检查 |
| 通知与用户确认 | [通知](docs/NOTIFICATIONS.md)、会话契约中的审批/阻塞问题章节 |
| 新建、归档、恢复与等待取消 | [会话生命周期](docs/design/2026-10-05-thread-lifecycle.md)：官方空会话持久化、writer 等待与回执恢复；[归档owner路线](docs/research/2026-10-16-archive-owner-route.md)：启动适配器候选、原型与真实GUI验证边界 |
| 改名、会话信息入口、旧分组/安排兼容 | [重命名与管理减法](docs/design/2026-10-11-rename-and-management.md)：官方 name/set、回执、并发与数据保留；当前入口见[品牌与界面收敛](docs/design/2026-10-11-brand-and-interface.md) |
| 共享桌面队列等能力补齐 | [能力对照](docs/DESKTOP-PARITY.md)、[原实例控制入口](docs/research/2026-09-29-desktop-control-entrypoints.md)；先核对当前 App 与 `config/desktop-bridge.json` |
| 豌豆CLI0.164升级、空输入被附件读取错误撑高 | [升级与附件恢复](docs/design/2026-10-25-wandou-update-and-attachment-recovery.md)：真实CLI验证、数据/scope保留、软读取错误与附件保护 |
| 发送体感慢、豌豆后端更新机制或10-25桌面升级差异 | [更新与发送复核](docs/research/2026-10-25-updates-and-send-experience.md)：实际发布路径、CLI待验证、已复现等待点；调查不等于已修复 |
| 本机运行、连接器或公网发布 | [个人部署兼容](docs/design/2026-11-04-selfhost-personal-deployment.md)：不可变API/稳定FBT source、ged/wandou profile、原登录/交付保留与分层验收；[手机链路](docs/MOBILE.md)，具体运行/个人Pages配置从CURRENT进入 |
| 原生 App、竞品或开源方向 | [对外价值与差异化复核](docs/research/2026-11-05-pocket-value-and-differentiation.md)：HAPI已支持Codex旧会话导入/同步，官方Remote与Bridge是直接对照；原桌面运行归属/列表组织/手机体验为待实机验证的差异，不宣称完全同步或独家。[README](README.md)含可复制Agent搭建指令/前置条件/架构；[脱敏历史副本](docs/research/2026-11-04-sanitized-history-copy.md)与[公共历史说明](docs/PUBLIC_HISTORY.md)：原历史保持、全量隔离filter/匿名meta/空提交/净bundle与最新源码bootstrap，最终身份回CURRENT；[隐私边界复核](docs/research/2026-11-04-open-source-privacy-boundary.md)承载误入域名、原Git不宜公开与数据/索引/导出边界；[自部署准备](docs/research/2026-11-04-self-hosted-open-source-readiness.md)、[安装指南](docs/SELF_HOSTING.md)承载桥接/配置/新Mac发布门槛。公开只使用经复核的新导出或脱敏副本，不能公开维护仓库或旧613文件候选 |

## 代码入口

| 范围 | 主要文件 |
| --- | --- |
| 来源/元数据/列表 | `server/source.mjs`、`server/source-scope.mjs`、`server/unread.mjs`、`server/store.mjs`、`src/App.tsx`、`src/catalogReader.ts` |
| 阅读状态 | `server/pocket-content.mjs`、`src/pocketReadState.ts`、`src/readObservation.ts`；原生兼容保留在 `server/read-state.mjs`、`bin/read-state.py` |
| 重命名 | `server/rename.mjs`、`bin/rename-thread.py`、`src/RenameThreadDialog.tsx`、`src/threadMetadata.ts` |
| 型号展示/思考强度 | `server/thread-models.mjs`、`bin/model_settings.py`、`src/ThreadModelSettings.tsx`、`src/threadModels.ts` |
| 新建/归档/恢复 | `server/lifecycle.mjs`、`bin/create-thread.py`、`bin/archive-thread.py`、`src/useTaskOperations.ts` |
| 原桌面控制与账本 | `server/desktop.mjs`、`server/bridge-process.mjs`、`bin/desktop-bridge.py`、`bin/request_actions.py` |
| 历史读取与展示合并 | `server/history.mjs`、`src/conversationFeed.ts`、`src/transcript.ts` |
| 会话交互与回执 | `src/Conversation.tsx`、`src/Outbox.tsx`、`src/QuestionPrompts.tsx`、`src/RequestActions.tsx`、`src/submissionReceipt.ts` |
| Markdown/图片 | `src/MessageMarkdown.tsx`、`src/ImageViewer.tsx`、`src/ImagePreviewProvider.tsx`、`src/codexMarkup.ts`、`server/message-images.mjs` |
| 入站附件 | `server/attachments.mjs`、`src/attachments.ts`、`src/AttachmentList.tsx`；发送衔接仍在 `server/desktop.mjs` 和 `bin/desktop-bridge.py` |
| 更新与输入保护 | `src/PocketUpdate.tsx`、`src/appUpdate.ts`、`src/updateSafety.ts`、`src/updateDrafts.ts`、`bin/build-version.mjs` |
| HTTP/公网转发 | `server/index.mjs`、`edge/worker.mjs`、`bin/tunnel.mjs` |

## 保持的项目约定

- **原任务权威**：不直接修改 Codex SQLite、global JSON 与 rollout。既有任务执行以原 thread ID 定位原桌面 owner，继承模型、cwd 与权限。新建、重命名、归档和恢复复用已验证的官方短生命周期 CLI，并核验 writer 与持久结果；不另起执行器接管正在使用的原任务，不绕过签名校验。
- **展示与执行分离**：按 provenance 显示真实用户消息和可见回复，排除注入上下文/内部压缩摘要。transcript、缓存和文字合并只能用于展示，不能授予执行权限或核销发送回执。问题卡只属于最新原轮次；该轮已完成但仍有问题时可保留，旧轮题目留在历史。
- **派发与恢复**：保留 `requestId`、指纹、revision 和原 turn 约束；`accepted` 不等于模型完成。未知发送/中断/审批结果先核对，不自动重放。`canQueue`、`canSend`、`canAttemptSend` 含义独立，读侧失败不应误禁安全入队。
- **输入与队列**：Pocket 待发队列与桌面队列仍独立；用户暂停或编辑的条目保持暂停。迟到响应不覆盖新草稿、已保存说明或较新列表；更新只由明确点击触发，检查期间产生的新输入也需保护。
- **私人数据**：Pocket 元数据与已提交待发正文留在本机私有数据目录；浏览器按[分层阅读缓存](docs/design/2026-10-28-reading-cache.md)保存按机器/来源隔离的纯阅读投影和水位，草稿、回执与权限不借此持久化或更新，分页旧历史仅留当前详情内存。口令、真实数据、截图、回执和备份放 `.local/` 或本机私有目录，不进入 Git、公开构建或第三方模型。Service Worker 只缓存公开壳。
- **网络与渲染**：本机服务监听 loopback，私人 API 保持认证、Host/Origin/CSRF 校验。消息标记仅作展示/受控导航，不执行指令或 raw HTML；图片只开放正文已引用、任务目录内且通过现有校验的文件。
- **能力取舍**：用户已要求通知、更多审批、共享待发队列及原任务新建/改名/归档；已交付与真实接口阻塞看 CURRENT。改名/归档须同步 Codex 原任务，不用 Pocket 别名或隐藏替代。外部调研候选仍先讨论，再实施选定事项。

## 验证、运行与收尾

- 功能改动先跑相关回归；发布前运行 `npm test` 和 `npm run build`，再验证受影响的实际流程。涉及阅读、发送、导航或输入交互时，优先用 `npm run test:browser` 的合成端到端入口；参数与范围见 [tests/browser](tests/browser/README.md)。文档改动检查路径、事实、历史保全和 diff 即可。验证策略及受控真实发送对象只在 [QUALITY](docs/QUALITY.md) 维护。
- 默认使用合成数据和只读真实验收；必要发送按受控对象/文本约定操作，避免污染其他原任务。区分自动测试、浏览器、模拟器、iPhone 主屏幕真机与长期使用证据。
- 桥接测试与生产调用一样通过 `readBridgeConfig()` 读取解释器/IPC路径，保留 `NAVIGATOR_BRIDGE_CONFIG` 的机器覆盖；不能硬读可提交默认配置。10-28豌豆预检已复现默认Python路径不存在、其私有配置可用的差异。
- 本地开发优先复用已有 API 或任务内临时 fixture；结束后关闭自己启动的临时进程。已登记服务的生命周期复用 FBT local，实际配置留在本仓库，不顺手重启 Codex。
- 发布从项目配置进入 [FBT Pages Site](/Users/fangs/workspace/fbt/workflows/pages-site/SKILL.md)；本地服务管理从 [FBT local](/Users/fangs/workspace/fbt/local/SKILL.md) 进入。上传已成功但回读未通过时，继续同一部署的 `resume --resume-verification`，先核对结果再决定下一步。
- `CURRENT.md` 只保留最近已验证版本、当前行为、继续方式和未决事项；被后续版本替代的详细流水移入 `HISTORY.md` 或对应设计记录，保留原日期与证据。检查并本地提交本任务改动，沿用 Workspace 的 Git 规则；本地 commit 不代表 push、发布或真实效果完成。
