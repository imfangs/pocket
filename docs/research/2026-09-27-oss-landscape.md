# Codex Navigator 开源定位：公开需求与同类能力复核

核验日期：2026-09-27。通过公开 GitHub REST API 读取 issue、默认分支 commit、README 和下列必要源码；没有安装或运行候选，也没有向外部发送私人任务、目录、口令或聊天内容。本文是产品判断证据，不是竞品运行验收或市场规模调查。

## 判断

管理大量既有 Codex 任务具有可泛化的问题基础，值得做开源验证，但“能分组”“能回到官方 App”“能从手机控制”分别已有需求或实现，不能单独当作独占卖点。更具体的定位是：**给官方既有任务补上可整理的归属、明确的稍后意图和一句接续说明，并保持原任务身份**。是否比搜索或 pin 更有用，仍需要外部使用者连续使用后的反馈。

一个会改变旧结论的新事实：Agent Sessions 默认分支已经加入直接打开 Codex Desktop 原任务的能力。先前同日研究基于更早默认分支的“仅终端 resume”结论已过时，本文件以当前固定源码修正该比较；没有改写旧研究的历史上下文。

Navigator 当前能力边界以仓库 [CURRENT.md](../../CURRENT.md) 为准：当前 PWA 是查看和整理入口，不提供完整聊天、发送指令或创建原任务；不能作为已实现远程执行控制器宣传。

## 公开问题：有人明确提出，但不能据此推出市场规模

| 原始需求 | 本轮 API 状态 | 请求的实质内容 | 对 Navigator 的含义 |
| --- | --- | --- | --- |
| [#30986 — Codex Desktop: add project-level topics / grouped threads in the sidebar](https://github.com/openai/codex/issues/30986) | open；updated_at 2026-09-18T03:07:59Z | 同一 workspace 下多个子项目和长期工作流混杂；希望 topics/sections、现有任务移组、折叠、组内搜索和置顶 | 逻辑分组独立于物理目录有直接问题证据 |
| [#29297 — Codex Desktop: saved sidebar views with regex search and custom sort rules](https://github.com/openai/codex/issues/29297) | open；updated_at 2026-06-21T14:14:35Z | 数十/数百任务时，最近排序和 pin 不够；希望保存搜索、正则、组合排序、规则分组 | 不能把“更多文件夹”当作全部需求；保存视图是一条邻接方向 |
| [#35927 — Codex App: first-class multi-label tagging for sessions in the GUI](https://github.com/openai/codex/issues/35927) | open；updated_at 2026-07-29T09:56:10Z | 一条任务同时有多个可过滤标签，独立于标题、项目和 Git；涵盖主题与工作状态 | 单层/单归属树不等于多标签，Navigator 不应宣传已覆盖这个完整请求 |

这些是请求者的表述；open 仅为 issue 状态，不证明每个最新客户端都没有相关功能，不是官方承诺，也不证明大量用户愿意安装独立工具。本轮未调查使用人数、留存、付费意愿或传播转化，不使用 stars 推导使用/质量。

## 候选当前源码

| 项目 | 默认分支固定版本 | 已核到的能力 | 与 Navigator 的重叠和差别 |
| --- | --- | --- | --- |
| [Agent Sessions](https://github.com/jazzyalex/agent-sessions) | main `a93b22b6b31c2c092a4820b1e32ae1c391ade9e5`；committer 2026-09-27T04:59:46Z；MIT | README 5.5.1 写明从列表/工具栏打开 Codex Desktop 历史；同时具备多来源本地历史检索、transcript、CLI resume、quota 分析 | 历史检索与官方 App 回跳已明显重叠。所读 README/相关源码没有核到任意层级分组 + 用户待续意图 + 接续说明/回顾日期的完整工作流；这仅为有界未发现，不是全产品永久缺失结论 |
| [Obelisk](https://github.com/tommy0103/obelisk) | main `2d31ae7ef5ec692a192d0de500e192c0083996cf`；committer 2026-09-23T18:20:10Z；AGPL-3.0-only | CLI/Agent 与 Electron 共用本地 SQLite；浏览/查询历史、按 project 过滤、memory、usage/recap；读取 Codex sessions 与 archived_sessions | 强项是“过去做过什么”的证据检索。所查 schema、sidebar、SessionDetail 没有发现独立任务待续队列、任意集合或官方 App 回跳；memory 不是任务继续承诺 |
| [CodexMonitor](https://github.com/Dimillian/CodexMonitor) | main `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`；committer 2026-03-26T07:01:43Z；MIT | workspace groups、pin/rename/archive、thread resume/send/interrupt；README 明确 iOS WIP、remote daemon、token 与 Tailscale TCP 路径 | 是独立执行工作台，手机远程控制已有方案。分组是 workspace 对象，pin/custom names 属于自己的 UI 状态；不能等同于官方 App 原侧栏同步或 Navigator 的接续意图 |

### Agent Sessions：回到原官方 App 已实现到源码层

来源：[固定 README](https://github.com/jazzyalex/agent-sessions/blob/a93b22b6b31c2c092a4820b1e32ae1c391ade9e5/README.md)、[CodexResumeCoordinator.swift](https://github.com/jazzyalex/agent-sessions/blob/a93b22b6b31c2c092a4820b1e32ae1c391ade9e5/AgentSessions/Resume/CodexResumeCoordinator.swift#L44)、[CodexResumeLauncher.swift](https://github.com/jazzyalex/agent-sessions/blob/a93b22b6b31c2c092a4820b1e32ae1c391ade9e5/AgentSessions/Resume/CodexResumeLauncher.swift#L140)。

- Coordinator 第 44–62 行从 Codex internal session ID 或 filename UUID 取原 ID，排除 side chat；核对文件存在后调用 `openSession`。打开 Desktop 不依赖 CLI 二进制、版本和终端配置。
- Launcher 第 149–153 行按 bundle identity `com.openai.codex` 找 App；第 188–194 行只接受 UUID，并生成 `codex://threads/<id>?hostId=local`，没有 clone 新 ID。
- 第 197–205 行调用 NSWorkspace，并在源码注释明确：Launch Services 接受 URL 不证明官方 App 找到了任务；两者必须指向同一 local session store。这个限制也适用于外部导航工具。
- 本轮未实际安装或打开候选，不宣称特定 App build、窗口选择、云/remote host 或每一种任务来源都已运行兼容。

### Obelisk：索引组织不等于用户任务意图

来源：[固定 README](https://github.com/tommy0103/obelisk/blob/2d31ae7ef5ec692a192d0de500e192c0083996cf/README.md)、[schema.sql](https://github.com/tommy0103/obelisk/blob/2d31ae7ef5ec692a192d0de500e192c0083996cf/packages/core/src/schema.sql)、[sidebar-projects.mjs](https://github.com/tommy0103/obelisk/blob/2d31ae7ef5ec692a192d0de500e192c0083996cf/app/src/renderer/src/sidebar-projects.mjs)、[SessionDetail.vue](https://github.com/tommy0103/obelisk/blob/2d31ae7ef5ec692a192d0de500e192c0083996cf/app/src/renderer/src/views/SessionDetail.vue)。

- README 区分 Agent 查询侧和人使用的 Electron 侧，并明确共同索引不等于原会话执行端。
- sidebar 根据已有 `item.project` 计数和筛选，不是用户任意创建的任务集合。
- 所查 schema 是 sessions/messages/tool_calls/subagents/workflows/summaries/memories 等结构；未见任务 tags/bookmarks/snooze/自定义组表。
- README 的 memory 是检索结论的可回忆合成记录，不可把它宣传为任务待续清单。

### CodexMonitor：手机控制是另一种更重的产品责任

来源：[固定 README](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/README.md)、[mobile blueprint](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/docs/mobile-ios-tailscale-blueprint.md)、[workspace group ops](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src/features/workspaces/hooks/useWorkspaceGroupOps.ts)、[threadStorage](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src/features/threads/utils/threadStorage.ts)、[codex_core.rs](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/shared/codex_core.rs)。

- README 明确每个 workspace 启动 app-server，选择任务时 `thread/resume`；是它自己的 UI 驱动执行，并非回跳官方 App。
- group ops 保存 `workspaceGroups` 至 AppSettings；threadStorage 将 pinned/custom names 保存 localStorage。
- mobile blueprint 使用桌面 daemon + iOS remote mode + Tailscale tailnet + token；README 标明 iOS WIP，手机 terminal/dictation 不可用。运行文档不等于本轮实测通过。
- 因此不能以“手机发一句话到 Mac”作为尚无人做的创新。做这一方向还要承担连接/断线、审批、重复发送、任务并发和客户端状态一致性的实测责任；Navigator 当前只读源 + 独立整理元数据的边界不应被营销文案模糊。

## 最小外部验证建议（推断，尚未执行）

1. 第一版开源叙述聚焦“保留以后继续的官方 Codex 任务”：用合成数据展示一条任务从分组、标记稍后、写一句说明到回到同一官方任务的完整过程。不可公开真实用户任务做 demo。
2. 先验证另一台干净 Mac 上独立安装，读取已有历史、保存/重启/回跳、卸载仍保留原数据；无需依赖作者本机域名或基础设施。
3. 找少量本来就有很多长期任务的使用者试用一周，核对是否实际通过待续列表重新开始了旧任务、是否仍只用原侧栏、是否因整理成本放弃。用真实返回动作而非 star 计数决定扩展。
4. 手机整理作为可选入口；远程发送/新建任务另作后续验收范围。若外部使用者主要需要多供应商历史检索，现有 Agent Sessions/Obelisk 可能更合适，不应为覆盖它们堆功能。

未核事项：竞品运行兼容、官方最新 UI 全功能、iOS 真机、用户规模/留存、潜在传播效果、全部竞品的完整功能与许可证依赖链。未安装、发帖、创建公共仓库或发送外部邀请。
