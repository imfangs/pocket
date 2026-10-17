# 手机 PWA 与固定入口

2026-10-17多机扩展：同一入口按电脑切换，各自登记独立路由，Cookie、偏好、图片/附件和通知均按机器隔离；旧格得连接保持兼容。接口、边界和部署入口见[多机连接](design/2026-10-17-multi-machine.md)，实际就绪状态见CURRENT。

2026-09-27 用户授权：先做可添加主屏幕的 PWA，使用简单口令验证；随后指定固定地址 `https://x.fangs.cc`。09-28 追加最近历史与文本 query，具体能力和验证边界见 [CONVERSATION.md](CONVERSATION.md)；后续新建/归档能力与当前版本统一见 [CURRENT.md](../CURRENT.md)。

## 运行路径

手机 → x.fangs.cc 的 Cloudflare Pages 静态壳 → `/api/*` Pages Worker → KV 中登记的 Quick Tunnel 地址 → Mac 上 Node 服务 → 本机 Codex 元数据与 Pocket SQLite。

Cloudflare KV 只保存接入地址、连接标记和时间，不保存任务、备注、口令或会话 Cookie。API 响应经 Cloudflare 转发到手机；持久任务数据与口令校验留在 Mac。Pages Worker 检查客户端 Origin，删除远程 Authorization 头，再向已验证的 HTTPS Tunnel 地址转发必要 Cookie/CSRF/JSON。关闭上游重定向跟随，API 始终 no-store。

Mac 的 `bin/tunnel.mjs` 由 FBT local 常驻。启动前匿名探测目录必须为 401 才开放隧道；连接后通过 `POST /api/relay/register` 把地址登记到独立 KV。每五分钟续登记，失败时每分钟重试，记录十五分钟过期，避免 Mac 停止后永久保留旧地址。KV 传播可能有短暂延迟；本阶段仍依赖开发用途的 Quick Tunnel，不承诺生产 SLA。即使底层地址更新，主屏幕入口保持 x.fangs.cc。

2026-09-28 修复：后台登记不再调用 Wrangler，不依赖人的 Cloudflare OAuth 登录。专用 256-bit 随机 token 存本机私有 `relay-registration.json`（0600），云端只配置其 SHA-256 校验值 `NAVIGATOR_REGISTRATION_SHA256`。登记接口不接受浏览器 Origin/Cookie 作为授权，只允许此 key 更新固定 `origin` 记录；不提供任务读取权限，不接收口令或任务内容。URL 必须是无路径、无凭据、无查询参数的 HTTPS Quick Tunnel 地址，请求体最多 2 KiB。

## 登录

首次生成随机口令，文件：`~/Library/Application Support/CodexNavigator/initial-passphrase.txt`，权限 0600。`access.json` 只保存 scrypt 校验值、salt 和本机 CLI 凭据。口令不会写进 Git、URL 或客户端代码。

自定义口令支持 4–128 个字符；2026-09-27 按用户指定的四位试用口令调整下限。实际口令仅在本机私有文件保存，默认生成方式仍为随机口令。

登录后使用 Host-only、HttpOnly、SameSite=Strict 的 Cookie，HTTPS 加 Secure，七天到期。服务端存 token 的 SHA-256；退出或轮换口令可撤销。重复失败有单 IP 与全局限流。本机 CLI 使用私人文件里的独立 token，仅直连 loopback 有效，经过远程转发不可使用。

```sh
node bin/access.mjs info
node bin/access.mjs rotate
# 自定义口令通过 stdin，不放入命令参数：
node bin/access.mjs set --stdin
node bin/navigator.mjs connection --json
```

## 主屏幕和离线

manifest、192/512px 图标、maskable 图标、Apple touch icon、standalone、安全区及触控输入适配已加入。iPhone 使用 Safari 的共享菜单添加到主屏幕；Android 使用浏览器安装菜单。首次主屏幕登录可能与浏览器分开。

Service Worker 只预缓存公开离线提示、manifest 和图标；私人 API 永远走网络。网页不缓存会话目录或说明。浏览器中的安装条件、离线代码测试和真机安装体验必须分别记录，不能用桌面模拟代替用户手机。

## 发布与恢复

`npm run build:pages` 生成静态资源与 `_worker.js`；`wrangler.jsonc` 绑定独立 KV。发布复用 FBT pages-site，配置在 `config/pages-site.json`。DNS 只新增 x 的 CNAME，不变更 fangs.cc 的 nameserver。

本机服务和连接器分别由 `config/local-service.json`、`config/tunnel-service.json` 管理。只重启 Node 不会改变隧道地址；连接器重启会生成新地址并重新登记。网页壳可打开不代表 Mac 在线，API 会返回明确的连接错误。

### 当前发布与排障

2026-09-27 固定入口已上线：Pages 项目 `codex-navigator`，DNS `x CNAME codex-navigator.pages.dev`，TTL 600 秒，域名 Active，正常 HTTPS 及逐文件校验通过。源码版本和验收事实以 `CURRENT.md`、`docs/QA.md` 为准。当前 Wrangler 创建步骤通过官方 Pages API 预建 Direct Upload 项目，再由 FBT 发布已有项目；没有更改 fangs.cc 的 nameserver。

```sh
/Users/fangs/workspace/fbt/bin/fbt local status --config config/local-service.json --json
/Users/fangs/workspace/fbt/bin/fbt local status --config config/tunnel-service.json --json
node bin/navigator.mjs connection --json
node bin/verify-public.mjs https://x.fangs.cc
```

连接状态中 `connected` 表示隧道已建立，`published`、`publishedAt` 与 `expiresAt` 表示固定入口登记状态。连接器健康检查同时要求隧道连接、登记成功且未过期；登记失败会返回 503 与不含凭据的 `registrationError`。首次登记可能因网络失败重试；不要把进程 running 等同于公网可用。等待约一分钟后回读，再按配置重启具体服务；不重传未变化的前端。

登记凭据的恢复：保留本机私有 `relay-registration.json`，不要用网站四位访问口令替代它。`node bin/registration-key.mjs` 会复用已有 key 并生成私有 `relay-registration.sha256` 文件，stdout 只显示路径。初次配置或丢失 key 后重新配对时，将 verifier 文件通过 stdin 配置为 Pages 生产环境的 `NAVIGATOR_REGISTRATION_SHA256` secret，再发布 Worker。发布操作仍使用管理凭据，运行时续登记不需要管理凭据。不要误轮换现有 key；换 key 必须同步云端 verifier。

口令文件直接在 Mac 本地打开后输入手机。请勿将口令放进 URL、仓库或分享截图。手机安装须用正式固定地址；旧 trycloudflare 地址会在连接器重启后失效。

2026-10-08 发布回读发现旧 Quick Tunnel 持续返回 `Unauthorized: Tunnel not found`：连接器进程仍在，但 `/health` 的 connected/published 已为 false，登记已过期。按现有配置重启连接器后生成新通道并重新登记，随后独立回读健康200、公网认证目录200；Mac API与Codex未重启。静态文件已上传时仍使用同一部署的 `resume --publish --resume-verification`，没有再次上传。证据 `.local/qa/notion-polish-2026-10-08/` 的 `tunnel-recovered.json`、`resume.json`、`public-readback.json`。这次恢复不构成长期隧道稳定性保证。

2026-10-08 同日后续，方帅反馈手机「Mac 暂时不可达」，随后确认「已经恢复」。日志记录13:44:27与Cloudflare边缘断线、13:44:34重连，之后还有重连与登记网络错误；检查时本机API和隧道直连均200。固定域名一度在Node/curl中连接超时：对DNS当时返回的两个地址做保留Host/SNI/TLS校验的临时对照，172.66.47.102返回200、172.66.44.154握手超时；没有修改DNS或固定IP。最后用普通域名回读 `/api/health` 为200（14.48秒）、匿名 `/api/catalog` 为401（4.18秒），与手机恢复反馈一致。本次未重启服务或重新发布；属于恢复已确认但时延仍偏高的公网链路波动。证据 `.local/qa/connection-outage-2026-10-08/`。

此轮同时核对了诊断边界：本机连接器的 `ok` 只验证日志连接标志和未过期登记，并非手机端到端可达证明。Worker的「Mac暂时不可达」对应上游5xx/重定向，网络异常使用另一条提示；仅凭用户文案或进程存活不能确定根因。后续若继续改进连接器，应补充真实通路检测、失效隧道恢复和登记回执的代际保护，保留发送请求不自动重放的边界。
