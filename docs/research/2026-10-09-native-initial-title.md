# 空名新任务的原生命名

2026-10-09。方帅反馈 Pocket 留空名称创建并首发后，列表一直显示首条 Query，未出现 Codex App 的自动拟名。

## 根因与修复

创建接口省略 `name`、原持久名称为 `null`，只能说明没有预设名字。它不等于后续原桌面一定会触发拟名。此前生命周期与创建反馈记录未实际验证这一阶段。

当前版本的普通 `thread-follower-start-turn` 会调用原 owner 的 `startTurn`，来源为 `direct`。原轮次接受成功后，`Ycn.didStart` 同时检查原角色为 `owner`、当前 `title == null`、`context.threadStartKind != null`，才发出 `InitialTitleRequested`。Pocket 复用的 `AppIPC.start` 只传 `inheritThreadSettings: true`，缺少最后这个条件。

`bin/desktop-bridge.py` 现在只在第二次原 owner 快照确认以下条件时，给原普通发送 context 补充 `threadStartKind: "default"`：

- 原历史已读到最早处（`turnsPagination.hasLoadedOldest === true`），且没有任何轮次；同时支持 legacy 与 canonical 历史。
- 原标题为 `null`，任务为普通用户/default 类型，无临时、side conversation、父任务或 fork 标记。

其余发送继续调用原 `AppIPC.start`。同一 thread ID、owner、clientUserMessageId、原模型及权限继承保持不变，没有调用改名接口、增加命名消息或另建执行器。生成与持久化都由 Codex 自身的原服务处理。

原 owner 在轮次接受后还会重新检查当前标题；命名函数写入时使用 `expectedTitle`，因此期间已命名的任务不会被旧结果覆盖。本修复不补改已有用户历史任务。

## 当前安装包证据

只读核验 `/Applications/ChatGPT.app` 为 `26.903.71938:8576`，与 `config/desktop-bridge.json` 相符。从原 `app.asar` 提取的文件与 09-29 研究 SHA 一致；提取件只保存在 `.local/research/native-title-2026-10-09/`。

| Entry | SHA-256 |
| --- | --- |
| `webview/assets/app-initial-a9514281e192.js` | `038d28242240bb19fd90c7a380d80c6d23caaebc77a3ebb87ff6045bc49762c6` |
| `.vite/build/src-B6LqG3ek.js` | `9a1d9737c526cbba0e18e5ffc3b9371ef055318e7eabb7584b082fbcdb24472e` |
| `.vite/build/main-Bkkz0ENj.js` | `037076973c753515ef4329aa493f1072902cc638cbbcec788d81c87f392342f2` |

以下位置为 Python UTF-8 解码后的字符 offset，均在上述 webview entry 中，不是行号：

| 定位串 | Offset | 作用 |
| --- | ---: | --- |
| ``case`thread-follower-start-turn` `` | 2727698 | 普通 follower 请求调用原 `startTurn` |
| `startTurn(e,t,n){` | 3012953 | 原 `startTurn` 使用 `direct` 来源 |
| `function Ycn(` | 2870320 | `didStart` 的 owner、空标题、threadStartKind 条件 |
| `await C.didStart()` | 2931418 | 原 `turn/start` 接受成功后才请求初始标题 |
| `function Zvr(` | 4221401 | 注册初始标题监听器并调用原命名链 |
| `async function nlr(` | 4102140 | 原 `threadMetadataGeneration.generateTitle`、临时预览及条件持久化 |
| `async function rlr(` | 4103237 | 生成失败/空结果时保留首条文本摘要 |
| `async function Jzi(` | 5847038 | 普通桌面创建使用 `threadStartKind: default` |

原服务能力与普通 IPC 的显式改名仍是不同接口；本次发现不改变[显式重命名尚未接通的边界](2026-09-29-rename-and-open.md)。

## 验证与剩余边界

1. `node --test --test-name-pattern='first message in a confirmed empty' tests/desktop-protocol.test.mjs`：修复前 legacy/canonical 两种首发均失败，实际缺少 `threadStartKind`；证据 `protocol-red.txt`。
2. 定向首发、继承和排除条件回归 17 项通过，完整 `desktop-protocol.test.mjs` 50 项通过；证据 `protocol-green.txt`、`desktop-protocol.txt`。
3. `verify-native-gate.mjs` 直接执行已提取原包的完整 `Ycn` 函数，以真实 Python 桥接代码构造的合成 payload 驱动：旧 payload 产生 0 次初始命名事件，修复后 1 次；已有名、接受期间并发改名、follower 角色、nested 来源均 0 次。6 项通过，证据 `native-gate.json`。该 JSON 使用 JavaScript UTF-16 offset，和上表 Python offset 的计数单位不同。

以上验证没有新建真实任务、发送真实消息、调用真实命名模型或部署。真实新建首发后原名称落盘及双端展示的验收由本轮主任务统一记录；不能以离线事件触发替代实际命名成功。

同日主任务真实验收已补齐：新HTTP创建与首发路径仅提交一次，原name生成「验收 Pocket 快速新建标题」，匹配首条requestId的用户回显1次、回复POCKET_QUICK_TITLE_OK且轮次completed。随后使用原App归档并只读核对archived=1；原ID及完整回执在`.local/qa/quick-create-2026-10-09/native-live.json`。此结果证明本安装版本的原命名链实际成功，发布身份仍以CURRENT为准。

即使触发正确，原命名服务失败或返回空结果仍会回退首条文本摘要；App 升级或历史完整性未知时也不会强行补名。若复发，先分别核对原 `name`、首发时原快照的空标题/完整历史、发送 context 与原服务结果，不重放消息、不批量修改历史名。
