# 桌面升级后的兼容判断

2026-10-13。记录此次取舍与证据边界；当前运行、发布和完整验收结果见 [CURRENT](../../CURRENT.md)。

## 触发问题

Codex 升到 `26.1007.30912:20156` 后，Pocket 在连接原 owner 前因配置仍为 `26.1007.21159:20052` 返回 `app_version_changed`。App 发布号变化不等于协议变化：本轮对照的新旧协议模块 SHA-256 相同，均为 `72e2b366d574206f76fc079c79b64c31ce378970a797475ded8709908d338f08`；内置 CLI 仍为 `codex-cli 0.162.0-alpha.17.2`。

[10-10 修复](../research/2026-10-10-desktop-upgrade-compatibility.md)曾更新精确版本配置并完成真实收发。此次取消 App 发布号门槛，让后续只变发布号的升级能继续接受运行时核验，历史取证与当时的验证范围仍保留。

## 两条独立契约

| 路径 | 兼容依据 | 未通过时 |
| --- | --- | --- |
| 原任务历史、运行状态、发送、停止、压缩、审批与已读同步 | Codex bundle 身份、原 socket、固定 IPC 方法/快照版本、响应与 owner 归属；继续核对各操作消费的状态和原请求 | 拒绝受影响操作；已派发但结果不明仍为 unknown |
| 新建、改名、归档/恢复与模型目录读取 | 实际包布局与资源目录内的可执行文件、可运行的Codex CLI、真实RPC/持久结果及既有业务前置条件 | 合法但未在验证集合的版本仅告警并继续；探针或实际操作失败按真实结果处理 |

App 发布号保留为诊断信息。`config/desktop-bridge.json` 只配置路径；IPC 验证复用 FBT `app_ipc.py` / `contracts.py`，Pocket 在 `bin/desktop-bridge.py` 补充 runtime、请求列表、待确认提交、activeFlags 与 turn items 等消费状态检查。仍保留固定协议版本，未知结构或不明确的执行状态不能取得发送许可。

CLI 路径发现不再从 App 发布号推导，并区分启动入口和实际进程位置。10-13最初使用独立验证集合决定准入；10-30用户明确要求把“未验证版本”由block改为warn，替代该旧取舍。`bin/bundled_cli.py`中的集合现只决定是否发出诊断，不再决定能否尝试。版本字符串格式正确或路径存在仍不证明管理语义兼容，成功须由真实RPC与持久结果核对。原任务IPC接续独立判断。

## 输入与派发边界

协议不兼容时显示具体连接原因，保留草稿、已保存历史与待发消息；只要原任务和 Mac API 可用，仍可保存入队。实际发送、停止、压缩和自动出队暂停，不能从缓存历史取得执行许可。新鲜 `source=desktop`、`resumeState=resumed` 状态可清除较旧的连接失败；旧账本中的 `app_version_changed` 继续作为未通过兼容检查处理。

原 thread/owner、模型、cwd、权限继承，发送前回读与 requestId/revision/指纹约束保持。pending/unknown 不因升级、重连或新错误自动重放，也不因兼容检查通过就视为执行完成。

## 证据与重开条件

本轮私有证据入口为 `.local/qa/version-contract-2026-10-12/`。其中 `before.json` 记录发布号误拦截；`after-bridge.json` 记录修复后原任务只读快照为 `desktop/resumed` 且 `canSend=true`。协议模块相同与只读快照通过支持本次判断，不能单独证明消息已送达、浏览器草稿已保留或产品已上线；这些分别回读并记入 CURRENT。

未来出现未知IPC版本、owner/响应归属不符或消费字段变化时，按对应路径重新核验。App/CLI发布号继续只是定位变化的线索；真正的内部协议变更仍可能需要适配，不承诺未来版本自动兼容。

## 2026-10-30：未验证CLI只告警

XML显示修复的全量检查读到`codex-cli 0.166.0-alpha.5.1`，旧门槛在metadata RPC前拦下38项原生协议测试。用户明确要求仅warn、不block。本轮保留包身份、资源内路径和可执行性检查；`--version`成功且输出合法、有界的Codex CLI SemVer后，即使不在历史验证集合中也返回实际版本并继续。空/畸形/非Codex输出、非零退出、超时和执行失败仍是`bundled_cli_unavailable`，不能伪装可用。

告警为stderr单行`POCKET_BRIDGE_WARNING_V1` JSON，仅含`code=unverified_cli_version`和`cliVersion`。写入使用有效stderr FD的有界`os.write`；没有FD或写入失败就跳过，避免TextIO在broken pipe后退出二次flush导致exit120，不落到承载结果的stdout。`runBridge`只提取有界已知字段、按版本去重且每调用最多4条，写服务诊断日志；不改API结果、不弹前端提示，日志sink异常不能影响操作。PHASE标记仍独立决定预派发与unknown边界，旧未知请求不因此重放。

本机0.166隔离协议确认no-op resume不再重复写相同设置：rollout两条记录及SHA保持。相关测试改用官方RPC真实变更设置再恢复，继续验证多条纯设置记录可归档，以及旧fingerprint在真实变化后拒绝派发；未删除这些断言或修改产品安全逻辑。`effort:null`并非清除操作，未设置强度的样本用模型往返保留null；模型端点固定127.0.0.1:9，无模型轮次。测试从机器的`readBridgeConfig`读取解释器，兼容豌豆私有路径。

执行与发布结果回CURRENT，证据在`.local/qa/cli-version-warning-2026-10-30/`。本次改变的是版本准入策略；真实权限、归属、指纹、响应和落盘核对保持。

固定候选完整1,882项通过。独立复核覆盖未知版本只派发一次、重复请求不再次写入、不可用探针不进入dispatch，以及服务日志白名单/去重/上限和sink失败不改变真实结果。broken-pipe整进程回归已关闭exit120缺口；0.166下真实设置往返保留无模型轮次、原模型/强度与旧指纹拒绝的断言。两机发布完成后记录实际源码与PID，不能把本机隔离测试视为远端应用已更新。
