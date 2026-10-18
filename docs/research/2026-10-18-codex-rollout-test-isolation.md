# Codex 无效会话恢复：Pocket 测试隔离修复

2026-10-18。方帅报告 Codex 偶发 `no rollout found for thread id aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa`。

## 结论与证据

已安全复现的触发源是 Pocket 通知 HTTP 测试：合成 thread ID 意外进入真实 macOS opener。Codex 随后按这个不存在的 ID 恢复会话，产生报错。

- 本机保留的 Codex 日志中，收尾查询累计 71 次该错误的 `thread/resume` 请求全部使用此合成 ID（首轮扫描为 69 次）；未找到其他 ID 的同类 resume 失败。最新一组发生在 08:24:52，早于 08:27 完成的 fixture 修复。另有 archive/delete 失败，操作不同，不合并归因。
- 10-18 北京时间 08:21:36、08:22:38 的日志显示界面进入 `/local/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa`，随后本机 `thread/read`、`thread/queue/list`、`thread/resume` 失败。
- 只读查询当前 `state_5.sqlite`、sessions 和 archived_sessions，均无这个 ID 的会话；global state 中只有本次用户报错文本提及它，没有找到持久化导航状态引用。
- 安全复现预加载拦截器，在系统进程启动前捕获 `execFile('/usr/bin/open', ['codex://threads/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'])`。业务测试仍显示通过，新增根级 hook 因这次真实 opener 尝试失败，退出码 1；没有实际打开 App。

这些证据确认了一个可重复触发同一报错的本地测试漏洞；未逐一关联全部历史报错的发起进程，不据此推断所有 Codex 恢复错误都有相同原因，也没有证据表明本次是假 ID 对应的真实聊天数据丢失。

## 调用链

1. `tests/notifications.test.mjs` 的 `direct and queued HTTP sends register notification tracking without opening history` 使用合成 ID，旧 fixture 未注入 `openThread`，模拟 history 缺少 `resumeState: 'resumed'`。
2. HTTP `enqueue:true` → `DesktopService.send` → `connectForSubmission` → `connect(id, { open: false })`。
3. `recoverConnection` 首次读取模拟 history 后不能确认 owner 已恢复，于是调用 `openThread`。
4. `makeApp` 的默认 opener 执行真实 `/usr/bin/open codex://threads/<id>`。

通知用例自 2026-09-29 的 `408613c0` 存在；2026-10-05 的 `7233fbe0` 引入排队后自动连接。重复跑完整回归会重复走到这个遗漏的边界。

## 修复与验证

- 通知 fixture 使用临时 Codex home，显式注入 opener spy，并返回正确的已恢复 owner 状态。
- 用 HTTP `/connection` 回读 `connected`，确认直接发送与排队通知跟踪仍正常，opener 调用数为 0。
- `npm test` 预加载 `tests/helpers/block-native-open.mjs`，阻止 Node 通过 `execFile`、`execFileSync`、`spawn`、`spawnSync` 直接执行 `open` 或 `/usr/bin/open`。根级 hook 会令被业务代码捕获的启动错误仍使测试失败。
- 拦截器保留 `execFile` 的 `util.promisify.custom` 契约；初版遗漏此点，独立评审及全量回归发现后已修正。允许的子进程 stdout/stderr 行为已实测。
- 通知、队列、连接恢复的 43 项相关测试通过；最终 `npm test` 956 项通过，0 失败，未发现真实 opener 尝试。没有产品运行时代码改动，无需构建或部署。
- 本次未修改 Codex 数据库、global state 或 rollout，未重启 Codex/Pocket，未发真实模型消息。测试临时服务和目录随用例关闭清理。

隔离保护覆盖上述 Node 直接调用和 `npm test` 入口；裸 `node --test`、旧 `.local` 手工 QA fixture、shell/Python 间接启动不在该保护范围。旧 fixture 有相似缺口，但本次未发现仍在运行的证据，未扩大修改范围。

私有现场摘要及最终回归日志：`.local/qa/codex-rollout-2026-10-18/diagnosis.json`、`npm-test.log`。

## 官方资料核对

- [App Server：恢复持久化会话](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)：`thread/resume` 使用此前保存的 `thread.id` 继续 stored session。
- [官方排障与日志位置](https://learn.chatgpt.com/docs/reference/troubleshooting#feedback-and-logs)：区分桌面日志、sessions/archived_sessions，以及 App 内置 CLI 与独立 CLI 版本。

官方文档没有直接命中这句错误或确认某版本修复；本次根因来自本机日志、源码与受控复现。
