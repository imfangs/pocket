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
| 查反馈、PostHog、采集无数据或体验复盘 | [反馈接续](docs/design/2026-10-26-usage-feedback.md#查反馈与复盘的接续流程)：目标/schema核对、查询模板、反馈/回放关联和判断边界；[专项验收](docs/QUALITY.md#使用反馈验收)覆盖正式CSP与入库回读。工具版本/认证与事件口径留在使用反馈文档，上线状态回CURRENT |
| 整体视觉、Radix Themes、基础控件/色阶/样式归属 | [整体视觉重整](docs/design/2026-10-19-visual-system.md)：整屏对照、tokens/结构/视觉分工、native行为保护；[独立验收跟进](docs/design/2026-10-19-independent-ui-followup.md)：variant几何、错误恢复按钮组合 |
| Mermaid围栏、图表阅读/源码、Worker与Pele升级 | [会话图表](docs/design/2026-10-19-mermaid.md)：三类图、闭合判断、惰性渲染/内存回收、独立图表放大、资源与不可信内容边界；固定包来源回vendor/pele |
| 详情工具栏/输入区、菜单数量、独立范围/状态/排序、未读用词 | [输入区与独立筛选](docs/design/2026-10-19-composer-and-navigation.md)：控件常驻/队列编辑/未知回执、v4维度与计数口径、未读不等于等待操作 |
| 会话型号、思考强度显示与修改 | [模型设置](docs/design/2026-10-18-model-settings.md)：有效设置优先级、同型号下一轮强度、原生条件更新/回读、未知回执与跨型号兼容边界 |
| 多机连接、设置内电脑切换、远端部署、跨机链接/资源/通知 | [多机连接](docs/design/2026-10-17-multi-machine.md)：电脑身份只在设置显示，原owner、独立路由/Cookie/草稿保护、机器私有配置；真实安装状态回CURRENT |
| 进入详情后返回按钮蓝圈、指针/键盘/通知焦点 | [入口焦点](docs/design/2026-10-15-inspector-entry-focus.md)：保留键盘轮廓，普通触摸落在中性容器 |
| 会话图片放大、缩放、关闭与阅读恢复 | [会话内大图](docs/design/2026-10-15-image-viewer.md)：共享host、固定关闭、原图与权限边界 |
| 离线整页视觉、对齐、主题和公开壳更新 | [离线布局收敛](docs/design/2026-10-15-offline-layout.md)：独立公开页面、中轴与安全区、深链保留 |
| 列表触摸稳定、草稿退出、新建/离线恢复、搜索扩围与归档主动作 | [交互稳定与原地恢复](docs/design/2026-10-15-interaction-recovery.md)：完整路径修复与原回执边界 |
| 优先关注与Codex置顶、输入意图预连接、精简文案、消息相对时间 | [独立优先与输入意图](docs/design/2026-10-15-priority-and-composer.md)：双标记/加分、旧接口兼容、单主按钮和共享时钟 |
| 动效、详情转场、右滑与横滚冲突、内容过渡 | [五项动效实现](docs/design/2026-10-15-motion-implementation.md)：跟手、披露、创建/消息衔接、主动pin换位和轻反馈；[原始评审](docs/design/2026-10-14-motion-study.md)保留取舍来源 |
| 项目导航、最近创建、关注/Codex置顶快捷分类、统一Rank、最后消息时间与状态色 | [项目与智能排序](docs/design/2026-10-14-smart-navigation.md)：独立范围、创建时间倒序、单分数公式、消息来源、行为加分、有效状态与滚动锚 |
| Query在消息与待发区搬移/重影、发送后键盘或阅读跳动 | [发送连续性](docs/design/2026-10-25-send-ui-continuity.md)：同请求稳定消息行、行内状态/队列操作、精确身份与全文保护；焦点、IME和用户滚动优先 |
| 新建后迟迟没有完成反馈、创建状态被旧操作拖慢 | [新建确认延迟](docs/design/2026-10-25-create-confirmation-latency.md)：原生耗时与前端确认分开，创建独立核对、同ID单飞与未知不重放 |
| 新建首Query卡在待发、自动标题滞后 | [首条消息与标题同步](docs/design/2026-10-26-create-delivery-and-title.md)：连接就绪唤醒本会话队列、停止代次保护、近期详情有界目录快刷；连接耗时与轮询延迟分开验证 |
| 新建剪贴板预填、Paste许可、读取失败恢复 | [Query与剪贴板](docs/design/2026-10-09-startup-and-query-entry.md)：默认点击内读取、保留系统许可、主动恢复与迟到结果保护；浏览器替身不能证明iPhone许可链路 |
| 手机阅读态输入区收放、列表时间/状态位置 | [阅读与列表收敛](docs/design/2026-10-13-reading-composer-and-row-state.md)：同一输入节点、焦点/IME/附件/待处理保护与固定状态槽 |
| 压缩提示重复、等待状态撑高输入区、状态完成时弹层与焦点 | [状态与阅读空间](docs/design/2026-10-26-status-reading-space.md)：精确说明去重、紧凑压缩控件、accepted与unknown区分、可见锚点及焦点归还 |
| 全局toast、消息身份标签、底部时间/复制与发送确认 | [轻量反馈与消息footer](docs/design/2026-10-12-light-feedback-and-message-footer.md)：统一Sonner样式、消息语义与待处理状态边界 |
| 操作类产品的顺手标准、功能取舍、UI 复盘或跨项目借鉴 | [迭代复盘](docs/research/2026-10-11-pocket-interaction-retrospective.md)：整体脉络、可观察标准、反例与验证办法；按目标项目重新判断适用性 |
| Logo、设置减法、标题信息入口与工具栏 | [品牌与界面收敛](docs/design/2026-10-11-brand-and-interface.md)、[矢量主稿](design/brand/README.md) |
| 整体 UI、导航、筛选、阅读层级与表单 | [工作区交互打磨](docs/design/2026-10-08-notion-inspired-workspace.md)；整体减法或同类删减再次出现时，先按[迭代复盘](docs/research/2026-10-11-pocket-interaction-retrospective.md)第4、6节审视完整路径的相邻区域，确定覆盖范围与保留理由 |
| 列表运行中/等待状态、状态过期 | [列表运行状态](docs/design/2026-10-08-running-status.md)：原owner候选读取、共享轮询与归档取消边界 |
| 最近访问/运行/新建会话的后台状态跟踪 | [近期活跃预取](docs/design/2026-10-22-active-thread-prefetch.md)：有界内存集合、批量优先提示、公平轮转；不读取正文或制造访问/已读 |
| 列表、来源导入、元数据恢复 | [数据与接口](docs/ARCHITECTURE.md)、[桌面列表范围](docs/design/2026-10-14-desktop-list-scope.md)、[待输入视图](docs/design/2026-09-29-input-inbox.md) |
| 阅读后清除未读、跨端重复未读、运行中排除未读、内容版本与缓存 | [阅读状态与已读合并](docs/design/2026-10-22-pocket-read-state.md)：有效运行状态仅抑制列表未读；本地水位、真实可见阅读与精确版本桌面提示保持，原生写回仅旧客户端兼容 |
| 用户引用批注、列表刷新反馈、顶部筛选/排序选中态 | [本轮契约](docs/design/2026-10-23-annotations-refresh-controls.md)：问题优先、引用披露、请求反馈互斥与轻量选中表面 |
| 新提问选项、回答/忽略与重复显示 | [可选提问](docs/design/2026-10-10-optional-question-prompts.md)：新题选项直接展示、精确投影去重、草稿与未知回答保护 |
| 最终回复后的过程折叠、展开状态与选区保护 | [过程折叠](docs/design/2026-10-11-completed-progress.md)：明确轮次、当前问题、缓存和布局后标读 |
| 历史、发送、排队、停止、压缩、提问或审批 | [会话契约](docs/CONVERSATION.md)；正文与执行状态分离读[文字优先](docs/design/2026-09-30-transcript-first.md)，慢发送/未知回执读[发送修复](docs/design/2026-09-30-send-reliability.md) |
| 手机上传、附件草稿、图片/文件发送及队列恢复 | [附件发送](docs/design/2026-10-10-attachments.md)：私有落盘、原owner输入、上传/发送编号及文件保留边界 |
| 手机键盘、返回、草稿、刷新恢复 | [验证与改进](docs/QUALITY.md)、[连续性修复](docs/design/2026-09-30-steady-interaction.md) |
| Markdown、定时消息正文空白、Codex专用标记、本地图片 | [消息标记](docs/design/2026-09-30-codex-markup-and-current-questions.md)：heartbeat触发与结果安全投影、代码示例保护；图片边界见[图片契约](docs/IMAGES.md) |
| Pocket 前端更新或丢输入风险 | [安全更新](docs/design/2026-09-30-safe-app-update.md) |
| Codex 升级后连接失败、协议不兼容或内置 CLI 变化 | [桌面兼容](docs/design/2026-10-13-desktop-compatibility.md)：App 发布号仅作诊断，IPC 契约与 CLI 语义分别检查 |
| 通知与用户确认 | [通知](docs/NOTIFICATIONS.md)、会话契约中的审批/阻塞问题章节 |
| 新建、归档、恢复与等待取消 | [会话生命周期](docs/design/2026-10-05-thread-lifecycle.md)：官方空会话持久化、writer 等待与回执恢复；[归档owner路线](docs/research/2026-10-16-archive-owner-route.md)：启动适配器候选、原型与真实GUI验证边界 |
| 改名、会话信息入口、旧分组/安排兼容 | [重命名与管理减法](docs/design/2026-10-11-rename-and-management.md)：官方 name/set、回执、并发与数据保留；当前入口见[品牌与界面收敛](docs/design/2026-10-11-brand-and-interface.md) |
| 共享桌面队列等能力补齐 | [能力对照](docs/DESKTOP-PARITY.md)、[原实例控制入口](docs/research/2026-09-29-desktop-control-entrypoints.md)；先核对当前 App 与 `config/desktop-bridge.json` |
| 豌豆CLI0.164升级、空输入被附件读取错误撑高 | [升级与附件恢复](docs/design/2026-10-25-wandou-update-and-attachment-recovery.md)：真实CLI验证、数据/scope保留、软读取错误与附件保护 |
| 发送体感慢、豌豆后端更新机制或10-25桌面升级差异 | [更新与发送复核](docs/research/2026-10-25-updates-and-send-experience.md)：实际发布路径、CLI待验证、已复现等待点；调查不等于已修复 |
| 本机运行、连接器或公网发布 | [手机链路](docs/MOBILE.md)；对应 `config/local-service.json`、`config/tunnel-service.json`、`config/pages-site.json` |
| 原生 App、竞品或开源方向 | [调研输入](docs/research/2026-09-29-external-research-intake.md)、[开源准备度](docs/research/2026-09-27-open-source-readiness.md)，按具体问题再展开来源 |

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
- **私人数据**：Pocket 元数据与已提交待发正文留在本机私有数据目录；浏览器只持久保存按机器/来源隔离的阅读摘要与水位，草稿/历史正文沿用现有内存边界。口令、真实数据、截图、回执和备份放 `.local/` 或本机私有目录，不进入 Git、公开构建或第三方模型。Service Worker 只缓存公开壳。
- **网络与渲染**：本机服务监听 loopback，私人 API 保持认证、Host/Origin/CSRF 校验。消息标记仅作展示/受控导航，不执行指令或 raw HTML；图片只开放正文已引用、任务目录内且通过现有校验的文件。
- **能力取舍**：用户已要求通知、更多审批、共享待发队列及原任务新建/改名/归档；已交付与真实接口阻塞看 CURRENT。改名/归档须同步 Codex 原任务，不用 Pocket 别名或隐藏替代。外部调研候选仍先讨论，再实施选定事项。

## 验证、运行与收尾

- 功能改动先跑相关回归；发布前运行 `npm test` 和 `npm run build`，再验证受影响的实际流程。文档改动检查路径、事实、历史保全和 diff 即可。验证策略及受控真实发送对象只在 [QUALITY](docs/QUALITY.md) 维护。
- 默认使用合成数据和只读真实验收；必要发送按受控对象/文本约定操作，避免污染其他原任务。区分自动测试、浏览器、模拟器、iPhone 主屏幕真机与长期使用证据。
- 本地开发优先复用已有 API 或任务内临时 fixture；结束后关闭自己启动的临时进程。已登记服务的生命周期复用 FBT local，实际配置留在本仓库，不顺手重启 Codex。
- 发布从项目配置进入 [FBT Pages Site](/Users/fangs/workspace/fbt/workflows/pages-site/SKILL.md)；本地服务管理从 [FBT local](/Users/fangs/workspace/fbt/local/SKILL.md) 进入。上传已成功但回读未通过时，继续同一部署的 `resume --resume-verification`，先核对结果再决定下一步。
- `CURRENT.md` 只保留最近已验证版本、当前行为、继续方式和未决事项；被后续版本替代的详细流水移入 `HISTORY.md` 或对应设计记录，保留原日期与证据。检查并本地提交本任务改动，沿用 Workspace 的 Git 规则；本地 commit 不代表 push、发布或真实效果完成。
