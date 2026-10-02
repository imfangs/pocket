# Pocket 当前状态

维护日期：2026-10-02。本轮新增 Ged 手动模型选择的服务端接口，合成验证与构建通过，尚未部署或修改真实任务模型。产品与公网最近实测仍为 2026-09-30；详细历史已完整保留在 [HISTORY.md](HISTORY.md)。

## 继续方式

- 方帅已于 2026-09-30 取消定时打磨。2026-10-01 回读确认 `codex`（“持续打磨 Pocket”）为 **PAUSED**。以后按新的明确任务继续开发；旧 heartbeat 记录不是恢复定时执行的授权。停用的是开发 heartbeat，Pocket 服务、用户已提交队列与通知按各自状态运行。
- 以手机方便查看和接续 Mac 原任务为当前用途。10-02 为 Ged 客户端明确要求的手动模型选择补充原 owner 服务端入口，Pocket 网页未增加入口。
- 新建/改名/归档、共享桌面待发队列已获用户选择，但接口仍受限；其他调研建议先讨论，不由“继续打磨”自动变成建设任务。

## 10-02 模型接口实现（未部署）

- 新增模型当前值/候选 GET、显式 model/effort POST、按 requestId 只读核对接口；协议见[下一轮模型选择](docs/CONVERSATION.md#下一轮模型选择)。仅原 owner 空闲时接受，二次回读 model/effort/provider 与 owner 的版本，保留权限、cwd、工作模式及原线程。
- `model_changes` 先入账再派发，同ID不重复执行；unknown只读回，确认目标设置才解除发送和待发队列阻塞。迟到失败不降级已确认结果，落盘历史不确认设置。
- 当前目录为 `config/model-catalog.json` 的6个同provider配置候选，基于当前 App 工具公开元数据；不是动态 `model/list`。provider `codex` 接已有 Friday Responses 代理，未因此宣称所有候选的跨模型历史/加密内容/工具循环兼容。
- 全套199项测试及 `npm run build` 通过；测试含合成 Unix socket follower、HTTP认证/CSRF、原owner/陈旧版本、参数范围、超时/重启/重复编号、原生读回和队列恢复。日志 `.local/qa/model-selection-2026-10-02/tests.log`。本轮没有调用真实模型、修改用户原任务或重启现有服务。
- 下一步：root 在已约定的受控echo对象验证 A→B→A 和真实下一轮续聊；若候选不兼容，先从发布候选中移除。当前值确认与下一轮实际回复是两层证据。

## 最近已验证版本

| 项目 | 记录与事实源 |
| --- | --- |
| 公网 / 本机入口 | [x.fangs.cc](https://x.fangs.cc) / [threads.local](https://threads.local)；Mac API 监听 `127.0.0.1:4397`，连接器健康端口 `4399`，配置在 `config/` |
| 已发布产品源码 | `168785a`；后续文档 commit 不代表部署更新 |
| Pages 部署 | `a11b61b8-8f87-45ae-b71b-7e4e56768def`，14个公开文件及功能检查通过 |
| 前端 build ID | `269bea7b5aa35df23f1d72c811bc82a5c6c33dcea322456d32151d860e9b0de2`，由公开 `pocket-version.json` 和 HTML meta 对照 |
| 验证快照 | 188项回归与构建通过；提示布局修订后20项专项和两代浏览器流程通过。入口与实际升级回读见 `.local/qa/app-update-2026-09-30/` |
| 最后健康复核 | 09-30 18:04，Mac后端/隧道正常，curl及390px浏览器可达，匿名目录401；Python urllib的403/Cloudflare1010仅为探针差异。见 `.local/qa/heartbeat-2026-09-30-1804/` |
| 本地数据与兼容性 | 用户数据在 `~/Library/Application Support/CodexNavigator/`；原 App 版本门槛和 Python/FBT 路径以 `config/desktop-bridge.json` 为准。App升级后先复核，勿直接去掉版本限制 |

需要确认今天的在线状态或发布身份时再回读服务/公网及 `.local/pages-site.json`，不把以上日期快照当实时保证。

## 已具备的能力

- **任务导航**：导入原任务、项目、置顶/归档状态；独立分组、接续说明、分类、搜索、最近活动排序与“待我输入”。待输入依据原未读与轮次终态，查看 Pocket 不回写原蓝点；支持元数据备份和 CLI。
- **阅读**：认证后的落盘正文与原桌面状态独立刷新，最近可见消息有界合并；Markdown、Codex 常见专用标记、任务目录内已引用的静态图片可读。用户、过程与最终回复有明确视觉区分。
- **发送与控制**：原任务空闲时发送，运行中默认 Pocket 排队；可编辑、删除、直接发送、按 turn 中断及恢复队列。上下文用量与空闲时压缩可用，待发列表不必清空。
- **提问与审批**：最新一轮异步问题、同步阻塞问题，以及命令、文件、本轮权限审批已接入；均由用户明确响应。MCP 自定义表单和未知类型仍在 Mac 处理。
- **手机体验**：下拉刷新、左边缘右滑返回、自增高输入、明暗模式、启动反馈、阅读/草稿保留。旧目录或发送回执不会覆盖新状态，输入区缩放仅在原本跟随底部时调整位置。
- **通知与更新**：Web Push 关注在 Pocket 打开或发送过的任务；有新版时明确点击更新，保护未完成输入/操作并核对 manifest、入口和 JS/CSS。第一次加载该更新入口仍需重开旧页面一次。

接口细节和模块路由见 [AGENTS.md](AGENTS.md)，能力表见 [DESKTOP-PARITY](docs/DESKTOP-PARITY.md)。

## 阻塞、未决记录与验证缺口

1. **原实例完整控制通道**：新建/改名/归档和共享桌面队列尚未交付。此前核验桌面 App Server 仅 stdio，App Tools 限定 OpenAI 签名身份链；已有 follower 接口不能代表全部管理能力已打通。继续时读[控制入口研究](docs/research/2026-09-29-desktop-control-entrypoints.md)，按当前安装版本重新核验。Codex 给本任务提供的管理工具，不等于 Pocket 常驻后端能调用同一能力。
2. **旧未知回执**：09-30曾留下本任务两条 unknown 和一条待发正文，当时未重发/删除；相关编号和原始证据在 `.local/qa/connectivity-2026-09-30/dispatches.json`。下次涉及队列时重新核对当前账本与原历史，不凭历史中暂未找到文本推断未发送。
3. **真实设备**：iPhone 添加主屏幕后首键盘、边缘手势、后台/锁屏通知、长时间切网与版本升级仍需实用反馈。浏览器尺寸、模拟器和注入旧测试构建的公网升级对照，不能替代真机安装升级验收。
4. **性能与缓存**：文字优先读取已改善等待，但新模型回复的端到端长尾还需观察；公开离线壳固定路径的 Service Worker 缓存沿用原策略。二者不是本轮维护中重新确认的故障。
5. **对外分发**：仍是个人部署，未公开开源。独立安装、账号模式和个人基础设施解耦未完成通用验证；阅读[开源评估](docs/research/2026-09-27-open-source-readiness.md)后再确定交付范围，不承诺所有 ChatGPT 付费账号即装即用。

## 下一次开发怎么进入

先用用户当下反馈选择一条完整流程。若没有新反馈，优先取得上面真实设备/网络的缺口证据，再判断是否改代码；需要补能力时，区分原接口受限的已授权项与仍待讨论的研究候选。验证步骤与受控发送约定见 [QUALITY](docs/QUALITY.md)，不恢复定时任务。

| 问题范围 | 最近设计与证据入口 |
| --- | --- |
| 长会话发送/未知回执 | [发送修复](docs/design/2026-09-30-send-reliability.md) |
| 正文更新慢/迟到快照 | [文字优先](docs/design/2026-09-30-transcript-first.md) |
| 刷新、草稿、输入高度与阅读位置 | [连续性修复](docs/design/2026-09-30-steady-interaction.md) |
| 旧问题卡、内部标签、图片 | [问题与标记](docs/design/2026-09-30-codex-markup-and-current-questions.md)、[图片](docs/IMAGES.md) |
| 更新、未完成输入、CDN切换 | [安全更新](docs/design/2026-09-30-safe-app-update.md) |
| 通知/待输入提醒 | [通知](docs/NOTIFICATIONS.md)、[输入收件箱](docs/design/2026-09-29-input-inbox.md) |

文档维护：更新此页的现状；详细事件写入 HISTORY 或对应设计文档，避免把过时的“尚未支持”“仍慢”重新累积到接续首页。
