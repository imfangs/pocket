# 会话重命名与打开原任务

核验日期：2026-09-29。已安装 Codex `26.903.71938:8576`，版本与既有适配一致。

## 重命名

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 明确列出 `thread/name/set`，可更新已加载任务或持久历史的显示名，并发出 `thread/name/updated`。这证明原版协议有能力，不代表 Pocket 能调用当前桌面的那条连接。

只读核验当前 app.asar：主进程的 updateThreadTitle 调用 setThreadName，最终通过原 app-server 连接发送 `thread/name/set`。Pocket 所用协调 IPC 的 follower 方法包含 start/steer/interrupt/compact/settings/审批/用户输入等，没有 rename/name/title 转发；settings 方法只转发 thread/settings/update，不能代替改名。Agent 当前任务的 set_thread_title 工具可用，但不等于独立 Node 服务能使用的常驻接口。App Tools 管道的既有签名边界见 [2026-09-28 记录](2026-09-28-peer-signing-boundary.md)。此次没有绕过签名、操作原数据库或另起 app-server。

用户明确选择“同步 Codex；接通后再做”。不实现独立于原任务标题的 Pocket 显示别名，不把存在官方协议或当前 Agent 工具等同于网页已支持。

## 在 Mac 中打开

原按钮“连接 Mac 中的原任务”调用项目 `/api/open/:id`，由 Mac 执行已有 `codex://threads/:id` 深链接，打开原会话并记录访问；之后前端刷新历史。该动作不是启动模型，也不是建立公网隧道。对未加载的旧任务有恢复价值；正常已取得 desktop 快照时隐藏。HTTP 返回 handoff_requested 仅表示已请求打开，是否恢复仍看随后实时快照。

按钮改为“在 Mac 中打开”，进行中显示“正在打开…”，提示明确为打开后重读实时状态。离线时禁用，不再让用户把它理解为每次使用前必需的配对步骤。
