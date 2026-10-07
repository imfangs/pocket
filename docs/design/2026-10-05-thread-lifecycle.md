# Pocket 新建、归档与恢复

2026-10-05。方帅明确要求让新建和归档会话在 Pocket 可用。

## 使用

- 列表头部点「新建会话」，选择已存在的工作目录，可选名称；创建完成后进入该会话。首条消息点「发送并连接」，仍由原桌面 owner 执行。
- 详情「整理」页提供「归档会话」和「恢复会话」。普通草稿、接续说明、分组及分类保留；普通列表不再列出真实已归档任务，归档视图仍可查找。
- 没有 writer 占用的已结束会话或空会话可以立即归档。归档包括原 spawned 子树；恢复只恢复指定主会话。
- 已结束但仍被 Codex 占用的会话显示「等待 Codex 释放会话」，持久保存请求并支持取消。未完成前原 archived 标志保持真实状态。请求期间有新内容或子树变化时停止本次归档，避免以后误归档新工作。
- 有待发正文、正在提交的消息/审批/压缩等操作时先处理现有操作。归档不删除待发正文，也不隐式停止模型。

创建后不立即打开 Mac，既能保留新会话的自然自动命名，也让用户可以直接归档尚未开始的空会话。第一次发送仍复用已交付的连接恢复与防重回执。

## 官方创建路线

固定桌面包 CLI `0.153.4` 与 App `26.903.71938:8576`。PATH 上的另一个 CLI 版本不作为此实现依据。

通过短生命周期官方 stdio 进程 `thread/start(ephemeral:false, historyMode:paginated)` 创建空会话。该版本必须显式物化空历史；带名称时 `thread/name/set` 后 `thread/read(includeTurns:true)` 可完成。无名称时，仅对固定版本的精确 `-32601 / list_turns is not supported yet` 分支继续核验：该调用已物化 session_meta，退出 creator 后另起官方 metadata-only read 补齐索引。其余错误不能当成功。

若选择了原项目，使用官方 `thread/metadata/update` 持久化 projectId。最后停止两个短进程，再独立核对 SQLite、原 ID/cwd/project、只有 session_meta、零用户事件和零 tokens；名称未填写时保持原 name=null，不强行命名“新会话”。本机模型、provider、审批与权限继承现有配置，没有启动模型轮次。

请求开始前先保存私有 checkpoint，拿到 ID 立即保存；相同 requestId 只核对同一回执和原 ID，不重复 thread/start。未知且没有 ID 时不新建第二条。实现与隔离回归在 `bin/create-thread.py`、`tests/create-thread-protocol.test.mjs`；研究证据 `.local/qa/empty-thread-research-2026-10-05/`。

## 归档与占用

`bin/archive-thread.py` 只读原 SQLite、rollout 与 writer 锁，用官方 CLI 完成归档/恢复；不直接修改 Codex 文件、不删除锁，也不发送虚假的 thread-archived 广播。

归档 fingerprint 绑定精确 root、全 spawned 子树的 ID、原归档状态、historyMode、内容 SHA 与字节数；不包含锁或 mtime，所以正常释放 writer 不会使请求失效。每次实际调用前再核对树、正文和真实锁，写后独立核对全树归档状态及原 SHA。root 已归档但子树不完整时明确报告 partial_subtree，不误报整次成功。

恢复只检查、修改和核对 root，不受缺失或正在活动的子任务影响。归档全树 fingerprint 与恢复 rootFingerprint 不混用。命令退出码和广播均不代替独立回读，模糊结果保留 unknown。

等待期间 Pocket 停止目标及子树的 owner 快照、连接恢复、派发与通知检查，正文仍可从保存历史读取。取消和后台 worker 按请求串行，取消完成后不会继续归档；已有原生写入则先核对实际状态，不把取消解释成撤销归档。

**当前原生限制**：普通 follower IPC 没有按 ID 立即归档/卸载的接口。renderer 无活动视图、followers 或需保留状态持续 1 小时后才 unsubscribe；原 App Server 再无订阅且空闲持续 30 分钟才释放 writer。其他窗口/客户端仍可能延长这一时间，因此不承诺固定等待时长。Pocket 不重启 Codex、不打断其他任务，也不通过受拒绝的 UI/签名路径强行释放。

共享 WebSocket 迁移会跳过当前 App Tools MCP 注入和原 owner/read-state IPC 注册，影响刚验证的发送、审批与已读同步，不作为本轮隐式替换。原始入口依据见 [09-29 控制面研究](../research/2026-09-29-desktop-control-entrypoints.md)。

## 状态与恢复

`lifecycle_operations` 与创建回执保存在 Pocket 私有数据目录。API 使用稳定 requestId，状态为 pending、waiting、succeeded、rejected、unknown、cancelled、changed。

客户端刷新后重新读取原操作；只有成功回读才更新真实归档状态。创建结果晚到时保留“打开新会话”入口，先保存当前整理内容再切换；不会抢走用户已选择的另一个任务。创建恢复的 sessionStorage 仅保存未决/待领取成功的 requestId，明确拒绝不会变成永远占位的 unknown。

确定尚未启动的创建失败直接拒绝；无法核对的 unknown 创建可明确「停止核对」，只停止 Pocket 跟踪，不删除任何可能已创建的会话，也不重新提交同一创建。pending 创建仍不能中途撤销。

## 验证

官方隔离测试覆盖无名/有名/原项目创建、检查点冲突与并发、未知不重建；归档覆盖空会话、真实 writer 锁释放、全子树/只恢复 root、子任务缺失或新活动及丢失回执。

真实本机 API 已完成：创建新空会话 → 立即归档 → 恢复同 ID → 首条消息接入原桌面 → 指定回显。原 Core PID 1837 持有新线程 writer，模型沿用 gpt-6-astra，轮次完成、0 工具调用。随后申请归档返回 waiting，正文仍可读、发送与接入被暂停，等待原生释放后自动清理。证据 `.local/qa/lifecycle-2026-10-05/live.json` 与 `live-native-proof.json`。

299项全量测试及构建通过。390px内置浏览器完成新建/首条发送、归档恢复保留草稿、等待取消/刷新恢复、释放后自动归档及创建回执恢复；两次点击仅创建两条，等待目标的owner读取计数保持不变，无页面错误或横向溢出。证据 `browser.json`、`tests-final.txt`；发布身份以 `CURRENT.md` 为准。未声称 iPhone 真机、长期待归档最终释放、其他版本或所有身份配置已验证。

## 公网回读

发布源码 `2aa2945`（主体 `f313c49`），Pages `cb50a1c4-5634-44c6-92e6-a82bd9f79b8e`，15个公开文件匹配且功能检查通过。公网未命名创建和随后的原归档都成功；原等待归档请求在服务更新后保留，之前的受控验收会话也已安排等待归档。证据 `public-live.json`；等待原writer实际释放的最终效果仍未提前声称完成。

首次发布在上传前遇到Cloudflare GET401；使用项目配置的Wrangler whoami续现有OAuth后成功，无新增授权范围。后续前端停止核对恢复修正作为新源码发布。鉴权恢复指引已回流到FBT Pages Site README。

## 2026-10-08 工作目录重复修复

原新建选项按 `[cwd, projectId]` 标识可用目标，却直接以项目名显示在「工作目录」下拉框。同一目录关联多个原项目会重复出现；同一项目的多个目录又会显示相同名称。只读实测为 82 个目录与项目组合、70 个规范化目录，其中 4 个目录关联多个项目。

现在先按完整规范化路径分组，每个目录只显示一次。同名目录补充最短可区分的父路径，选中后显示完整路径。一个目录只有一个目标时自动使用该归属；有多个归属时单独显示「归属项目」，须明确选择，切换目录后清除旧选择但保留名称。提交仍使用原始 locationId，保留全部原项目关联，不合并或修改 Codex 项目。后端先规范化真实路径，再排除项目已覆盖的历史/最近目录，避免尾斜杠或符号链接产生额外的无项目选项。

309 项全量测试通过；真实选项分组后有 70 个目录、70 个不同标签，原 locationId 全部保留。390×844 合成浏览器完成共享目录选择 Beta、切换目录清除归属、保留名称、返回共享目录重新选择并提交，唯一创建回执保持 Beta 的原 projectId；无横向溢出和页面错误。未创建真实会话或调用模型。证据在 `.local/qa/create-directories-2026-10-08/`；发布身份与公网回读以 `CURRENT.md` 为准。
