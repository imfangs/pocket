# Pocket

把 Mac 上的 Codex 带到手机，随时查看对话、接着工作。多机入口：**https://x.fangs.cc**；格得本机另配置 **https://threads.local**（当前在线状态见 CURRENT）。

原名任务架 / Codex Navigator，2026-09-28 更名为 Pocket。仓库目录、服务与数据标识沿用原值，既有口令、已保存数据及备份保持兼容。

手机 PWA 与 `x.fangs.cc` 固定入口的实现、口令文件、连接器和发布方式见 [docs/MOBILE.md](docs/MOBILE.md)，实际就绪状态以 [CURRENT.md](CURRENT.md) 为准。

菜单、登录、加载与PWA图标统一采用[同一份矢量Logo](design/brand/README.md)。

做类似操作类项目，或重新判断功能取舍与 UI 优先级时，参考[迭代复盘：操作类产品怎样做到顺手](docs/research/2026-10-11-pocket-interaction-retrospective.md)。文档覆盖创建以来的主线、可观察的顺手标准、功能精炼、UI 多轮打磨与小范围验证方法；早期构建过程保留在[09-29 复盘](docs/research/2026-09-29-pocket-build-retrospective.md)。

比较同类手机入口时，见 [ClawKit 与 Pocket 源码对照（2026-10-13）](docs/research/2026-10-13-clawkit-pocket-comparison.md)：区分原 owner 与共享引擎、功能入口和既有实测，列出可借机制及最小验证；研究建议未转为开发任务。

面向多人独立使用的候选方案见 [手机 App、电脑连接器与加密中继（2026-10-13）](docs/research/2026-10-13-pocket-multiuser-architecture.md)：对照 Happy 与官方 app-server，区分通用连接和原任务执行归属，尚未实施。

Claude Code 接入可行性见 [官方接口与 BotMux / Happy / HAPI 源码调研（2026-10-22）](docs/research/2026-10-22-claude-code-connectivity.md)：区分官方后台 attach、原终端桥接与 SDK 会话交接，包含本机只读接口核验及最小验证方案；尚未接入产品。

进一步的 [Happy / HAPI 源码借鉴（2026-10-22）](docs/research/2026-10-22-happy-hapi-code-lessons.md) 对照能力契约、重连补齐、长历史、审批与密钥分工，包含独立测试和不宜照搬的反例；采用顺序仍为研究建议。

## 使用

- 在菜单选择「格得 Mac」或「豌豆 Mac」，记住上次选择；各自的会话、登录、目录偏好与通知独立。切机前保护未完成输入，详见[多机连接](docs/design/2026-10-17-multi-machine.md)。
- 默认按统一Rank排序；搜索标题、项目和目录，菜单按项目切换列表。
- 左划会话可「优先关注 / 取消关注」，红星独立提高Pocket排序权重；Codex紫色图钉只读保留，两种标记可并列。桌面和键盘使用同一行的星标按钮。
- 新建默认只显示 Query；目录、项目与标题放在「更多设置」，沿用上次有效选择。缺少必要选择时才展开补充，首条消息和创建过程持续保留回执。
- 打开会话可直接阅读，历史和阅读位置保留；主动聚焦输入框或开始输入时预连接，不需要先找连接按钮。有内容直接发送或加入队列，空输入连接失败时同一按钮可重试。近期消息右下显示相对时间，完整时间仍可查。Pocket待发队列保存在Mac，与桌面队列独立；发送继续核验实际状态并防重。
- 命令、文件改动、本轮权限审批和同步阻塞问题可在网页响应；展示原请求内容，由用户明确选择。MCP 自定义表单与未支持类型仍在 Mac 处理，见 [会话契约](docs/CONVERSATION.md)。
- 会话输入框旁的回形针可添加图片和文件，也可粘贴图片；支持纯附件消息、预览、上传核对和待发保留。文件直接传到Mac，图片交给原模型看，普通文件由原任务读取；每条最多6个、单文件20MiB，详见[附件发送](docs/design/2026-10-10-attachments.md)。
- 运行中可停止当前执行，待发消息保留并暂停，可手动恢复排队；异步选项问题支持直接选择或填写回答。
- 移动端以紧凑标题、对话和输入为主，上下文说明与压缩收进展开面板。
- 同轮最终回复出现后，之前的过程消息收为可展开记录；当前问题仍可操作。上翻或选字时保持正在看的内容，回到最新后再折叠，手动展开状态在本次历史缓存内保留。
- 消息正文直接呈现，时间与复制位于右下角；全局操作提示使用紧凑的轻量样式，长错误说明完整换行。
- 输入框随内容增高，长文到上限后内部滚动；可查看上下文占用，并在任务空闲时手动压缩；可以保留待发消息，压缩期间暂停出队。
- 手机上在任务列表顶部下拉刷新，触屏手机隐藏重复的右上刷新按钮；无触摸桌面保留按钮。从详情页左边缘向右滑返回列表，未发送草稿保留；输入时详情随软件键盘调整可见区域。
- 详情直接显示对话；点击顶部会话标题打开「会话信息」，查看目录/项目、重命名或归档/恢复；「在 Mac 打开」仅在 Mac 浏览器出现。名称同步到 Codex 原会话，已归档的会话需先恢复再改名。分组、手工安排和备注编辑已移除，旧数据仍保留在本机。
- 「在 Mac 打开」用原 thread ID 请求官方 App。运行与审批继续由原版负责，网页提交继承原模型和权限，见 [会话接入说明](docs/CONVERSATION.md)。
- 「设置」保留主题/安装、通知，退出登录位于最底部。备份不再出现在网页；本机自动备份与 CLI 兼容能力保留。原横线分隔符会话默认显示。

原项目筛选、Pocket 优先关注及运行/待输入过滤继续使用。完整验证与当前限制见 [CURRENT.md](CURRENT.md)。

## 运行

Node 26（使用内置 SQLite）、npm。代码与运行依赖不包含模型服务。

实时历史与 query 的桌面桥接另需 Python 3 和本机 FBT IPC 模块，路径在 `config/desktop-bridge.json`。App 发布号仅作诊断，连接与派发按实际 IPC 契约和原 owner 状态检查；新建、改名、归档/恢复使用的内置 CLI 仍独立检查已验证版本。取舍与升级处理见[桌面兼容](docs/design/2026-10-13-desktop-compatibility.md)。

缺少桌面连接时仍可显示只读落盘历史；入队保存、显式重连尝试和已取得的发送许可分别处理。接口不兼容时保留草稿与待发消息，暂停实际派发，不另启 Agent 接管任务。

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
node /Users/fangs/workspace/side/codex-navigator/bin/navigator.mjs annotate 原会话ID --note-file /绝对路径/note.txt --json
node /Users/fangs/workspace/side/codex-navigator/bin/navigator.mjs backup /绝对路径/navigator-backup.json --json
```

`annotate` 只更新所给字段，原版数据只读。CLI 与网页经过同一服务，不另开 Agent。HTTP 契约见 [架构文档](docs/ARCHITECTURE.md)。

## 数据与恢复

默认整理数据：`~/Library/Application Support/CodexNavigator/navigator.sqlite`，自动 JSON 备份位于相邻 `backups/`，保留最近 50 次。首次导入、刷新和 App 重启都不会覆盖已编辑的接续说明或分组。自动备份与 CLI 导出的 JSON 包含置顶、历史接续说明及整理数据，不含完整聊天记录；恢复时先备份现有整理，再用事务替换。

数据、截图和测试回执不进 Git。源码保存在当前项目，可重新安装；换电脑需另行恢复原 Codex 会话，Pocket 备份不代替原会话备份。

可用 `NAVIGATOR_DATA_DIR` 和 `NAVIGATOR_CODEX_HOME` 指定隔离数据目录和来源，适用于合成测试。不要将测试环境指向真实来源做写入测试。服务只监听 loopback；已配置的手机入口经专用认证隧道访问，见 docs/MOBILE.md。多用户部署未验证。
