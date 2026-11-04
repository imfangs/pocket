# Pocket

简体中文 · [English](README.en.md)

**把自己 Mac 上的 Codex 会话带到手机。** Pocket 是可自行部署的网页/PWA：阅读对话、继续提问、发送附件，以及执行受支持的会话操作。它连接正在使用的 Codex 桌面端，沿用原会话的模型、权限和执行归属。

这是非官方项目，与 OpenAI 没有隶属或背书关系。当前源码候选为 **0.1.0-alpha.1**，采用 [MIT 许可证](LICENSE)；面向一个拥有者使用自己的 Mac 和手机，尚未正式公开发布。新 Mac 首装与实体手机的独立验收仍是发布门槛，已有部署不代表你的环境已经兼容。

## 系统怎样运转

![Pocket 架构：手机通过用户自有 HTTPS 入口访问 Mac 上的本机 API；API 读取历史，通过桥接连接原 Codex 会话；用户数据与源码分开保存。](docs/assets/pocket-architecture.svg)

[可探索的架构图](docs/assets/pocket-architecture.html)可下载后在浏览器打开。

1. **手机**打开 Pocket，HTTPS 入口把请求转发给你的 Mac。网页和 API 使用同一来源，登录、Host、Origin 与 CSRF 校验保护私人接口。
2. **Mac 上的 Pocket API**只监听 `127.0.0.1`，读取本机 Codex 历史，维护自己的偏好、待发消息和附件。源码自带 Python 桥接，不依赖维护者的工具工作区。
3. **原 Codex 桌面端**执行模型请求。Pocket 通过原会话的桌面连接发送消息；新建、改名等受支持操作使用桌面内置 CLI。Pocket 不另起模型执行器接管会话。
4. **数据分开保存**：Codex 保留原会话，Pocket 保留自己的运行数据，浏览器缓存阅读副本。自有 HTTPS 代理是推荐入口；Cloudflare 中继属于可选高级部署，并非必需服务。

HTTPS 保护传输，但这不是应用层端到端加密：TLS 终止代理可看到经过它的内容。模型请求仍按你原本的 Codex 账号与提供方规则处理。

## 搭建前需要什么

| 条件 | 要求 |
| --- | --- |
| Mac | macOS，保持当前用户登录、Mac 在线；原会话控制需要 Codex 桌面端运行 |
| Codex | 已安装签名的 Codex.app，完成本人登录，并产生兼容的本机会话数据；Pocket 不提供模型账号或订阅 |
| 运行时 | **Node.js 26.x + npm、Python 3.11+**；Python 标准库即可 |
| 源码与网络 | 经审查的源码目录或发布包，能够从公开 npm registry 安装锁定依赖；使用 Git 克隆时需要 Git |
| 手机入口 | 自己管理的 HTTPS 域名/反向代理，或可从手机访问的私有 Tailnet HTTPS 入口；本机试运行可以先不准备 |
| 私人存储 | Mac 上源码目录之外的可写数据目录；代理配置、密钥和备份也按私人资料保存 |

当前原生验证以 Apple Silicon 为主；Intel、未来 Codex 协议及其他系统的支持边界见[兼容范围](docs/COMPATIBILITY.md)。安装与构建可以由 Agent 完成；账号登录、没有现成授权的域名/网络权限和手机主屏幕安装需要本人配合。

## 复制给 Agent，让它搭建

把下面这段连同源码地址或本地目录交给在目标 Mac 上工作的 Agent。默认先完成本机部署；有自己的 HTTPS 入口时，再完成手机连接。

```text
请在我的 Mac 上搭建这个 README 对应的 Pocket 项目。使用我提供的仓库/发布包或本地源码目录；若缺少源码位置，先确认，不编造仓库地址。

先读 README、docs/SELF_HOSTING.md、docs/COMPATIBILITY.md、PRIVACY.md 和 SECURITY.md。检查 macOS、Node.js 26.x、npm、Python 3.11+、签名 Codex 桌面端、本人登录和兼容的本机会话来源；缺少本人登录时说明必要的一步，其余可独立工作继续。

使用公开 registry 执行 npm ci。核对已有 Pocket 服务与配置：保留原数据、机器 ID、来源和请求编号，不重置账号，不覆盖已有配置，不启动第二个数据写入者。新安装运行 npm run setup，数据留在默认的源码外私人目录；然后 npm run build、npm run doctor。setup 是幂等的，已有配置时新参数不会生效；更换 HTTPS 入口应明确更新 client.publicOrigin 与 deployment.publicOrigin 并保持一致。

选定配置后，全程使用同一份配置：非默认配置在 npm run doctor/start 后追加 -- --config /绝对路径/config.json，service 命令也传 --config；口令维护使用同一路径的 POCKET_CONFIG。只停止自己确认归属的 Pocket 进程，保留 Codex 和其他服务。

先前台启动，验证 /api/health 可用、未登录访问 /api/catalog 返回 401，并通过本人本机登录核对列表和消息读取。口令只留在本机受保护文件；回复、Git、截图和日志中只给文件位置，不给值。doctor 不验证真实发送或手机连接，分别报告结果。

如我已有授权的 HTTPS 域名、反代或 Tailnet 入口，请接入同源网页/API，保持 API 的 127.0.0.1 监听与认证、Host、Origin、CSRF 校验，核对实际手机 URL 与 PWA 安装流程。缺少 DNS/证书/网络权限时只暂停该分支，交付可用的本机入口和准确待办。

测试先只读；需要实际发送时使用我明确授权的测试会话和文本，结果未知先查原编号回执，不能换编号重发。前台验收后如需常驻，先用 Ctrl+C 停止前台进程，再执行 node bin/pocket.mjs service install --apply 并回读 service status；自有后台服务用 service uninstall --apply 停止并卸载，数据保留。最后报告版本、入口、配置/数据/口令文件位置、已验证与未验证项，以及停止、卸载和恢复方式；检查私人数据与配置未被 Git 跟踪。
```

## 手动快速开始

在经审查的源码目录运行：

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

服务默认位于 `http://127.0.0.1:4397`，启动输出受保护口令文件的路径。这个地址只能在 Mac 本机使用；手机上的 `127.0.0.1` 指的是手机。

新安装已有 HTTPS 入口时，在首次 setup 就指定它：

```sh
npm run setup -- --public-origin https://pocket.example.com
```

已有配置不会被这个命令覆盖。完整的反代、配置、用户级后台服务与诊断步骤见[安装指南](docs/SELF_HOSTING.zh-CN.md)及[英文完整指南](docs/SELF_HOSTING.md)。每台 Mac 使用自己的配置、数据与认证；高级多机中继需要另外配置。

## 私人数据放在哪里

| 内容 | 默认位置 | 是否属于公开源码 |
| --- | --- | --- |
| Codex 原会话、历史与账号资料 | `~/.codex/` 及 Codex 自己的存储 | 否；Pocket 不将它复制成源码 |
| Pocket 偏好、队列、回执、附件、认证与备份 | `~/Library/Application Support/CodexNavigator/` | 否；位于源码目录之外 |
| 本机 Pocket/桥接配置与服务日志 | `.local/pocket/` | 否；整个 `.local/` 被 Git 忽略 |
| 手机阅读缓存、界面偏好及可选反馈草稿 | 当前浏览器/PWA 的站点存储 | 否；阅读缓存可能含私人消息 |
| 可选通知、中继、反馈或分析配置 | 自己的私人配置/数据位置 | 否；按启用服务另有传输边界 |

可以通过 setup 的 `--data-dir`、`--codex-home`、`--config` 选择其他位置。**自定义数据、凭据与备份应放在源码目录之外**，发布构建只包含公开资源和非秘密客户端配置。公开源码导出默认关闭分析，不带维护者部署配置或地址。

普通未发送 Query 保留在当前页面内存；提交到待发队列之后才在 Mac 持久化。它不属于浏览器的持久阅读缓存。

`.gitignore` 保护常规暂存，但不能撤回已提交历史，也不能阻止 `git add -f`。分享源码应使用白名单导出，复核隐私检查和文件清单后，在新的公共仓库建立干净历史；不要把含个人运维记录的维护仓库直接设为公开。详细数据留存、浏览器缓存和第三方边界见 [PRIVACY.md](PRIVACY.md)，升级备份见 [UPGRADING.md](docs/UPGRADING.md)。

## 使用与维护

- 阅读、继续原会话，上传图片/文件；对受支持的审批和提问作答。
- 搜索、项目分类、智能/创建/活动排序；Pocket 的关注和隐藏独立于 Codex 的置顶与归档。
- 查看模型设置，执行受支持的重命名、归档和恢复；实际能力随原桌面协议与会话占用而变化。
- 英文和简体中文，默认跟随系统；手机添加主屏幕，界面保留草稿与阅读位置。

开发、合成测试与审查见 [CONTRIBUTING.md](CONTRIBUTING.md)；问题报告遵循 [SECURITY.md](SECURITY.md)，只提供脱敏资料。

维护者准备可再分发源码时：

```sh
npm run package:source -- --out /absolute/new/pocket-source
npm run privacy:check -- --root /absolute/new/pocket-source
```

输出目录必须尚不存在。核对输出的 `source-manifest.json`、隐私检查与[第三方声明](THIRD_PARTY_NOTICES.md)。导出成功不等于已经公开发布或完成新设备验收。
