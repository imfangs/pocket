# Pocket

简体中文 · [English](README.en.md)

**把自己 Mac 上的 Codex 会话带到手机。** Pocket 是可自行部署的网页/PWA：离开电脑后阅读回复、继续提问、发送附件，处理受支持的审批和问题。它连接已有 Codex 桌面端，沿用原会话的模型、工作目录、权限和执行归属。

适合已经在 Mac 上使用 Codex、愿意维护自己的本机服务和 HTTPS 入口的人。当前为 **0.1.0-alpha.1** 实验源码，采用 [MIT 许可证](LICENSE)；这是非官方项目，与 OpenAI 没有隶属或背书关系。截至 2026-11-12，仓库尚未公开，未发布公共 release。

![Pocket 界面示意，使用合成内容展示。](docs/assets/pocket-preview.png)

## 能做什么，支持到哪里

- 阅读和搜索原会话，按项目浏览，按智能、创建或活动排序；Pocket 的关注和隐藏独立于 Codex 的置顶与归档。
- 继续原会话、上传图片/文件，对受支持的审批与提问作答；保留原请求编号，处理待发和未知结果。
- 查看模型设置，执行受支持的新建、改名、归档和恢复。操作是否可用取决于原桌面协议与会话占用。
- 英文和简体中文默认跟随系统，可添加到手机主屏幕；阅读缓存和界面状态按电脑与来源隔离。

当前支持目标是 **macOS、一个拥有者、自己的 Mac 和手机**，原生验证以 Apple Silicon 为主。Pocket 不提供模型账号或订阅，也不提供多用户权限隔离。它的待发队列与桌面队列独立，原生已读写回尚不稳定，跨手机已读同步未实现；桌面持有会话时，归档等操作可能等待。

独立新 Mac 首装、Intel 和实体手机上的键盘、锁屏通知及长期切网仍待验证。已有部署与合成测试提供局部证据，不能证明任意环境即装即用；这些缺口明确限定 Alpha 的支持承诺，不妨碍公开和试用实验源码。完整边界见[兼容范围](docs/COMPATIBILITY.md)。

## 先在 Mac 上运行

需要 macOS、**Node.js 26.x + npm、Python 3.11+**、已安装并登录的签名 Codex.app，以及兼容的本机会话数据。Mac 需保持在线；原会话控制需要桌面端运行。桥接代码随源码提供，无需维护者的 FBT 工作区。

在你取得并审查的源码目录中运行（已有安装先读[升级指南](docs/UPGRADING.md)）：

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

在 **Mac 本机**打开 `http://127.0.0.1:4397`。启动输出受保护口令文件的路径；在本机读取并登录，勿将口令粘贴进公开反馈。`doctor` 检查环境与来源，不验证真实发送或手机连接。用 Ctrl+C 停止前台服务。

默认配置保存在被 Git 忽略的 `.local/pocket/`，数据在源码外的 `~/Library/Application Support/CodexNavigator/`，原 Codex 来源为 `~/.codex/`。`setup` 不覆盖已有配置；已有配置时新参数不会生效。

## 再接入手机 HTTPS

手机上的 `127.0.0.1` 指的是手机。你需要自己的 HTTPS 域名/反向代理，或手机可访问的私有 Tailnet HTTPS 入口，转发到 Mac 的 `127.0.0.1:4397`。

新安装已有 HTTPS 入口时，将上面的 setup 一步改为：

```sh
npm run setup -- --public-origin https://pocket.example.com
```

已有安装则编辑所选私人配置中的 `client.publicOrigin` 与 `deployment.publicOrigin`，使它们一致，再重启自己确认归属的 Pocket 服务。保留认证、Host、Origin、CSRF 校验及 loopback 监听。

手机打开自己的 HTTPS URL，登录后通过 Safari 的“分享 → 添加到主屏幕”或浏览器支持的安装入口使用。可复制的 Caddy 配置、验证顺序、后台服务和排障见[中文自部署指南](docs/SELF_HOSTING.zh-CN.md)／[English guide](docs/SELF_HOSTING.md)。每台 Mac 使用自己的配置、数据和认证；Cloudflare 多机中继是额外配置的高级选项。

## 系统怎样运转

![Pocket 架构：手机通过自有 HTTPS 入口访问 Mac 上的本机 API；API 读取历史并连接原 Codex 会话，私人数据与源码分开。](docs/assets/pocket-architecture.svg)

[可探索的架构图](docs/assets/pocket-architecture.html)可下载后在浏览器打开。

手机 → 自有 HTTPS 入口 → Mac 上的 Pocket API → 原 Codex 桌面会话。API 只监听 loopback，读取本机历史，保存自己的偏好、待发消息和附件；模型请求仍由原 Codex 执行。Pocket 不直接改写 Codex SQLite、全局状态或 rollout，不另起执行器接管会话。

HTTPS 保护传输；TLS 终止代理可以看到经过它的内容。Pocket 没有额外的应用层端到端加密或数据静态加密，模型请求沿用原 Codex 账号与提供方规则。

## 私人数据与维护

| 内容 | 默认位置 |
| --- | --- |
| Codex 原会话、历史与账号资料 | `~/.codex/` 及 Codex 自己的存储 |
| Pocket 偏好、队列、回执、附件和认证 | `~/Library/Application Support/CodexNavigator/` |
| Pocket/桥接配置与服务日志 | `.local/pocket/` |
| 阅读缓存、界面偏好及可选反馈草稿 | 当前浏览器/PWA 的站点存储 |

以上均不属于公开源码。自定义数据、凭据和备份放在源码之外；已有私有配置按原路径保留，勿用 example 覆盖。普通未发送 Query 留在页面内存，提交到待发队列后才在 Mac 持久化。分析和反馈默认关闭；启用自己的服务前阅读 [PRIVACY.md](PRIVACY.md)。

安装与图片权限排障见[自部署指南](docs/SELF_HOSTING.zh-CN.md)，备份与恢复见[UPGRADING.md](docs/UPGRADING.md)。历史可能保留姓名、会话标识和开发记录，公开范围与旧版本边界见[PUBLIC_HISTORY.md](docs/PUBLIC_HISTORY.md)。源码导出不包含 Git 历史，也不等于全面历史匿名化或已经发布。

普通问题可在你有访问权限的仓库中通过 **Issues → New issue** 报告；仓库目前私有。提供版本、复现步骤和合成样本。安全问题按 [SECURITY.md](SECURITY.md) 请求私下反馈渠道，勿公开秘密或完整聊天。开发与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，许可与依赖说明见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 交给 Agent 搭建

将这段和你取得的源码地址或本地目录交给目标 Mac 上的 Agent：

```text
请搭建 Pocket。先读 README、docs/SELF_HOSTING.zh-CN.md、docs/COMPATIBILITY.md、PRIVACY.md 和 SECURITY.md。检查 macOS、Node.js 26.x、Python 3.11+、签名 Codex 桌面端、本人登录及来源布局。使用我提供的源码；缺少源码位置或本人登录时说明所需输入，其余独立工作继续。

先核对已有服务与配置，保留原数据、认证、机器 ID、来源和请求编号，不覆盖配置或启动第二个写入者。新安装依次执行 npm ci --registry=https://registry.npmjs.org、npm run setup、npm run build、npm run doctor、npm start。非默认配置的 setup、doctor、start 全程传 -- --config /绝对路径/config.json；service 命令传 --config，口令维护使用同一路径的 POCKET_CONFIG。setup 不更新已有配置。

先验证本机 /api/health、未登录 /api/catalog 返回401及登录后列表/正文读取。口令只在本机使用，对话和日志只给文件位置。如有我的既有 HTTPS 授权，完成同源反代和手机登录；保持 loopback 与认证、Host、Origin、CSRF 校验。真实发送只用我授权的测试会话，未知结果先查原回执，不能换编号重发。

需要后台服务时先停止前台进程，再用 node bin/pocket.mjs service install --apply，回读 service status；停止并卸载自有后台服务用 service uninstall --apply，数据保留。最后报告版本、入口、配置/数据/口令文件位置、已验证与未验证项，以及停止、备份和恢复方式。
```
