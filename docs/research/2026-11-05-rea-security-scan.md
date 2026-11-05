# Pocket：REA、Git 泄漏与入口安全核查

2026-11-05。用户询问 REA 是否能按 GitHub 仓库扫描隐私与可利用信息，并要求扫描。扫描固定本地脱敏候选 `2d2fa4aa9ff971ff3391c0ecaeeb30de48a50f92`（368 提交、634 文件），并用当时原维护仓库370提交作历史格式对照。没有上传源码、验证真实凭据、攻击线上服务、改写历史、升级依赖或修改安全业务代码。并行的消息渲染修复另有实现与发布记录，不把它混作扫描修复。

## 工具能力与边界

本机 FBT `rea` 是固定 `rea-agents@6.4.0`，doctor 的 CLI/MCP 握手与170工具目录健康。当前 CLI/MCP 可做本地 JavaScript/Electron 静态分析，没有专门按 GitHub仓库做密钥泄漏或漏洞判定的入口。使用现有本地副本，避免为扫描把私人维护历史上传到GitHub。

REA 实际解析492个JavaScript文件，0解析失败，收集3,285项静态事实；这不是3,285个漏洞。应用图/语义图覆盖为partial，语义表示有资源约束和省略，不能用它证明完整行为、运行时可达性或不存在漏洞。完整Evidence经gzip无损压缩并回读SHA一致，保存在`rea-evidence.json.gz`，有界摘要留私有QA。

Gitleaks8.30.1用默认规则，显式忽略`gitleaks:allow`注释、100%遮罩、归档深度2/解码深度5/单文件上限4MiB；分别扫描脱敏Git全历史、脱敏当前目录和维护Git全历史。它是本地格式匹配，不对发现值进行网络验证。原始报告含Git元数据，保持0600，不向公共源码复制。

## 凭据与个人标记结果

三组Gitleaks扫描各报16条`generic-api-key`，原exit1保留，没有靠放宽规则重跑成绿。

- 15条是`vendor/pele/source-manifest.json`中的源码路径到SHA256映射。独立重新计算`source-44da152.tar.gz`全部292文件，292/292与manifest匹配，归档自身哈希也匹配；不是认证密钥。
- 1条是`src/taskOperations.ts`的`creationRecoveryKey`，用于按机器隔离sessionStorage中待核对创建请求ID。它不是token，不授予认证或执行权限。

本轮没有确认真实登录凭据泄漏。独立核对候选全部3,243Git对象与10条有效私人规则及30种literal/URL/base64变体，无命中、无大小跳过；作者身份、refs、reflog、alternates与当前树边界保持。此结论不替代原维护仓库的已知姓名/域名/运维信息清理，也不说明格式扫描可发现任何个人文字。

## 依赖检查

`npm audit --package-lock-only --omit=dev`：生产依赖0条已知漏洞。包含开发依赖时有2个high包汇总：`vite@7.3.6`和`source-map-js@1.2.1`。核对的是当时锁文件与GitHub原始公告；不能把npm汇总等级直接等同Pocket线上可远程接管。

目前Vite只用于构建或显式`npm run dev --host 127.0.0.1`，生产`npm start`是loopback Node服务，并非Vite开发中间件。Vite公告涉及开发服务器/编辑器/特定路径等条件，source-map-js涉及恶意indexed sourcemap导致资源耗尽。建议开发者公开发行前升级Vite7.3.7+与source-map-js1.2.2+后验证锁文件、构建与浏览器；本轮仅扫描，未自动升级。audit只发送公开包名与版本数组，不发送源码、项目路径或私人配置。

## 两项条件性入口硬化

| 项目 | 证据与前提 | 当前判断 |
| --- | --- | --- |
| 图片父目录竞态 | `server/message-images.mjs:88`附近，已在真实合成FS复现open期间parent目录换成outside symlink再恢复，读出授权目录外合成PNG；需要工作目录可写以及有效认证image GET，只图片类型 | 单owner现模型定位Low；若存在较低权限workspace进程而API有更广读取权限，可升Medium。复用普通文件的路径/FD dev、ino前后核验是最小修复 |
| 直接反代IP头信任 | `server/index.mjs:269`附近，public Host即采信`CF-Connecting-IP`。若直接代理保留客户端该头，同一请求方可绕过10/IP预算；本地合成60个伪IP错误登录均401，后续新登录触发429 | Low、部署相关，未证明实际生产代理存在条件。全局60次仍生效，已有会话继续可用；应按可信代理来源使用IP信息或剥离不可信头 |

没有据此确认匿名远程任意文件读、认证绕过或原会话执行接管。70项auth/deployment/edge/feedback合成边界通过；Host/Origin/CSRF、loopback bearer、会话哈希/有效期、按机器登记、签名回调/固定目标、普通文件/附件与Markdown/XSS控制已追代码与既有回归。TLS终止代理可见经过内容属于已说明的信任边界，不作为新漏洞。

## 接续

证据目录：`.local/qa/rea-security-scan-2026-11-05/`。重点回读`gitleaks-receipts.json`、redacted报告、`rea-summary.json`/完整Evidence、`independent-security-summary.json`、`entrypoints-review.md`和两个合成复现回执。报告不写精确私人值。

尚未实施修复或依赖升级；公开发布前应处理上述开发依赖与边界硬化，复验受影响路径。扫描不构成完整渗透测试或对未来Codex/浏览器版本的安全承诺。原有新Mac/真机、完整许可和公开仓库支持流程门槛继续存在。
