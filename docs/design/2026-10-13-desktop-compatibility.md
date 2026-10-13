# 桌面升级后的兼容判断

2026-10-13。记录此次取舍与证据边界；当前运行、发布和完整验收结果见 [CURRENT](../../CURRENT.md)。

## 触发问题

Codex 升到 `26.1007.30912:20156` 后，Pocket 在连接原 owner 前因配置仍为 `26.1007.21159:20052` 返回 `app_version_changed`。App 发布号变化不等于协议变化：本轮对照的新旧协议模块 SHA-256 相同，均为 `72e2b366d574206f76fc079c79b64c31ce378970a797475ded8709908d338f08`；内置 CLI 仍为 `codex-cli 0.162.0-alpha.17.2`。

[10-10 修复](../research/2026-10-10-desktop-upgrade-compatibility.md)曾更新精确版本配置并完成真实收发。此次取消 App 发布号门槛，让后续只变发布号的升级能继续接受运行时核验，历史取证与当时的验证范围仍保留。

## 两条独立契约

| 路径 | 兼容依据 | 未通过时 |
| --- | --- | --- |
| 原任务历史、运行状态、发送、停止、压缩、审批与已读同步 | Codex bundle 身份、原 socket、固定 IPC 方法/快照版本、响应与 owner 归属；继续核对各操作消费的状态和原请求 | 拒绝受影响操作；已派发但结果不明仍为 unknown |
| 新建、改名、归档/恢复 | 实际包布局与资源目录内的可执行文件；单独通过验证的 CLI 版本及既有业务前置条件 | 未验证 CLI 返回 `cli_version_changed`，等待针对性适配 |

App 发布号保留为诊断信息。`config/desktop-bridge.json` 只配置路径；IPC 验证复用 FBT `app_ipc.py` / `contracts.py`，Pocket 在 `bin/desktop-bridge.py` 补充 runtime、请求列表、待确认提交、activeFlags 与 turn items 等消费状态检查。仍保留固定协议版本，未知结构或不明确的执行状态不能取得发送许可。

CLI 路径发现不再从 App 发布号推导，并区分启动入口和实际进程位置。管理操作通过 `bin/bundled_cli.py` 的独立验证集合，目前包含 `codex-cli 0.153.4` 与 `codex-cli 0.162.0-alpha.17.2`。版本字符串格式正确或路径存在不能证明管理语义兼容；升级带来未验证 CLI 时，仍先拒绝这些操作，经隔离的创建/改名/归档恢复与持久结果验证后再扩展集合。原任务 IPC 接续独立判断。

## 输入与派发边界

协议不兼容时显示具体连接原因，保留草稿、已保存历史与待发消息；只要原任务和 Mac API 可用，仍可保存入队。实际发送、停止、压缩和自动出队暂停，不能从缓存历史取得执行许可。新鲜 `source=desktop`、`resumeState=resumed` 状态可清除较旧的连接失败；旧账本中的 `app_version_changed` 继续作为未通过兼容检查处理。

原 thread/owner、模型、cwd、权限继承，发送前回读与 requestId/revision/指纹约束保持。pending/unknown 不因升级、重连或新错误自动重放，也不因兼容检查通过就视为执行完成。

## 证据与重开条件

本轮私有证据入口为 `.local/qa/version-contract-2026-10-12/`。其中 `before.json` 记录发布号误拦截；`after-bridge.json` 记录修复后原任务只读快照为 `desktop/resumed` 且 `canSend=true`。协议模块相同与只读快照通过支持本次判断，不能单独证明消息已送达、浏览器草稿已保留或产品已上线；这些分别回读并记入 CURRENT。

未来出现未知 IPC 版本、owner/响应归属不符、消费字段变化或未验证 CLI 时，按对应路径重新核验。发布号继续只是定位变化的线索；真正的内部协议变更仍可能需要适配，不承诺未来版本自动兼容。
