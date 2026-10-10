# Codex 桌面升级后的 Pocket 兼容修复

2026-10-10。方帅升级桌面端后反馈Pocket不能发送消息。

## 原因与复现

实际App为 `/Applications/ChatGPT.app`，bundle ID仍为 `com.openai.codex`，版本从 `26.903.71938:8576` 升到 `26.1007.21159:20052`。Pocket精确版本保护在连接owner前返回 `app_version_changed`。本机真实history接口因此回退到rollout、`canSend=false`，运行状态也不可用。公网连接器与Mac API健康正常。

最小复现为 `tests/desktop-protocol.test.mjs` 中的普通query提交场景：修复前没有accepted，更新兼容配置后通过。直接只读订阅原任务时，v11快照能确认resumed/active，说明现有连接协议仍可用。

## 新版证据与改动

读取已安装App的 `app.asar`，协议入口 `.vite/build/src-BJv5Mk7n.js` SHA-256为 `72e2b366d574206f76fc079c79b64c31ce378970a797475ded8709908d338f08`。协议表字符偏移7818，原owner的start handler仍接收turnStart；设置继承和消息标识字段保持。

| 接口 | 已核验版本 |
| --- | --- |
| initialize / owner discovery | 0 / 1 |
| following / snapshot | 1 / 11 |
| start turn / steer turn | 2 / 1 |
| read state / interrupt turn | 3 / 4 |

`inheritThreadSettings`、`clientUserMessageId`、首轮命名用的 `threadStartKind`、运行与等待状态字段均未改变。只更新精确版本配置，不取消校验，不改变模型、工作目录、权限或owner。

新版移除了旧 `Contents/Resources/codex`。`bin/bundled_cli.py` 按已验证版本解析两类路径：

- 创建/归档执行入口：`Contents/Resources/codex-cli/bin/codex`。
- 状态发现匹配的实际进程：`Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`。

CLI实际版本为 `codex-cli 0.162.0-alpha.17.2`。保留旧版本路径映射及原有精确CLI版本检查；未验证版本、缺失/不可执行文件或逃出App资源目录的路径保持拒绝。测试使用同一解析入口，避免继续依赖已删除的旧位置。

## 验证与生效方式

- 559项全量测试及生产构建通过。新版CLI在隔离空CODEX_HOME验证空任务持久化、可选名称、项目归属、幂等、新建回执、归档/恢复、子树、writer等待与未知结果核对；没有创建真实用户任务。
- 本机和公网history均恢复 `source=desktop`、`resumeState=resumed`、`canSend=true`；运行状态恢复available，公网观察到13条有效候选状态。
- 使用已有受控验收会话，经公网提交一次唯一requestId，准确用户消息与指定回复在同一原生turn回读；turn为completed，仅userMessage/agentMessage，0工具调用。该会话通过官方App接口临时恢复后重新归档，ID、模型、provider、cwd、权限和名称均与测试前一致。
- 配置与Python桥接按请求重新加载，已在原Mac API进程生效，无需重启Codex、Pocket API或连接器。前端产物未变，不重复发布Pages。

证据位于 `.local/qa/desktop-upgrade-2026-10-10/`：before-version/before-local、protocol-review-summary、protocol-asar-evidence、cli-regression、full-tests、after-local/after-public、echo-native-verification及canary-preservation。原始任务和回执标识仅留本机私有证据。此次证明API到原owner的发送恢复，不替代iPhone真机与长期网络验收。
