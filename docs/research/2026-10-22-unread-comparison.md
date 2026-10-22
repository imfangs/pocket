# Happy / HAPI 能否解决 Pocket 的已读同步

2026-10-22。方帅澄清 Claude 接入暂缓，当前目标仍是优化 Codex 接入；本轮专查未读/已读，不新增多 Agent 开发任务。

## 结论

**本次核查的 Happy/HAPI 主路径没有解决“手机客户端读完后，同步清除 Codex Desktop 原生蓝点”。** 它们维护自己的客户端阅读状态；不能因为能连接 Codex，就推定也同步了 Codex 的原生已读。

Pocket 当前故障主要落在原生写回/通信层。页面是否真的读到最新内容、阅读凭据和请求账本已经有实现；替换成竞品的本地未读标记，不会修通这条写回链路。

## 它们实际怎么做

| 项目/客户端 | 已读未读的实际来源 | 何时清除 | 同步范围 |
| --- | --- | --- | --- |
| Happy Web/Expo、Android | 客户端内存中的未读集合；主要在“此前忙碌/有请求 → 现在在线空闲”时加入 | 当前会话成为查看对象时清除 | 本客户端；不是服务端阅读水位 |
| Happy 原生 iOS | 本机 SQLite 的 `session.unread` | 进入聊天时调用本地 `markSessionRead` | 本设备持久化；未找到跨设备已读写入 |
| HAPI Web | `updatedAt > lastSeenAt`，另有手工未读版本 | 会话选中、页面可见、更新时间已知就推进水位 | localStorage；同源标签通过 storage/custom event 更新，不是跨设备合并 |
| HAPI 原生 iOS/Android | 相同 last-seen 模型，本地状态/可选 JSON 快照 | 观察所选会话较新的更新时间后标读 | 本设备；本进程串行/CAS 不等于跨设备一致性 |

源码链路：Happy 的 [未读生成](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/storage.ts#L789-L809)、[本地标读](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/sync/storage.ts#L1647-L1680)、[页面可见 hook](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-app/sources/hooks/useSessionVisibility.ts#L12-L33)；HAPI 的 [未读判定](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/lib/sessionAttention.ts#L9-L15)、[标读触发](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/hooks/useSelectedSessionSeen.ts#L1-L19)、[本地写入](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/lib/sessionLastSeen.ts#L263-L290)。

客户端差异来源：[Happy iOS 本地 SQL](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-ios/Sources/HappyStore/LocalStore.swift#L252-L257)、[Happy Android](https://github.com/slopus/happy/blob/1a643badd1b4a5043f5316af0821402c770e55b6/packages/happy-android/app/src/main/kotlin/com/slopus/happy/ui/home/SessionReadState.kt#L24-L73)、[HAPI iOS](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/ios/Packages/HapiKit/Sources/HapiClient/Stores/LastSeenStore.swift#L30-L82)、[HAPI Android](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/android/core/data/src/main/kotlin/app/hapi/data/store/LastSeenStore.kt#L31-L95)。

这里有两个容易误判的点：

- HAPI 的 `useUnseenBlockCount` 确实感知是否在历史位置，并按稳定消息/块身份统计“下面有新内容”；但它与列表的 `markSessionSeen` 是独立链路，不负责 Codex 标读，也不构成完整未读计数。[具体边界](https://github.com/tiann/hapi/blob/5d8deb201189dc1f183c4f5bf38c87ec4d34dd70/web/src/chat/unseenBlocks.ts#L84-L105)
- 页面 visible / app-state 上报主要用于通知路由，不是服务端已读水位。不能把“这台设备在线且正在看”与“这个版本确实读完、原生已确认”合并。

## 可以借，但不解决当前阻塞的部分

1. **HAPI 的水位单调推进**：`max(old, observedVersion)` 防止顺序到达的旧观察覆盖新观察；手工未读另存版本。可以借它的状态定义和迟到响应样例。但其 Web 存储是读整表再写整表，没有跨设备原子合并；`updatedAt` 也不是最后可见消息的精确身份。
2. **Happy 的完成待看信号**：用完成边沿减少工具/token 更新带来的提醒噪声。Pocket 已把运行、等待操作、原生未读分开，无需用这个信号替代原生状态。
3. **HAPI 的稳定 anchor**：适合正文底部的新内容提示。它不会让原生写入成功，也不能取代 Pocket 的可见内容凭据。

两者“打开或选中即可已读”的条件比 Pocket 已确认的要求宽。Pocket 继续保留“最新内容实际显示、旧滚动位置不清新消息”的约束，不以改成本地隐藏来宣称双端同步完成。

## Pocket 本轮只读复核：重启已发生，重复监听仍存在

旧事实见 [10-20 对照](../design/2026-10-05-read-state-sync.md#2026-10-20-再次复现与精确补齐)：同一受控对象上，Codex 官方 setter 能更新原状态，Pocket v3 广播返回 `readback_unconfirmed`；同进程存在两个同路径真实 listener。完整路由归属与因果当时尚未通过恢复对照确认。

本轮有新的当前证据：

- 当前磁盘 App 仍为 `26.1013.40934:20770`，主进程已于 **2026-10-22 04:10（Asia/Shanghai）** 启动，已不是 10-20 那个进程。因此“尚待第一次完整重启”已不是当前状态。
- 只读枚举当前主进程 socket，并复用既有 `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)` 探针，确认 **两个同路径 socket 的 SO_ACCEPTCONN 仍为 true**，不是把普通客户端连接误当 listener。
- 只读查询 Pocket 的 `read_state_receipts`：该进程启动后，截至本次查询，**25 条 `unknown/readback_unconfirmed`**；另有 1 条 `read`、1 条 `read_in_progress`、1 条 `observation_changed_after_write`。这里计数是回执，不是独立用户或独立会话数；单条 read 也可能来自已读核对，不能证明广播通道恢复。

**可支持的判断**：重复监听现象在新进程里再次出现，且同一时段仍有大量原生未确认回执；这继续支持调查 IPC 路由/写回层。“重新启动一次”不能单独作为稳定修复方案。它仍是与 router 分裂相符的证据，不是两条 listener 与每条失败之间完整因果已经证明。

本轮没有置未读、标读、重启 App/服务、变动 socket、改 Codex 原存储或真实会话。只读证据保存在 `.local/qa/unread-research-2026-10-22/current-listeners.json` 与 `read-only-receipt-summary.json`。

## 后续修复应针对什么

修复目标继续是 **Pocket 的已验证阅读凭据 → 可达的 Codex 原生 read-state owner → 原生持久状态与两端界面独立确认**。

下一次进入修复时，优先沿当前主进程复用原生 setter/IPC 的受控差分验收，定位主进程标读订阅与当前 socket 所在路由；同时检查有无受支持、可确认结果的另一条原生入口。当前没有新的已验证替代 setter，因此不能承诺只改 Pocket 的水位算法就能解决。若做启动恢复对照，应验证监听、消息路由和原生写回三个结果，而非仅记录重启成功。

两个开源项目提供的是客户端阅读模型的参考，**没有提供可直接接入的 Codex Desktop 已读桥接修复**。因此无需为此迁入它们的 hub/runner 或换一套客户端状态库。

## 取证范围

Happy 固定 `1a643badd1b4a5043f5316af0821402c770e55b6`，HAPI 固定 `5d8deb201189dc1f183c4f5bf38c87ec4d34dd70`。两棵 Git tree 均完整返回；39 个选定文件的 Git blob SHA 与固定 tree 对应，主侧另回读了关键 setter/触发/本地持久化代码。没有全仓字节级穷尽审计，结论限定于核实的读写链。上游测试只阅读，未运行。

详细源码笔记留在 `.local/research/2026-10-22-upstream-unread.md`。本报告及项目方向记录是本轮交付，不代表原生已读同步已修复。
