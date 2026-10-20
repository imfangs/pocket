# 会话模型与思考强度

2026-10-18。用户希望在 Pocket 看见会话的模型设置，例如「6 Astra Ultra」，并尽量支持修改。本轮在现有会话信息中显示型号与强度，并允许修改同型号的思考强度；不增加管理页或常驻工具栏。

## 用户路径

点击详情顶部会话标题，在「模型」一行查看 `GPT-6 Astra · Ultra`。点击「修改」后展开当前型号支持的思考强度，保存后对后续消息生效；不打断当前轮、不发消息、不改型号、权限、工作目录或工作模式。当前值未变化时不提交。

未连接和归档会话显示原数据中已保存的设置，明确标「已保存」。查看信息不会激活会话；只有用户点击修改且原因确为未连接时，才沿用原连接流程。缺失字段保持未知，不拿全局默认、最近模型选择或旧轮次冒充当前设置。归档会话先取消归档。

## 原生来源与修改边界

- 实时值来自原 owner 的有效设置：优先 `latestThreadSettings`，再取协作模式中的型号/强度，最后才用旧的 `latestModel / latestReasoningEffort`。本会话实测旧 effort 为 null，而有效值是 Ultra；专门的 read-model-settings v1 同样会返回这个旧 null，因此仅把它作为等待原生设置操作完成的栅栏，随后读取快照。
- 归档/未连接 fallback 来自 Codex `threads.model / reasoning_effort` 的可选列。API 只返回型号和强度，原始设置中的权限、注入指令与 provider 不进入前端。
- 当前型号的显示名、支持强度来自本机捆绑 CLI 的 `model/list`。读取使用无凭据临时 home，仅允许 initialize/model/list、不可达 loopback provider、总时限与进程清理；系统禁止网络时仍实测成功。它是安装包目录，不是动态账号可用性证明。
- 修改通过 `thread-follower-update-thread-settings` v2，仅发送 `threadSettings.effort`，不传 activeTurnId。先核对原 thread/owner 和完整设置指纹，原生 condition 使用 raw model/effort；回读有效强度，并确认型号、provider、模式、目录与权限绑定未变。原生 condition 不是完整状态 CAS，因此保留前后指纹校验，不承诺外部任意修改的全局原子性。

跨型号切换本轮关闭。10-02原型曾实测切回 Astra 后出现 `invalid_encrypted_content`；当前网关仍保留加密推理，未证明已有通用修复。旧临时密文兼容项、旧 `model_changes` 账本和旧请求都不复活。详见[原实验](../research/2026-10-02-model-selection-experiment.md)。

## 回执和并发

接口为 `GET/POST /api/tasks/:id/model-settings`，回执核对为 `GET /api/tasks/:id/model-settings/:requestId`。沿用机器路由、认证、同源和 CSRF。每次修改先持久化 requestId 与输入指纹，重复相同请求只返回原回执；跨会话或不同输入复用编号拒绝。

提交前崩溃且 provider 尚未持久化，能确定没有派发，恢复为 rejected；一旦可能派发则保留 unknown，GET 只核对、不重发。手机关闭/刷新后仅用按机器隔离的 threadId/requestId 恢复，不丢掉编号重新提交。真正未决期间暂停该会话的派发、归档和重命名；待发正文可继续保存，不删除或自动重放未知消息。

## 验证与取舍

1004项完整回归和构建通过；两浏览器、390px手机触控流程78项通过，覆盖显示、保存、未知核对、关闭/刷新、机器/会话隔离与迟到响应。WebKit 的原生 select 曾忽略 min-height，现显式设44px高度。并发回归还复现状态订阅写出与进入 try 之间的取消窗口，已把订阅纳入原finally清理。

原生只读实测能准确读取 Astra Ultra；独立 Core 的窄设置写入保持模式、注入指令和权限。真实会话修改与两机发布结果以 CURRENT 为准，不能把上述隔离结果当作真机验收。证据 `.local/qa/model-settings-2026-10-18/`，独立组件证据 `.local/qa/model-ui-2026-10-18/`；iPhone主屏幕仍待实际使用反馈。

本轮后续真实验收：新建专用空白会话后，格得API将未指定强度设为High，原owner和回执均确认；型号保持Astra，消息数和tokens均为0。该新对象没有先前用户设置需要恢复，验收后通过Codex原生工具归档，原用户会话未用于试改。公网认证GET确认当前开发会话的Astra Ultra，以及格得/豌豆两机归档会话的saved投影；未猜测豌豆归档记录中为null的强度。豌豆只做目录与实际设置只读，没有真实写验收。

发布源码 `127985cd42f992704bf645d51cbe1f597c00d702`，两机API均更新；Pages `71252841-7ec0-46a2-a623-7fc5d55d609c`，build `74774c4f79ee14e8ccd2ede64ed612ae655785395e5f6674a1f439691128bb4e`，21文件和功能检查通过。原用户/操作数据保留，来源缓存新增模型投影和同步时间，新QA导航记录与生命周期/设置回执单独核对。私有回执为 `live-settings.json`、`public-read.json`、`ged-data-preserved.json`、`remote-upgrade.json`。

官方依据：[model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist)、[模型与思考强度](https://learn.chatgpt.com/docs/models)。可选强度取当前安装包返回值，不硬编码型号候选。

## 2026-10-20：新会话保留默认强度

用户发现Pocket新建后显示Astra中档，而格得默认是Ultra。实际检查全局配置为Astra/Ultra，最近Pocket新建会话的强度列为null；隔离官方CLI复现`thread/start`返回Ultra，但空会话物化和独立读取后model/effort未持久化。因此不能用创建响应或全局默认证明会话已经保存Ultra，也不能仅凭UI默认档位推断每次模型请求的实际强度。

创建器现在把`thread/start`返回的有效model与reasoningEffort保存在本次私有回执`expectedSettings`中。完成原有空会话物化后，调用官方`thread/settings/update {threadId, model, effort}`，退出创建进程，再由独立读取与只读SQLite核验实际保存的值。这个顺序经过验证：在物化前写入仍会丢失。配置由目标CLI按所选cwd/project解析，不从另一台电脑或最近打开的会话抄值，不硬编码Ultra；当前格得默认Ultra，豌豆默认XHigh。

设置更新只追加原生`thread_settings_applied`元数据；验空允许同会话/cwd/预期model/effort的这类事件，仍拒绝任何用户/模型消息、其他会话设置或错误值，要求0用户事件、0tokens。新回执schema2缺少默认设置检查点、写入未确认或结果不匹配都不能结案；恢复只读原ID，不重新创建或重发设置。已成功旧回执继续按旧语义读取，不覆盖用户后来设置。首条Query仍等到创建器返回created+verified+processStopped后才进入原队列。

本机真实CLI16项聚焦协议回归、独立验空4例、1070项完整回归与构建通过。覆盖Ultra/high/none/null、命名/项目、配置改动后resume保留原值、已写入丢回复只读恢复、写入前失败和缺检查点不发送首条消息；原provider/cwd/权限保持，0模型执行。证据 `.local/qa/create-effort-2026-10-20/`；远端兼容和两机实际发布结果待后续回读补充。本轮没有前端变更，公开build保持`a5a6295f4507e7d5d5c93b20538995a6f635f90ffaf86fd88e0ff57b7670c288`，无需重传Pages。
