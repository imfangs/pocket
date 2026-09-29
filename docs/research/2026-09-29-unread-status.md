# Codex 蓝点与 Pocket「待我输入」

2026-09-29，只读核验。未打开原任务、发送消息、修改已读状态或 Codex 文件。

## 结论

标题右侧蓝点表示 **未读提醒**，不是所有 idle 任务，也不是严格的「成功完成」状态。当前桌面用 `hasUnreadTurn`；审批、提问、失败或手动标未读也可能置位。运行/加载图标有更高的显示优先级。因此 Pocket 应使用原未读集合，并排除有运行证据的任务；不能把无运行信息的所有任务直接解释为完成。

本机可用的低成本来源为 `.codex-global-state.json` 中的 `electron-thread-read-state-v1`，不需要为每条目录取 owner 快照。当前 `state_5.sqlite` 的 `threads` 表没有 unread 或运行状态列。

## 固定版本与第一方代码证据

安装版本 `/Applications/ChatGPT.app` 为 `26.903.71938:8576`。以下都是 `Contents/Resources/app.asar` 内文件，定位为解码后的字符 offset，而非行号：

| 文件 | SHA-256 | 关键位置 |
| --- | --- | --- |
| `.vite/build/main-Bkkz0ENj.js` | `037076973c753515ef4329aa493f1072902cc638cbbcec788d81c87f392342f2` | `MPe` read-state owner；`apply` 2582950；`D5` 身份哈希；`PPe` 当前身份/主机校验 |
| `.vite/build/src-B6LqG3ek.js` | `9a1d9737c526cbba0e18e5ffc3b9371ef055318e7eabb7584b082fbcdb24472e` | `bJ` 主机哈希 1078830；紧邻 `xJ` 身份生成；IPC 注册表 348662；`threadReadStateChanged` 1504233 |
| `webview/assets/app-initial-a9514281e192.js` | `038d28242240bb19fd90c7a380d80c6d23caaebc77a3ebb87ff6045bc49762c6` | `dan` 完成提醒策略 2796162；请求置未读 3042601；已读操作 3055160；`_Mi` 运行图标 5742479；`b$o` 图标优先级 8594377；`tns` 可见任务已读 8958411 |

schema 定义在 `.vite/build/window-all-closed-DnjtB60s.js` offset 523035：`version` 为 literal 1，`unreadByIdentity` 为 `Record<string, Record<string, string[]>>`；ID 元素为非空字符串。

本地公开源码 `study/codex` 的 App Server 协议和 state 模块未找到桌面 `hasUnreadTurn` 字段；这个状态由桌面层管理，不应假设 `thread/read` 就会返回它。公开源码只用于核对 rollout 生命周期事件，不以它代替桌面版本证据。

## 数据选择与身份隔离

现代结构：

```js
global['electron-thread-read-state-v1'] = {
  version: 1,
  unreadByIdentity: {
    [identityKey]: { [executionHostKey]: ['thread-id', /* ... */] }
  },
  legacyMigration: /* 迁移快照，不是当前读状态 */
};
```

主进程 `D5(identity)` 按下面的 JSON 数组取 SHA-256 hex：

- ChatGPT 身份：`[identity.kind, identity.accountId, identity.userId]`。
- 其他身份：`[identity.kind, identity.authMode]`。

`xJ` 从当前 `getAuthStatus` 响应生成身份：`authMethod` 为 `chatgpt` 或 `chatgptAuthTokens` 时解析认证主体；其他方法生成 `{kind:'execution-storage', authMode:authMethod ?? 'none'}`；认证必需但未登录则不可用。**磁盘 auth.json 只是当前部署的旁证，不能在身份切换后永远当作活进程的身份真相。**

本机当前 `auth.json.auth_mode` 精确为 **`apikey`**，其哈希 `sha256(JSON.stringify(['execution-storage','apikey']))` 命中现代结构的唯一身份。不是 `apiKey`，也不是 `api-key`。没有在报告中保存密钥、账号 ID 或实际身份哈希。

主机哈希 `bJ(host, websocketUrl)` 为 `${host.id}:${sha256(JSON.stringify(parts))}`：本机 stdio 的 parts 精确为 `['local','local',null]`，本次命中唯一执行主机。若改为本地 WebSocket，第三项变成实际 URL，不能继续使用这个 stdio key；远程 SSH/WSL/Remote 同样使用自己的连接标识。

纯函数适配伪码（当前版本/部署）：

```js
function readUnread(global, verifiedIdentity, verifiedHost) {
  const key = 'electron-thread-read-state-v1';
  if (Object.hasOwn(global, key)) {
    const state = global[key];
    if (!isValidV1State(state) || !verifiedIdentity || !verifiedHost) return unknown;
    const identityKey = sha256(JSON.stringify(identityParts(verifiedIdentity)));
    const hostKey = verifiedHost.id + ':' + sha256(JSON.stringify(hostParts(verifiedHost)));
    const ids = state.unreadByIdentity[identityKey]?.[hostKey] ?? [];
    // With a verified current principal and host, absent keys mean all read.
    // Never mix in another principal/host to replace this empty set.
    return {known:true, source:'desktop-v1', ids:new Set(ids)};
  }
  const ids = global['electron-persisted-atom-state']?.['unread-thread-ids-by-host-v1']?.local;
  return isStringArray(ids) ? {known:true, source:'legacy', ids:new Set(ids)} : unknown;
}
```

旧格式回退仅限现代 key **完全不存在**。`legacyMigration.unreadThreadIdsByHostId` 是一次迁移快照，绝不能在现代状态缺失/为空/身份不匹配时复活旧提醒。旧格式本来没有现代身份隔离；不应对不明身份声称完整兼容。读取后只向前端暴露每条任务的布尔标记/适配能力，不返回 auth 信息或全局 JSON。

空集合语义的精确证据：主进程 `MPe.open` offset 2580915，读状态取值在 2581283，使用 `c=state?.unreadByIdentity[currentIdentity]` 与 `(c?.[hostKey] ?? [])`。`apply` 删除最后一个 ID 时保留空 host 数组；`clearIdentityForLogout` offset 2583882 才删除整个 identity。新身份或主机也可能尚未写 key，因此只要当前身份/主机已核验，缺 key 是正常全已读；身份本身无法核验时才应未知。

## 蓝点与运行状态

`b$o` 的优先级为未读数量徽标 → `type:'loading'` 转圈 → `unread:true` 蓝点 → 无图标。`_Mi` 在以下任一条件返回 loading：有进行中的 owned work、runtime type 为 active、当前响应进行中；系统错误为 error；普通空闲为 idle。审批/用户输入的状态提示另外由 `vMi` 从请求及 `activeFlags` 算出。

`dan` 在 turn 完成时依通知/heartbeat/goal continuation 决策是否置未读；`DONT_NOTIFY` 的 heartbeat 不应被 Pocket 自行重新算成提醒。命令/文件/权限审批、阻塞提问、异步 App 问题等路径也可置 `hasUnreadTurn=true`。因此原集合才是入口，不能仅用最后一条 assistant 回复或 `updatedAt` 重建未读。

本次检查所有全局存储 key 的类型/名称及 SQLite schema，没有发现可用的全局运行集合。现有 IPC `thread-stream-state-changed` v11 是按任务订阅的快照或 patch，发给该任务 follower；`thread-stream-following-status-requested` 也要求 conversationId。注册表未见全局 runtime snapshot/list 方法。监听广播可积累以后发生的状态，但不能保证首次订阅时获得所有任务的完整现状。

**最小候选实现**：

1. 一次读取原未读集合，与现有目录的来源、非子代理、未归档条件相交。
2. 路径取只读 SQLite `threads.rollout_path`，仅对这些候选按文件 size/mtime 缓存有界 rollout 尾读；支持 `task_started`/`turn_started`、`task_complete`/`turn_complete`、`turn_aborted`。只解析 `event_msg.payload.type`，不输出正文。`context_compaction`/`compacted`/压缩摘要本身都不是任务生命周期，不可用它们判断已经结束。
3. 最新生命周期事件为 started 时先排除「已完成待查看」集合；没有终态不等于确认正在运行（也可能故障/尾读范围不足），保留 unknown。严格的完成筛选对尾读未知也暂不纳入，等终态或新鲜 owner 证据。不要扫描整个历史或为 100 条候选串行找 owner。
4. 已有新鲜原 owner 快照中的 active、pending request 与最新 turn 状态优先。普通 idle 且原 unread=false 始终不计入。

rollout 类型的第一方定义：`study/codex/codex-rs/protocol/src/protocol.rs:1404`（wire 名称/别名），`:2141`（TurnCompleteEvent，包括失败 error），`:2167`（TurnStartedEvent）；`codex-rs/core/src/tasks/mod.rs:790` 起区分完成、失败、中断并发出终态事件。因此 task_complete 是结束证据，不能额外声称执行成功。尾读仍是保存记录证据，不等同实时 owner 的运行状态。

## 何时清除与 Pocket 的边界

- 桌面 `markConversationAsRead` 调用 `setConversationUnreadState(false)`，同步内存 summary/已读计数，再写原 read-state owner；`tns` 的可见任务观察者及搜索结果点击会触发读取。
- 只读 follower snapshot 不调用 mark-read；Pocket 现有 history 与发送适配也没有发送 read-state 变更。因此 **在 Pocket 阅读并不自动等于原桌面蓝点清除**。不能悄悄写全局 JSON、把 Pocket 本地隐藏说成双端已读同步。
- 已存在原生读状态 setter 路径：IPC 广播 `thread-read-state-changed` **v3**，参数包括 `{hostId, conversationId, hasUnreadTurn, context:{identity, executionHostKey}}`。桌面主进程重新读取当前身份，校验身份、主机和 generation 后才接受。另一条为桌面内部 RPC read-state session `.set`。
- 这不是当前 `thread-follower-*` 命令方法；现有 Pocket bridge 未接入 context/session。后续若实现读状态同步，必须按版本和当前身份核验、用户真实阅读时才提交并独立回读，避免旧快照覆盖刚到的新完成提醒。本轮仅确认代码路径，未执行 setter；不能声称此接口已经完成真实兼容测试。
- 发送本身没有在本次查到的入口直接清除原未读；桌面一般因可见任务已读观察而同时清除。Pocket 请求 accepted 不应被当作已读回执。

## 本次不含内容的实测基线

只输出聚合数字，没有保存任务标题、正文或 ID：global JSON 1,141,878 字节；当前身份/主机原未读集合 107 条；经过现有顶层来源、非子代理及未归档条件后 6 条。JSON 解析加 SQLite 只读查询约 **24.26 ms**；再对这 6 条各读取末尾最多 256 KiB，全部最新生命周期事件为 `task_complete`，合计约 **31.02 ms**。这是一次本机暖缓存样本，不代表手机链路性能或长期耗时保证。

未进行真实标已读、发送、打开原任务或 iPhone 验证。动态状态随其他任务运行而变化；计数不是固定验收常量。建议 UI 验证分别覆盖普通 idle、完成未读、运行且保留旧未读、审批/提问、已读后再次完成、身份/主机不匹配及旧格式迁移。
