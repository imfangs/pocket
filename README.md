# 任务架 · Codex Navigator

为大量已有 Codex 会话保留归属和接续入口。本机使用：**https://threads.local**。

手机 PWA 与 `x.fangs.cc` 固定入口的实现、口令文件、连接器和发布方式见 [docs/MOBILE.md](docs/MOBILE.md)，实际就绪状态以 [CURRENT.md](CURRENT.md) 为准。

## 使用

- 默认按「最近活动」排序，在「原版置顶」也可以切换排序；搜索标题、来源项目、目录和接续说明。
- 「我的分组」支持新建、改名、颜色、排序位置、上级分组和折叠；可拖动任务加入，也可勾选多条后批量归组。
- 选中任务，在「会话」查看最近的用户消息和可见回复，支持 Markdown 表格、列表、引用和代码块；可手动刷新，页面可见时每 8 秒更新。空闲的原任务可直接发送文本 query；未加载时先连接 Mac 中的原任务。
- 手机上可向左滑动详情返回列表，未发送草稿保留；输入时详情随软件键盘调整可见区域。
- 在「整理」写接续说明，标记正在推进 / 稍后继续 / 留作参考，并设置可选回顾日期。点保存，或切换任务时由界面先保存。明确标记的任务即使在原版归档，仍保留在相应意图视图。
- 「在 Mac 打开原任务」用原 thread ID 请求官方 App。运行与审批继续由原版负责，网页提交继承原模型和权限，见 [会话接入说明](docs/CONVERSATION.md)。
- 「数据与备份」可导出/恢复整理结果。横线分隔符默认只在任务架隐藏，原版记录保留。

首轮已从原版读取项目和置顶，建立独立分组；另外把三条明确的游戏任务加入 `side / 游戏`，没有替用户判定它们的接续状态。完整验证与当前限制见 [CURRENT.md](CURRENT.md)。

## 运行

Node 26（使用内置 SQLite）、npm。代码与运行依赖不包含模型服务。

实时历史与 query 的桌面桥接另需 Python 3 和本机 FBT IPC 模块，路径与支持的 App 版本在 `config/desktop-bridge.json`。缺少桌面连接时可尝试显示只读落盘历史；发送保持不可用，不另启 Agent 接管任务。

```sh
npm ci
npm run build
npm test
npm start
```

直接地址 `http://127.0.0.1:4397`。后台服务、HTTPS 和双栈域名由 FBT local 管理：

```sh
/Users/fangs/workspace/fbt/bin/fbt local status --config /Users/fangs/workspace/side/codex-navigator/config/local-service.json --json
/Users/fangs/workspace/fbt/bin/fbt local restart --config /Users/fangs/workspace/side/codex-navigator/config/local-service.json --json
```

前端开发可 `npm run dev`，API 服务须运行。开发服务器代理仅供本机；产品验收用构建后的正式地址。

## Agent 入口

```sh
node /Users/fangs/workspace/side/codex-navigator/bin/navigator.mjs list --query 游戏 --json
node /Users/fangs/workspace/side/codex-navigator/bin/navigator.mjs groups --json
node /Users/fangs/workspace/side/codex-navigator/bin/navigator.mjs annotate 原会话ID --intent later --note-file /绝对路径/note.txt --json
node /Users/fangs/workspace/side/codex-navigator/bin/navigator.mjs backup /绝对路径/navigator-backup.json --json
```

`annotate` 只更新所给字段，原版数据只读。CLI 与网页经过同一服务，不另开 Agent。HTTP 契约见 [架构文档](docs/ARCHITECTURE.md)。

## 数据与恢复

默认整理数据：`~/Library/Application Support/CodexNavigator/navigator.sqlite`，自动 JSON 备份位于相邻 `backups/`，保留最近 50 次。首次导入、刷新和 App 重启都不会覆盖已编辑的接续说明或分组。界面导出的 JSON 包含分组与备注，不含完整聊天记录；恢复时先备份现有整理，再用事务替换。

数据、截图和测试回执不进 Git。源码保存在当前项目，可重新安装；换电脑需另行恢复原 Codex 会话，任务架备份不代替原会话备份。

可用 `NAVIGATOR_DATA_DIR` 和 `NAVIGATOR_CODEX_HOME` 指定隔离数据目录和来源，适用于合成测试。不要将测试环境指向真实来源做写入测试。服务只监听 loopback，不用于公网/多用户部署。
