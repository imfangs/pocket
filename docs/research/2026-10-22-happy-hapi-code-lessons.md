# Happy / HAPI 源码：Pocket 值得借什么

2026-10-22。接续 [Claude Code 接入可行性](2026-10-22-claude-code-connectivity.md)，这次研究实现机制、增量价值与不宜照搬的部分。仅研究和隔离验证，没有修改产品行为或部署。

同日后续澄清：方帅仅想了解 Claude 接入，现阶段可以延缓；主线是优化当前 Codex 接入，特别是原生未读/已读同步。下文“接 Claude 时”的建议仅在将来明确恢复该方向时适用，不是当前实施顺序。随后完成的[未读专项研究](2026-10-22-unread-comparison.md)确认它们没有提供可直接借用的 Codex Desktop 原生已读桥接。

Happy 是手机/网页、本机执行端和同步服务组成的远程编程产品；HAPI 是自托管取向的同类平台，包含 hub、runner、多 Agent 适配及 Web/原生客户端。它们对 Pocket 最有价值的输入集中在 **能力契约、恢复协议、消息窗口、原生请求回读**。配对和端到端加密则更适合以后面向独立用户时采用。

## 取舍先看这里

| 可借机制 | 对 Pocket 的具体价值 | 建议 |
| --- | --- | --- |
| 版本化能力声明，按能力组织设置与操作 | Claude 与 Codex 共用界面，同时保留权限、型号、附件与恢复语义的差异 | 接 Claude 时采用一个小契约 |
| 接收游标与发送回执分离；重连补播有明确缺口判定 | 避免多端交错消息丢失，区分“连上了”和“状态已补齐” | 新增事件通道时采用；先测当前成本 |
| 最新小页、固定追赶终点、历史结构版本与有界窗口 | 手机先显示可读正文，再补历史；长会话与旧缓存能正确恢复 | 下一次解决长历史/切换延迟时优先借 |
| 原生工具结果确认批准/回答；另端先处理就撤掉旧请求 | 手机和电脑同时操作时不显示虚假的成功，也不让旧回答污染新会话 | Claude 适配时借；Codex 已有相近约束 |
| 每会话数据密钥与设备配对 | 为独立用户提供公共中继时缩小服务端接触正文的范围 | 多用户阶段再做完整验证 |

Pocket 已有持久待发、requestId/内容指纹、未知结果只核对、按机器隔离、原 owner 归属和可见阅读后标读。这些继续保留，不能把竞品同名能力当作当前缺口。依据是本地固定提交 `3ddac225f6db68d3301d611b16d0a0291a9157b0` 的实际代码；该提交时消息组件实现已完成，发布仍在进行中，后续状态回 CURRENT。

## 1. 把 Agent 差异收在能力契约里

HAPI 的 `agentConfig.ts` 把字段是否存在、字段类型、选项来源及可修改阶段建模为 descriptor：`static/machine/directory/session/model` 描述选项来源，`create/session/both/managed` 描述配置范围；`managed` 权限显示为状态，而非提供实际不能兑现的开关。[H1]

这不是只写了类型：`PermissionField.tsx` 与 `EffortField.tsx` 实际消费 descriptor，随后仍保留必要的 Agent 专属处理。runner 还声明机器能力；缺失必要能力时显示版本/能力不匹配，而不是等某个按钮点击后才无声失败。[H2]

Happy 的 `RigCapabilitiesSchema` 则描述 abort、附件限额、文件权限、型号选择、恢复和 RPC 方法，并给 rig metadata 版本与加法扩展空间。这里有两条实际消费链：新版 Rig 的停止操作同时要求 `abort=true` 与 RPC 存在；只有 `messageReceipts=true` 才等待 agent 的 acceptance，避免永远等一个旧运行时不会发送的回执。[Y1][Y5]

值得借的是按能力执行真实分支。Happy 的 app 仍有另一份 metadata schema，旧版/非 Rig 操作也有 permissive 兼容分支，不能将它描述为已经完全单一 schema 或全局默认拒绝。Pocket 继续用自身严格的未知状态和原 owner 判断；运行时不支持 acceptance 时也不能提前核销现有账本。

**Pocket 的最小落点**：接 Claude 时，让适配器返回 provider、协议/能力版本、原生会话身份和 `history/send/interrupt/requests/attachments/lifecycle` 等必要能力；界面按能力展示。当前 `ThreadModelSettings`、`RequestActions` 和 Codex 专用字段在此处做最小拆分。声明只是路由与展示依据，发送时仍需核对原 owner/当前请求；它不能代替授权或真实性校验。

**不扩大成通用框架**：先用 Codex 与 Claude 两个真实后端验证字段和方法是否足够。HAPI 的界面仍有专属分支，说明协议统一并不要求所有 Agent 假装拥有相同语义。

## 2. 把重连定义成可验证的恢复过程

### Happy：自己的发送成功不能推进接收游标

一个非常具体的并发场景：手机消息已在服务端记为 seq=1，本机消息随后 POST 成功拿到 seq=2；本机若因此把“已经收到”推进到 2，再补拉 `after=2` 就会漏掉手机消息。

Happy 的 `ApiSessionClient` 明确把 `lastReceivedSeq` 作为接收路径的游标，不因自己的 POST ack 推进；源码附近与回归测试都覆盖这个顺序。[Y2] 这是后续多端事件协议值得直接吸收的不变量。它不是对整段读取实现的完整背书：HTTP 补读仍有解密失败后推进 seq、以及显式跳过初始消息的分支；只吸收已核实的约束与竞态用例。

### HAPI：能补齐才跳过全量核对

HAPI SSE 使用 `{epoch}:{seq}:{namespaceTag}` 的事件游标：服务重启、切用户范围、游标失效或补播缓存被淘汰，都返回 `resume: gap`；可证明连续才返回 `ok`。补播期间的实时事件暂存，补播完再按顺序排出。[H3]

客户端把游标按 hub/认证范围/订阅过滤条件隔离，处理事件成功后再推进；后台暂停重试，回前台检查连接是否已经失活。`gap` 后重新读取会话与消息，并单独核对待发状态，连接建立本身不是恢复完成。[H4]

**对 Pocket 的增量**：当前 `src/conversationFeed.ts` 主要是活跃时 2 秒、普通状态 8 秒的读取，前后台、取消和单次在途控制已存在；列表也已有近期活跃集合和共享读取缓存。可借的是未来事件通道的连续性与补齐契约，不是重新实现这些基础保护。

实施可先只覆盖“当前会话正文更新”和少量列表状态。原桌面 owner 的取数若仍依赖轮询，手机侧换 SSE 不会自动提高源数据新鲜度；应测重复请求量、首次可读正文时间与恢复错误，再决定是否值得替换。

## 3. 长会话采用有界窗口，并明确历史失效

HAPI 的消息窗口有几处彼此配合的设计：[H5][H6]

- 首次和缓存重入先取最新 20 条，先显示可用正文；一般分页为 200 条。具体数字是该项目取舍，Pocket 应按正文大小和手机表现选择。
- 增量追赶固定 `snapshotHead`，不会一边补历史一边无止境追逐新产生的消息。
- 显示位置采用 `(invokedAt ?? createdAt, seq)`；排队时间与实际被 Agent 消费的时间分开。
- rewind、导入、取消等让游标失效时递增消息 `epoch`；客户端收到 reset 就重取，不能继续拿旧游标拼接。
- `syncGeneration` 丢弃旧请求；`requestBaseline` 保留读取过程中收到的新事件，避免迟到快照覆盖新消息。
- 普通显示窗口有界，但未消费消息单独保留，不能随着历史裁剪消失。

**Pocket 的实际落点**：`src/transcript.ts` 目前保留最近 80 条、总计约 16 万字符，`hasMore` 是截断提示，不是真正分页。下一次补“更早历史”时，优先借 **稳定消息身份 + 有界最新页 + 历史版本 + 明确补读入口**。这比仅提高数量上限更有依据。

HAPI 将部分消息窗口写入 sessionStorage；Pocket 目前有自己的私人正文/草稿存储边界，不能为借分页而自动改变保留策略。当前只读来源可能无法提供完整增量事件，也不能照抄 HAPI 对自有数据库的所有修改语义。

## 4. “批准已发送”与“原请求已处理”分开

HAPI 的 Claude `LocalPermissionBridge` 把原生对话框与网页回答视为竞态，而不是认为网页提交一定获胜。[H7]

- 用 session、prompt、tool call 和输入匹配具体请求；不按“最近一个同名工具”猜测归属。
- 手机回答发出后撤掉可操作控件，但不立即记为原生已接受。
- 通过工具生命周期、transcript 中的 tool result 确认最终结果。即使实际答案与手机提交不同，也以原生结果为准。
- 超时结束远端等待，不自动结束原生问题；另端先回答、Esc、`/clear` 或新会话到来，会使旧请求失效。
- 后台子代理、plan 转换或不能可靠匹配的请求保留各自边界。

**Pocket 已有基础**：`bin/request_actions.py` 根据最新原 owner 请求准备响应；`src/currentQuestions.ts` 只把当前原轮次问题作为可回答对象。新的增量主要是在 Claude hook / 原生终端路径中补齐同样的证据链，以及桌面先回答、超时后原生继续、会话切换后的专项验证。无需新增另一套“审批中心”。

## 5. 多用户时再借 Happy 的配对与密钥层次

Happy 的 V2 配对将账户主秘密、内容密钥对和每会话的数据密钥分层。CLI 临时公钥进入二维码；手机将内容公钥封装给 CLI，而不把内容私钥或主 secret 交给这个 V2 终端。CLI 新会话再产生随机数据密钥，用内容公钥封装；metadata/state 等走相应加密路径，机器元数据另用 machineKey。[Y3][Y6]

这对“别人装 Pocket，连接自己的电脑”有参考价值：把设备身份、网络路由与正文访问分开，中继不必靠掌握正文来转发。但采用时要一起核实配对挑战、恢复、撤销、缓存以及推送等未加密元数据边界；仅看到加密函数不能声称整条产品链路已安全审计。

特别要保留两条源码事实：Happy 旧 V1 配对实际封装并交付主 secret，“终端不拿主密钥”只适用于所述 V2；vendor token 接口由服务端接收、加密保存并解密返回，属于服务端静态加密。不能泛化为“Happy 所有数据/凭据都端到端加密”。[Y6][Y7]

当前 Pocket 是私人入口，Worker 转发到本机 API；多人/E2E 仍是 [已记录的候选方向](2026-10-13-pocket-multiuser-architecture.md)。本轮不因此把其升级为近期建设任务。

## 6. 两处明确不照搬

### HAPI 的时间窗口回显兜底

`mergeMessages()` 在缺少精确 `localId` 回显时，会把 10 秒内出现的服务端用户消息当作可消掉“sent”乐观气泡的依据，没有要求文本或请求 ID 相同。[H8]

本轮用真实函数复现：一条内容 A 的本地 sent 气泡，加上一秒后内容完全不同的服务端用户消息 B，合并结果只剩 B。这是特定兜底分支的可复现行为，不是 HAPI 所有消息都会丢的结论；它也不证明服务端删除了 A。Pocket 应继续依精确 clientMessageId/requestId 核对，不把时间相近当作回执。

### Happy/HAPI 的存储幂等不能代替 Pocket 的执行账本

两者都有 localId 去重路径；HAPI `addMessage()` 在同 session/localId 已存在时返回旧行，Happy 的相应测试也覆盖“同 localId 重复请求返回旧消息”，即使新 body 不同。这能防消息行重复，但不单独证明原生执行一次，更不能替代 Pocket 对同 requestId 不同正文的指纹冲突校验。[H9][Y4]

Happy 此处 CLI outbox 是内存数组，并优先发送最近一批。它承担的是运行事件/消息同步的职责，不应被移植来替换 Pocket 已有持久 FIFO 待发队列；也不能用它证明进程崩溃后的恢复保证。[Y2]

整套 daemon/runner 生命周期与 SDK 接管同样只作为参考；Pocket 原 Codex owner 继续承担既有任务执行。许可证方面，Happy 根许可为 MIT，HAPI 为 AGPL-3.0；本轮没有向 Pocket 产品复制上游实现，后续若直接复制/集成再处理对应发布义务。

## 验证与下一步

- **真实运行**：固定 HAPI 源码的 `bun test hub/src/sse/sseManager.test.ts`，14 pass / 0 fail / 53 assertions。覆盖命名空间、补播、失效游标、缓存淘汰、补播/实时交错。该模块只依赖小接口，能在未安装整套依赖、未启动 hub 的条件下独立验证，这也是值得借的模块边界。
- **纯函数探针**：真实 `messages.ts` 经已安装 TypeScript 转译，仅改 import 路径；四项正向检查通过：精确 ID 回显替换、迟到快照不撤销消费时间、消费顺序、未知状态的显示保留；另复现上述时间窗口反例。无网络、用户会话或模型调用。
- **静态证据**：其余 Happy/HAPI 实现与测试只是阅读，没有冒充完整产品、密码学或手机真机验收。[探针结果与来源](2026-10-22-happy-hapi-code-probes.json)仅包含合成样本。

最小采用顺序：**Claude 接入时补小能力契约和原生请求语义 → 长历史需求出现时做稳定分页 → 测量后决定事件推送 → 多用户时再做配对/E2E**。前两项分别用两个实际适配器和一条长历史验证；重连验证至少覆盖错序、断开、服务重启、切机、旧请求迟到与重复正文。

## 固定来源

本轮 Happy 更新到 `1a643badd1b4a5043f5316af0821402c770e55b6`（2026-10-21 20:38 UTC），HAPI 保持 `5d8deb201189dc1f183c4f5bf38c87ec4d34dd70`（2026-10-19 23:22 UTC）。不要把这些快照中的细节写成未来版本保证。

- [H1 Agent 配置契约](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/shared/src/agentConfig.ts#L16-L96)
- [H2 权限字段消费](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/components/NewSession/PermissionField.tsx#L37-L72)、[runner 能力](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/shared/src/runnerCapabilities.ts#L16-L68)
- [H3 SSE 补播与缺口](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/hub/src/sse/sseManager.ts#L114-L203)、[对应实测测试](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/hub/src/sse/sseManager.test.ts)
- [H4 客户端推进游标](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/hooks/useSSE.ts#L793-L822)、[公开 SSE 契约](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/docs/api/client-contract/sse.md)
- [H5 有界窗口与最新页合并](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/lib/message-window-store.ts#L493-L651)、[增量补齐](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/lib/message-window-store.ts#L685-L802)
- [H6 分页与排队契约](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/docs/api/client-contract/pagination.md)、[断线后待发核对](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/lib/queued-state-reconciliation.ts)
- [H7 原生权限桥](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/cli/src/claude/utils/localPermissionBridge.ts#L45-L227)、[专项测试，未执行](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/cli/src/claude/utils/localPermissionBridge.test.ts)
- [H8 时间窗口兜底](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/lib/messages.ts#L182-L208)
- [H9 localId 消息行去重](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/hub/src/store/messages.ts#L130-L138)
- [Y1 Happy rig 能力](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-wire/src/rigMetadata.ts#L55-L75)
- [Y2 接收游标定义](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-cli/src/api/apiSession.ts#L233-L244)、[POST ack 的边界](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-cli/src/api/apiSession.ts#L689-L695)、[并发回归，未执行](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-cli/src/api/apiSession.test.ts#L1183-L1245)
- [Y3 内容密钥派生](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/encryption/encryption.ts#L14-L32)、[新会话数据密钥](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-cli/src/api/api.ts#L36-L67)
- [Y4 消息去重回归样例，未执行](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-server/sources/app/api/routes/v3SessionRoutes.test.ts#L495-L518)
- [Y5 能力实际判定](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/rig.ts#L183-L218)、[停止入口](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/ops.ts#L884-L894)、[接受回执分支](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/messageMeta.ts#L19-L39)
- [Y6 V1/V2 配对封装](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/hooks/useConnectTerminal.ts#L24-L39)、[CLI 解包及 machineKey](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-cli/src/ui/auth.ts#L170-L205)、[内容公钥字段](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/encryption/encryption.ts#L49-L56)
- [Y7 vendor token 服务端加解密](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-server/sources/app/api/routes/connectRoutes.ts#L249-L291)

Pocket 对照入口：[读取循环](../../src/conversationFeed.ts)、[展示窗口](../../src/transcript.ts)、[发送回执](../../src/submissionReceipt.ts)、[当前问题](../../src/currentQuestions.ts)、[原生响应](../../bin/request_actions.py)、[10-22 状态预取](../design/2026-10-22-active-thread-prefetch.md)。固定版本回读使用 `git show 3ddac225f6db68d3301d611b16d0a0291a9157b0:<path>`。
