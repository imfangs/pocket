# Pocket 对外价值、需求与开源判断

日期：2026-11-05。问题来自欧吉安：Pocket 对其他人有没有价值、是否值得开源、网上有没有需求，以及与 Happy/HAPI 的差异是否在于同一份桌面任务列表。这里的任务列表指 Codex 会话列表。

本轮只读产品实现、已有验证记录、最新上游源码与公开需求；保存研究和接续指针，没有安装竞品、配对手机、修改产品、部署、公开仓库或联系用户。Pocket 研究基线为 `525dbc7`。当前产品与公开候选仍回 [CURRENT](../../CURRENT.md)，不能将本报告的建议当成已决定的产品路线。

## 判断

**Pocket 对一部分 Codex 桌面用户有价值，值得做范围明确的开源 Alpha；尚无外部持续采用证据。** 最合理的价值主张是：为原本就在 Mac 上使用 Codex 的人提供轻量、可自部署的手机/浏览器入口，接续已有会话，保留原执行归属和工作习惯。

欧吉安指出的“同一份桌面任务”是重要的购买/采用维度，但必须更新“Happy/HAPI 看不到桌面旧任务”的概括。HAPI 已实现旧会话发现、导入、同步与恢复；官方 Remote 和其他开源桥接也覆盖原桌面接续。这个方向有真实需求，也已有供给，不能把它包装成 Pocket 独有能力。

当前更值得验证的是：原桌面运行中会话的连续性、已有项目/置顶等组织的保留、手机阅读和输入体验，以及安装维护是否比现成方案更省事。前两项有源码机制依据，整体体验优势尚未经过同设备对照和外部用户验证。

## “同一份任务”要拆成三层

| 层次 | Pocket 当前依据 | 与 HAPI 的当前对照 |
| --- | --- | --- |
| 能看到已有历史和原会话身份 | 只读原 Codex 来源，按原 thread ID 展示本地可用历史 | HAPI 已支持发现/导入 Codex 旧会话；不再构成二元差异 |
| 列表和已有桌面组织自然对应 | 读取原项目与置顶映射，按已核验来源规则排除内部执行/子节点 | HAPI 普通列表来自自己 hub 的会话记录；Codex 列表是发现与导入入口，导入后维护自己的 session identity 和原 Codex ID 映射 |
| 正在运行的原桌面执行继续接受手机输入 | 通过原桌面连接查找并使用原 owner，不另起执行器接管活跃会话 | HAPI 已让其 wrapper 中的原生终端和手机共享同一 app-server；文档明确冷恢复拒绝另一 live owner。所查主路径不能证明能直接附着任意已运行的 Codex Desktop owner |

HAPI 的导入能延续原 Codex thread 的历史，不能简单说成“复制历史后创建全新的 Codex 任务”。区别在于列表投影、同步步骤和运行时归属，而不只是 UUID 是否相同。当前 HAPI 具体入口能否在真实桌面运行时完成无中断附着，还需实机比较；本轮没有把未找到路径当成全产品能力不存在的证明。

Pocket 也不能宣传“桌面完全同步”：Pocket 关注/隐藏是独立偏好；待发队列与桌面独立；原生已读写回仍未稳定恢复，跨手机已读尚未实现；占用中的归档仍可能等待，最新原生取消归档存在范围兼容差异。列表也不是对桌面异步目录的逐行镜像。依据见 [架构](../ARCHITECTURE.md)、[列表范围](../design/2026-10-14-desktop-list-scope.md)和 CURRENT 的未决记录。

## 竞品事实更新

**HAPI：旧导入缺口已经关闭。**

- [#426](https://github.com/tiann/hapi/issues/426) 的用户在 2026-04-09 报告：HAPI Web 看不到桌面旧会话，反向能看到。
- [#796](https://github.com/tiann/hapi/pull/796) 于 2026-06-04 合并，加入桌面历史列表、多选导入和复制/合并；[#1088](https://github.com/tiann/hapi/pull/1088) 于 2026-07-19 合并，将发现和读取迁至指定 runner，补导入/归档/同步/分叉/恢复与机器绑定。
- 维护者于 2026-07-19 [明确关闭 #426](https://github.com/tiann/hapi/issues/426#issuecomment-5015645248)，说明描述的问题已解决。最早的自动 bot 诊断是历史材料，不能当今日事实。
- 本轮固定 `6712e19dfab83afdd747503277907b52dd34b0a4`（0.34.2）回读：[原 Codex 会话发现](https://github.com/tiann/hapi/blob/6712e19dfab83afdd747503277907b52dd34b0a4/hub/src/web/routes/codexDesktop.ts#L2227)、[导入生成/关联 HAPI 会话](https://github.com/tiann/hapi/blob/6712e19dfab83afdd747503277907b52dd34b0a4/hub/src/web/routes/codexDesktop.ts#L1974)、[普通 hub 会话列表](https://github.com/tiann/hapi/blob/6712e19dfab83afdd747503277907b52dd34b0a4/hub/src/web/routes/sessions.ts#L88)及[共享执行契约](https://github.com/tiann/hapi/blob/6712e19dfab83afdd747503277907b52dd34b0a4/docs/guide/codex-shared-sessions.md)。同一 HAPI 执行已支持原生队列镜像、手机/终端问答和原生输入确认，不能继续用旧局部反例贬低当前产品。

**Happy：已发展成自己的桌面、移动与多模型体系。** 本轮固定 `76ed3d0abaf5586b1929df77797af8783b38d21c`，[README](https://github.com/slopus/happy/blob/76ed3d0abaf5586b1929df77797af8783b38d21c/README.md)介绍 Happy Desktop、Happy Agent、移动端、多人会话和端到端加密；原 CLI 仍是 `happy codex` 等 wrapper。它的“桌面同步”不能自动等同于同步 OpenAI Codex Desktop 的已有完整目录。Pocket 的候选区别是附着现有工作流；Happy 的多模型/原生移动/多人/E2EE不能当 Pocket 已有能力。

Happy [#877](https://github.com/slopus/happy/issues/877) 是 Windows/Claude Code 的桌面历史未进入手机的个案，本轮 API 状态仍 open。它可以说明历史完整性的重要性，不能证明今日所有 Happy/Codex 路径都失败。

**官方 Remote 是首要对照。** [官方手机文档](https://learn.chatgpt.com/docs/mobile)已明确支持在手机选择连接的电脑、接续已有会话、查看跨 host 任务、批准操作与查看 diff。可用性取决于 rollout 和 workspace 设置。对主要需要 iPhone 接续、且已能使用官方入口的人，应先比较官方方案；Pocket 新增自托管服务的安装与维护成本必须换来实际好处。不能把“同电脑同任务”当官方尚未实现的空白。

**已有直接开源竞争者。** [Codex Mobile Bridge](https://github.com/try2love/codex-mobile-bridge) 在固定 `0721aa7dafa6177751ba7e568e0ad0efee05655b` 的 [README](https://github.com/try2love/codex-mobile-bridge/blob/0721aa7dafa6177751ba7e568e0ad0efee05655b/README_EN.md) 声明复用原桌面会话、认证与执行环境，提供手机和浏览器入口；原 App 已持有会话时跟随该连接，另有显式 CLI 恢复。它比只比较 Happy/HAPI 更直接。本轮核对文档、版本和用户 issue，没有验证全部声明或体验优劣。

## 网上有没有呼声

有。证据支持“存在一批具体用户及剩余摩擦”，不支持“大市场已验证”。

| 原始证据 | 它能证明什么 | 不能外推什么 |
| --- | --- | --- |
| HAPI #426：桌面旧会话无法进入 Web；后续多次 PR 和维护者关闭 | 旧会话自然进入远端列表是实际提出并被投入实现的需求 | 缺口仍未解决，或这些 PR 等于大量用户留存 |
| [OpenAI 社区浏览器接续请求](https://community.openai.com/t/codex-remote-sessions-accessible-from-chatgpt-on-the-web-windows-chrome-edge/1393243)：2026-08-28 原帖，09-05 另一用户认同，09-14 支持人员表示已转达、无浏览器时间表 | 已使用官方手机远控的人仍想从另一电脑的浏览器接续同一会话 | 今日每个账号的 web 能力必然相同；需复验官方变更 |
| [Codex #40124](https://github.com/openai/codex/issues/40124)：2026-08-22 创建，本轮 API 仍 open，要求 CLI/Web/iOS 保留同一会话、进程和审批 | 对原执行环境连续性的需求仍存在 | Pocket 已解决 CLI-first、headless、容器和所有跨端路径 |
| [Bridge #47](https://github.com/try2love/codex-mobile-bridge/issues/47)：2026-10-17 用户要求 Android 后台任务通知，10-30 关闭 | 开源同类有非维护者提出实际手机使用摩擦；离开前台后的闭环有价值 | 后台功能稳定性、留存和付款已验证；正文含用户标明的 AI 整理 |

本轮 API 快照 Happy 24,493 stars、HAPI 5,363、Bridge 178，仅作关注度背景。不同起始时间、定位和受众不具可比市场规模意义，不据此推算 Pocket 用户数。作者自荐与自建 issue 未计作独立用户；例如 Bridge #99/#101 由维护者自己创建，不用来充实用户证据。

## 对谁有价值，开源为了什么

最匹配的是已经把 Mac Codex Desktop 当日常工作台、存在多个持续任务、会离开电脑但仍需阅读/纠正/审批的人。浏览器跨设备、希望自行控制入口和数据的人是可验证的更窄人群。重视多 Agent、多人协作或成熟原生客户端的人已有更广的平台；以纯 CLI/SSH/headless 为主的人也不能直接算 Pocket 的适配用户。

开源的意义可以小而成立：别人能独立部署和检查边界；桌面版本兼容和移动恢复能得到外部反馈；原会话桥接、诊断和安装实现可以复用；作品有可回源的演进记录。采用人数、持续使用和维护贡献仍须验证，开源本身不证明影响力或商业可行性。

11-04 已补 MIT、中英文档、公开依赖、自带桥接、通用配置、setup/doctor、用户服务、源码导出与隐私检查，旧的作者环境耦合大部处理。当前仍为未公开的 macOS 单拥有者 Alpha。发布需要选定并复核实际公开版本、独立新 Mac/实体手机/代理/升级回滚闭环，处理最新恢复兼容差异，完成相关许可与正式 repo/tag/CI 的收尾。详见[开源准备](2026-11-04-self-hosted-open-source-readiness.md)、[隐私边界](2026-11-04-open-source-privacy-boundary.md)与 CURRENT；本轮没有将这些门槛升级为无关功能扩建。

## 最小验证建议（尚未执行）

先在另一台无维护者配置的 Mac 上验证安装和同一原会话闭环，再用少量外部 Codex 桌面用户检验主动复用。建议规模 3–5 人、一周，作为探索样本而非统计结论；当前研究不授权联系、发送邀请或公开发布。

用同一组已存在的桌面会话，对照 Pocket、官方 Remote、HAPI 的导入/共享路径和 Bridge：核对项目/名称/置顶及历史；在电脑启动任务，手机读结果、发纠正、处理一次受支持请求，再回到桌面核对 thread/执行归属和输入结果；加入后台切回、网络中断与升级恢复。记录首次得到价值的成本、是否改启动习惯、是否重复建立会话和实际失败，不以功能计数给产品打分。

若用户在可用官方入口下仍主动选择 Pocket，且能具体说出浏览器入口、阅读/输入或自部署控制的好处，就继续小范围开源维护。若只在被提醒时打开、安装依赖持续要求作者陪同、或现成 Bridge 更好满足同场景，则保留个人工具和可复用模块，减少公共产品投入。下一阶段的证据应来自真实采用，不是继续叠加功能或界面精修。

证据原件位于本机忽略目录 `.local/research/pocket-value-2026-11-05/`：GitHub API 原始 JSON、固定 HAPI 文件、官方/社区文本、Bridge 固定 README。公开需求和竞品声明不是实机验收；没有读取或输出真实 Pocket 用户对话与凭据。旧研究继续保留历史日期；此外当前 HAPI 源码已有服务端 read-state 路由，不沿用旧的全客户端“仅本地已读”概括，也不因此推定它修通了 Codex Desktop 原生蓝点写回。
