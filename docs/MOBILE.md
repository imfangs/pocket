# 手机 PWA 与固定入口

2026-09-27 用户授权：先做可添加主屏幕的 PWA，使用简单口令验证；随后指定固定地址 `https://x.fangs.cc`。发送指令和新建原会话仍是后续阶段，本版主要验证查看、整理和连接。

## 运行路径

手机 → x.fangs.cc 的 Cloudflare Pages 静态壳 → `/api/*` Pages Worker → KV 中登记的 Quick Tunnel 地址 → Mac 上 Node 服务 → 本机 Codex 元数据与任务架 SQLite。

Cloudflare KV 只保存接入地址、连接标记和时间，不保存任务、备注、口令或会话 Cookie。API 响应经 Cloudflare 转发到手机；持久任务数据与口令校验留在 Mac。Pages Worker 检查客户端 Origin，删除远程 Authorization 头，再向已验证的 HTTPS Tunnel 地址转发必要 Cookie/CSRF/JSON。关闭上游重定向跟随，API 始终 no-store。

Mac 的 `bin/tunnel.mjs` 由 FBT local 常驻。启动前匿名探测目录必须为 401 才开放隧道；连接后把地址登记到独立 KV。每五分钟续登记，记录十五分钟过期，避免 Mac 停止后永久保留旧地址。KV 传播可能有短暂延迟；本阶段仍依赖开发用途的 Quick Tunnel，不承诺生产 SLA。即使底层地址更新，主屏幕入口保持 x.fangs.cc。

## 登录

首次生成随机口令，文件：`~/Library/Application Support/CodexNavigator/initial-passphrase.txt`，权限 0600。`access.json` 只保存 scrypt 校验值、salt 和本机 CLI 凭据。口令不会写进 Git、URL 或客户端代码。

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

连接状态中 `connected` 表示隧道已建立，`published` 与 `publishedAt` 表示固定入口地址登记成功。首次登记可能因网络失败重试；2026-09-27 重启验收实际先返回服务未就绪，随后连接成功，自动登记重试成功。不要把启动命令退出码等同于最终状态。等待约一分钟后回读，再按配置重启具体服务；不重传未变化的前端。

口令文件直接在 Mac 本地打开后输入手机。请勿将口令放进 URL、仓库或分享截图。手机安装须用正式固定地址；旧 trycloudflare 地址会在连接器重启后失效。
