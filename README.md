# Pocket

把 Mac 上的 Codex 带到手机，随时查看对话、接着工作。本机使用：**https://threads.local**。

原名任务架 / Codex Navigator，2026-09-28 更名为 Pocket。仓库目录、服务与数据标识沿用原值，既有口令、分组、备注和备份继续使用。

手机 PWA 与 `x.fangs.cc` 固定入口的实现、口令文件、连接器和发布方式见 [docs/MOBILE.md](docs/MOBILE.md)，实际就绪状态以 [CURRENT.md](CURRENT.md) 为准。

## 使用

- 默认按「最近活动」排序，在「置顶」也可以切换排序；搜索标题、来源项目、目录和接续说明。
- 左划任务显示蓝色「置顶 / 取消置顶」，点击后只调整 Pocket 列表和置顶视图；置顶后自动采用置顶优先，Mac 原标记不改。桌面和键盘可用同一行的图钉按钮。
- 新建默认只显示 Query；目录、项目与标题放在「更多设置」，沿用上次有效选择。缺少必要选择时才展开补充，首条消息和创建过程持续保留回执。
- 「我的分组」支持新建、改名、颜色、排序位置、上级分组和折叠；可拖动任务加入，也可勾选多条后批量归组。
- 选中任务，在「会话」查看最近的用户消息和可见回复，支持 Markdown 表格、列表、引用和代码块；切回近期任务保留历史和阅读位置。运行中更新更快，后台暂停，联网或回到前台后立即恢复。空闲任务直接发送文本 query；运行中默认加入待发列表，当前轮完成后依次发送，支持编辑、删除和直接追加到当前轮。Pocket 待发列表保存在 Mac，与桌面的待发列表独立；读取暂时失败仍可在条件允许时保存入队，连接与实际派发重新核验原任务状态。
- 命令、文件改动、本轮权限审批和同步阻塞问题可在网页响应；展示原请求内容，由用户明确选择。MCP 自定义表单与未支持类型仍在 Mac 处理，见 [会话契约](docs/CONVERSATION.md)。
- 会话输入框旁的回形针可添加图片和文件，也可粘贴图片；支持纯附件消息、预览、上传核对和待发保留。文件直接传到Mac，图片交给原模型看，普通文件由原任务读取；每条最多6个、单文件20MiB，详见[附件发送](docs/design/2026-10-10-attachments.md)。
- 运行中可停止当前执行，待发消息保留并暂停，可手动恢复排队；异步选项问题支持直接选择或填写回答。
- 移动端以紧凑标题、对话和输入为主，上下文说明与压缩收进展开面板。
- 输入框随内容增高，长文到上限后内部滚动；可查看上下文占用，并在任务空闲时手动压缩；可以保留待发消息，压缩期间暂停出队。
- 手机上可在任务列表顶部下拉刷新；从详情页左边缘向右滑返回列表，未发送草稿保留；输入时详情随软件键盘调整可见区域。
- 在「整理」写接续说明，标记正在推进 / 稍后继续 / 留作参考，并设置可选回顾日期。点保存，或切换任务时由界面先保存。明确标记的任务即使已归档，仍保留在相应意图视图。
- 「在 Mac 打开原任务」用原 thread ID 请求官方 App。运行与审批继续由原版负责，网页提交继承原模型和权限，见 [会话接入说明](docs/CONVERSATION.md)。
- 「设置」可导出/恢复整理结果。横线分隔符默认只在 Pocket 隐藏，原版记录保留。

首轮已从原版读取项目和置顶，建立独立分组；另外把三条明确的游戏任务加入 `side / 游戏`，没有替用户判定它们的接续状态。完整验证与当前限制见 [CURRENT.md](CURRENT.md)。

## 运行

Node 26（使用内置 SQLite）、npm。代码与运行依赖不包含模型服务。

实时历史与 query 的桌面桥接另需 Python 3 和本机 FBT IPC 模块，路径与支持的 App 版本在 `config/desktop-bridge.json`。缺少桌面连接时仍可显示只读落盘历史；入队保存、显式重连尝试和已取得的发送许可分别处理，真正派发会重新核验原 owner 状态，不另启 Agent 接管任务。

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

数据、截图和测试回执不进 Git。源码保存在当前项目，可重新安装；换电脑需另行恢复原 Codex 会话，Pocket 备份不代替原会话备份。

可用 `NAVIGATOR_DATA_DIR` 和 `NAVIGATOR_CODEX_HOME` 指定隔离数据目录和来源，适用于合成测试。不要将测试环境指向真实来源做写入测试。服务只监听 loopback；已配置的手机入口经专用认证隧道访问，见 docs/MOBILE.md。多用户部署未验证。
