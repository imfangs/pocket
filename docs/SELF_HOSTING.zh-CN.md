# Pocket 自部署（Alpha）

简体中文 · [English](SELF_HOSTING.md)

Pocket 让一个拥有者从浏览器或手机阅读和接续自己 Mac 上的 Codex 原会话。你提供 Mac、已登录的 Codex 桌面端、私人存储和 HTTPS 入口；Pocket 不提供托管账号或模型订阅。本文对应 **0.1.0-alpha.1** 实验源码，独立新 Mac 首装和实体手机验收仍待完成，这些缺口不禁止分享或试用 Alpha 源码。

## 1. 先在 Mac 本机运行

需要 macOS、**Node.js 26.x + npm**、**Python 3.11+**，已安装并登录的签名 Codex.app，以及兼容的本机会话数据。先启动 Codex，Mac 保持在线、唤醒。桥接模块随源码提供，无需维护者的 FBT 工作区。来源、桌面协议和架构边界见[兼容范围](COMPATIBILITY.md)。

已有 Pocket 安装先读[升级指南](UPGRADING.md)，核对实际服务、配置和数据目录。保留认证、机器标识和原请求编号，不对同一数据启动第二个写入者。

在已取得并审查的源码目录运行：

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

在 **Mac 本机**打开 `http://127.0.0.1:4397`。启动输出受保护口令文件的位置，不输出口令值；在本机读取并登录。不要把口令贴到聊天、截图、命令参数或公开日志。前台进程用 Ctrl+C 停止。

| 内容 | 默认位置 |
| --- | --- |
| 安装配置 | `<源码目录>/.local/pocket/config.json` |
| 桥接配置和服务日志 | 所选 config 同目录的 `bridge.json` 与 `logs/` |
| Pocket 数据、认证、队列和附件 | `~/Library/Application Support/CodexNavigator/` |
| 原 Codex 来源 | `~/.codex/` |

自定义数据、备份和秘密配置留在源码之外；`.local/` 被 Git 忽略。文件、浏览器缓存和第三方传输的完整边界见 [PRIVACY.md](../PRIVACY.md)。

`setup` 是幂等的：所选配置已存在时返回 `created:false`，新的 origin、端口、数据目录等参数均不生效。需要调整时编辑已有私人配置，不要删除它来重跑 setup。

### 使用非默认配置

新安装可以一次指定路径与机器标识：

```sh
npm run setup -- --config /absolute/private/pocket/config.json \
  --data-dir /absolute/private/pocket-data \
  --codex-home /absolute/path/to/.codex \
  --port 4397 --machine-id local --label "My Mac"
npm run build
npm run doctor -- --config /absolute/private/pocket/config.json
npm start -- --config /absolute/private/pocket/config.json
```

doctor、start、后台服务和口令维护全程使用同一 config。另一份安装还需要独立 Pocket 数据目录和空闲端口；测试写入使用隔离的 Codex home 和授权测试会话，合成测试不指向真实存储。机器 ID 与显示名称会进入公共客户端配置，不要填秘密或敏感信息。

## 2. 验证本机入口

检查 `/api/health` 成功、未登录访问 `/api/catalog` 返回401；本人登录后核对列表和一段消息正文。

`doctor` 检查运行时、桥接模块、App 身份、来源 schema 和构建结果；真实控制与手机连接会标为 `not_checked`。进程健康、读取成功都不能证明发送、每张图片的文件权限或手机网络已经可用。真实控制测试使用你授权的会话和动作；结果未知时保留原请求 ID，先查回执再决定重试。

## 3. 接入手机 HTTPS

手机上的 `127.0.0.1` 指的是手机。使用 Mac 上的自有 HTTPS 反代，或能访问 loopback 服务的私有 Tailnet HTTPS 入口。Node 继续监听 `127.0.0.1`，不要改为 `0.0.0.0`。

新安装已有 HTTPS origin 时，将初次 setup 替换为：

```sh
npm run setup -- --public-origin https://pocket.example.com
```

已有安装则先停止自己确认归属的 Pocket 进程，编辑所选私人 `config.json` 的 `client.publicOrigin` 与 `deployment.publicOrigin`，填入完全相同的 HTTPS origin，然后携带同一配置启动。origin 不包含路径、查询、片段或用户名/口令。保留机器 ID、数据目录和认证；更换 origin 也会改变浏览器站点存储范围，注意原阅读状态的接续。

例如，用自己的域名配置 Caddy 同源转发网页与 API：

```caddyfile
pocket.example.com {
    reverse_proxy 127.0.0.1:4397
}
```

DNS、证书和 Caddy 由你提供，Pocket 不自动安装 Caddy。反代保留实际公共 Host，将 `X-Forwarded-Proto` 覆写为它真实终止的 HTTPS，清除不可信的外来转发头。保留认证、Host、Origin、CSRF 校验。私有 Tailnet HTTPS 也可使用，须核对实际 Host 与 HTTPS 转发行为符合配置。

新 setup 的口令最低长度为12字符；修改策略不会重置旧认证。公开暴露已有入口前检查旧口令，弱口令或来源不明的口令显式轮换。Pocket 登录凭据能控制会话，并非只读分享链接，见 [SECURITY.md](../SECURITY.md)。

手机打开自己的 HTTPS URL，登录后核对列表和消息读取。Safari 中选择“分享 → 添加到主屏幕”，其他浏览器按支持的安装入口操作。键盘、草稿和通知在实际手机上验证。登录后的 `/api/deployment/status` 将基本初始化/来源检查与桌面、外部网络检查分开，不证明手机链路已验收。

## 4. 可选的用户级后台服务

前台验证后先停止前台进程，再安装 LaunchAgent；无需 root 或 `sudo`。安装/卸载命令不带 `--apply` 时只展示计划。

```sh
node bin/pocket.mjs service install --apply
node bin/pocket.mjs service status
```

停止并移除本安装的后台登记：

```sh
node bin/pocket.mjs service uninstall --apply
node bin/pocket.mjs service status
```

非默认配置的**每条** service 命令都追加 `--config /absolute/private/pocket/config.json`，包括 status 与 uninstall。没有 `service stop` 子命令；前台用 Ctrl+C，后台通过自有服务的 uninstall 停止。配置和数据保留，重新安装同一服务会沿用它们。

LaunchAgent 记录当时的 Node 路径、源码目录、所选 config 和私人日志。移动源码或更换 Node 路径后核对并重新安装自己所属的服务。卸载不删除 Pocket 数据、附件或原 Codex 数据。

## 口令维护

即使使用默认安装，也明确用 `POCKET_CONFIG` 指向同一配置：

```sh
POCKET_CONFIG="$PWD/.local/pocket/config.json" node bin/access.mjs info
POCKET_CONFIG="$PWD/.local/pocket/config.json" node bin/access.mjs rotate
POCKET_CONFIG="$PWD/.local/pocket/config.json" node bin/access.mjs set --stdin
```

自定义配置时换成自己的绝对路径。`set --stdin` 只从标准输入读取新口令，值不要放进参数或 URL。轮换撤销浏览器登录和通知登记，不删除待发消息。完整备份与恢复见[升级指南](UPGRADING.md)。

## 本地图片与 macOS 文件夹权限

会话图片通过已认证、绑定会话的引用读取。已有 Markdown 图片内嵌预览需要受支持的本地图片，位于该会话工作目录内；上传附件使用独立记录。代码块、浏览器任意传入的路径和外站图片 URL 都不会授予本地文件权限；格式、大小、路径/符号链接与引用时效检查保持。

图片失败时：

1. 核对会话 cwd、真实引用/文件和已登记图片的 HTTP 结果。缺失或过期引用可能返回404，重新读取会话可取得新引用；401需要有效登录；403应按具体原因排查，不能一律断言为 macOS 隐私权限。
2. 如果后台无法读取“文稿”等受保护目录，核对**实际后台 Node 可执行文件与启动方式**。Codex 能显示图片、终端前台能读文件，都不能证明 LaunchAgent 具有相同文件夹权限。
3. 在“系统设置 → 隐私与安全性 → 文件与文件夹”核对该程序的对应文件夹授权；列表没有程序时，先查真实服务启动和系统授权入口。不要修改 TCC 数据库、开放所有路径或替换会话目录来绕过拒绝。
4. 重试同一图片，确认响应成功并正常解码。API 健康或 doctor 全绿不能证明这张图已可读；升级改变 Node 路径后重新核对实际进程与权限。

公开排障报告不贴私人文件名、完整路径、聊天正文或图片内容。以上步骤不依赖维护者的私有图片记录。

## 其他排障

- **Node/Python 不兼容**：使用声明版本，核对所选私人 bridge 配置的实际解释器。
- **桌面/来源缺失**：启动 Codex、完成登录，检查文档声明的布局；不猜新数据库名称，不改写 Codex SQLite。
- **Codex 位于非标准目录**：在所选私人 `bridge.json` 设置实际签名 App 的 `appPath`，用同一 Pocket config 重跑 doctor。
- **Host/Origin 拒绝**：修正 origin 和可信代理头，保留原校验。
- **原会话忙碌**：正文可能仍可读，操作却等待原桌面 writer；归档/恢复另有[兼容边界](COMPATIBILITY.md)。
- **发送/新建未知结果**：保留原请求编号并查回执，不用新编号重发。
- **端口/数据锁冲突**：先确认已有写入者；残留锁处理须证明所有写入者均已停止，见[升级指南](UPGRADING.md)。

## 高级中继与既有私有配置

直接 HTTPS 是最短自部署路径。Cloudflare 中继属于可选高级适配器，你需要自己的 Pages 项目、KV、登记凭据、公共客户端 profile 和域名。日常使用优先稳定命名隧道或私有反代；Quick Tunnel 没有可用性保证。

`POCKET_CLIENT_CONFIG=/absolute/public-profile.json npm run build:pages` 使用经校验的公共 profile 构建。旧 Quick Tunnel 连接器使用基于 `config/relay.example.json` 的自有 `NAVIGATOR_RELAY_CONFIG`、`NAVIGATOR_MACHINE_ID`，并从 PATH 找到 cloudflared 或通过 `CLOUDFLARED` 指定。`NAVIGATOR_API_ORIGIN` 可选择另一个裸 loopback HTTP 端口。登记秘密留在私人存储；提供源码不代表已有托管中继服务。

已有 `config/desktop-bridge.json`、`config/usage-analytics.json` 和部署/服务配置可继续留在原来的忽略路径。保留内容和显式环境/配置覆盖，不用 example 覆盖。新 checkout 使用内置桥接发现，分析默认关闭；需要自己的分析时，将 `config/usage-analytics.example.json` 复制到被忽略的 `config/usage-analytics.json`，配置自己的项目和允许 origin，并先读 [PRIVACY.md](../PRIVACY.md)。

## 让 Agent 帮你搭建

将下面的指令和源码地址交给目标 Mac 上的 Agent。

<details>
<summary>复制给 Agent</summary>

```text
请搭建 Pocket。先读 README、docs/SELF_HOSTING.zh-CN.md、docs/COMPATIBILITY.md、PRIVACY.md 和 SECURITY.md。检查 macOS、Node.js 26.x、Python 3.11+、签名 Codex 桌面端、本人登录及来源布局。使用我提供的源码；缺少源码位置或本人登录时说明所需输入，其余独立工作继续。

先核对已有服务与配置，保留原数据、认证、机器 ID、来源和请求编号，不覆盖配置或启动第二个写入者。新安装依次执行 npm ci --registry=https://registry.npmjs.org、npm run setup、npm run build、npm run doctor、npm start。非默认配置的 setup、doctor、start 全程传 -- --config /绝对路径/config.json；service 命令传 --config，口令维护使用同一路径的 POCKET_CONFIG。setup 不更新已有配置。

先验证本机 /api/health、未登录 /api/catalog 返回401及登录后列表/正文读取。口令只在本机使用，对话和日志只给文件位置。如有我的既有 HTTPS 授权，完成同源反代和手机登录；保持 loopback 与认证、Host、Origin、CSRF 校验。真实发送只用我授权的测试会话，未知结果先查原回执，不能换编号重发。

需要后台服务时先停止前台进程，再用 node bin/pocket.mjs service install --apply，回读 service status；停止并卸载自有后台服务用 service uninstall --apply，数据保留。最后报告版本、入口、配置/数据/口令文件位置、已验证与未验证项，以及停止、备份和恢复方式。
```

</details>
