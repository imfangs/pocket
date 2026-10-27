# 当前轮问题与 Codex 消息标记

2026-09-30 方帅反馈：早期轮次的问题持续占据输入区；“游戏 - 雨血复刻”出现 citation_entries / rollout_ids，其他任务出现 created-thread 原文。

## 已确认原因

- 桥接器从最近 30 轮收集未回答的异步问题，没有限定最新轮次。合成两轮原 owner 快照稳定复现；旧问题返回 1 条，预期 0 条。
- 雨血任务的记忆引用块紧贴前一段正文，Markdown 把带下划线的内部标签当文本显示。独立 SSR 重放真实消息确认此行为；空行分隔的样例不能复现，回归使用实际的紧邻段落形态。
- created-thread 没有展示适配，直接进入普通段落。

2026-10-22 文件引用和未知组件的统一展示见[消息组件](2026-10-22-message-components.md)：文件能力从可见正文登记，按点击下载；代码/转义保护与可读回退保持。

## 行为

- 回答区只展示原桌面最新一轮的未回答异步问题。最新一轮已完成但仍有问题时保留；新轮次开始后旧问题退出回答区，历史消息保留。
- 回答操作同样重新核对最新轮次，旧页面提交旧问题返回 question_changed，不发起新轮次或 steer。问题回执 key 保持原算法，保留既有 pending/accepted/unknown 的去重含义。
- 前端按问题 turnId 与原桌面 turnTiming 再过滤。落盘记录明确显示更新的轮次时，只收起过期卡片；不会据此开放提交权限。
- Codex 消息在 Markdown 前做有界展示转换，复制回复使用同一内容。源历史、SQLite 和 rollout 均不修改。

| 标记 | Pocket 展示 |
| --- | --- |
| oai-mem-citation / citation_entries / rollout_ids | 隐藏内部溯源块，包含缺少空行、截断尾部和 HTML 实体形式 |
| created-thread + threadId | “打开任务”，跳转 Pocket 内对应任务，复用已有导航并保留草稿 |
| created-thread + clientThreadId | 准备中提示，不把临时 ID 当正式任务 ID |
| codex://threads/ID 的 Markdown 链接 | 同上；只接受严格 UUID |
| code-comment | 可读的标题、正文、文件位置 |
| codex-followup | 建议与提示词的引用段落，不自动发送 |
| codex-annotation | 简短批注编号 |
| inbox-item / automation / automation-update | 可读摘要；不从正文执行动作 |
| archive-thread | 隐藏控制标记，不执行归档 |
| heartbeat 定时触发 | 显示“定时检查”；长 instructions 默认折叠，可展开查看与复制 |
| heartbeat 检查结果 | 显示 message 摘要；DONT_NOTIFY 只代表无需主动通知，不隐藏历史正文 |
| cite / filecite / filenavlist | 简短引用提示，文件行号能解析时保留；只有内部 ID 时不编造来源链接 |
| entity / image_group / i | 实体名称或图片引用提示；不凭内部 ID 请求图片 |

转换只改展示，保留原始用户和助手消息；代码块、行内代码和链接目标保持。未知Codex组件按10-22规则可读回退，其他未知标记保持；不启用 raw HTML，不从第三方自动请求媒体。局部解析只对含已知标记的消息执行，结果随正文 memoize，不引入新的依赖。

## 2026-10-28：定时检查正文空白

用户截图中，普通回复正常，后续数轮用户气泡与助手回复只剩时间、复制和用时。核对原会话与Pocket只读transcript，正文均仍在：触发内容是 `<heartbeat>` 的 `instructions`，回复是同一包装中的 `message`。`react-markdown` 的 `skipHtml` 把整段包装识别为HTML块后丢弃，而消息外框仍基于原始文本显示footer，造成空白。

新增 `heartbeatMessage.ts` 作为展示适配：只解析完整已知字段，拒绝重复或未知字段；用户触发转为紧凑“定时检查”及可展开内容，助手转为可读检查说明。通知decision不驱动Pocket动作，DONT_NOTIFY结果仍可查看。代码围栏、行内与四空格/tab缩进示例不转换；未知或未完整的heartbeat安全按文字代码回退。提取字段内若仍有真实HTML节点，保留为字面内容，避免再次被skipHtml吞掉；普通Markdown代码示例保持。

原始消息、查询回执、阅读水位、定时任务及Mac执行保持原样；没有开启raw HTML，也不执行包装中的instructions或decision。真实样本共8条heartbeat，四条结果与四个触发均可显示。11项专项回归和两引擎浅/暗模式184项浏览器检查通过，包含展开/收起、复制、上滚刷新、零执行请求和异常包装；完整测试与发布回读见 [CURRENT](../../CURRENT.md)，私有样本及回执在 `.local/qa/blank-messages-2026-10-28/`。

## 验证

- 最初回归确认旧问题、紧邻段落的记忆引用和 created-thread 三项均失败；修复后通过。
- 163 项全量测试与生产构建通过，覆盖 canonical turnHistory、旧问题回答拒绝、当前问题回答、截断/实体/代码/用户内容/恶意链接、两路历史先后到达。
- 隔离浏览器 390px / 1280px：当前卡片可见 → 更新轮次落盘而桌面滞后时收起 → 当前问题正常展示 → 当前无问题时消失；往返任务链接没有整页重载，草稿保留；无横向溢出、页面错误或任务执行请求。
- 私有证据 `.local/qa/codex-markup-2026-09-30/`；上线及真实样本回读以 CURRENT.md 为准。没有新增真实模型验收消息；iPhone 主屏幕真机待实际反馈。
