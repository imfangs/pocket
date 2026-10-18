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

官方依据：[model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist)、[模型与思考强度](https://learn.chatgpt.com/docs/models)。可选强度取当前安装包返回值，不硬编码型号候选。
