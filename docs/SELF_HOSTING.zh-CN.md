# Pocket 自部署 Alpha

Pocket 是单个拥有者从手机阅读和接续自己 Mac 上 Codex 会话的高权限入口。需要 macOS、Node.js 26、Python 3.11+、已安装并登录的 Codex 桌面端；无需作者的 FBT 工作区，也不提供模型账号或订阅。

在源码目录运行：

```sh
npm ci
npm run setup
npm run build
npm run doctor
npm start
```

首次配置写入被忽略的 `.local/pocket/`，默认数据在源码之外的 `~/Library/Application Support/CodexNavigator/`，原 Codex 来源为 `~/.codex/`。自定义数据、凭据和备份也应放在源码之外，具体文件与浏览器缓存见 [PRIVACY.md](../PRIVACY.md)。服务只监听 `127.0.0.1:4397`，终端输出本机受保护口令文件的位置。手机不能通过自己的 `127.0.0.1` 访问 Mac；需自行配置可信 HTTPS 反代或 Tailnet HTTPS 入口，再用自己的 URL 登录和添加主屏幕。

新部署可以指定 `npm run setup -- --public-origin https://pocket.example.com`。已有配置不会自动覆盖，新 origin、端口和数据目录参数都会被忽略；编辑时 `client.publicOrigin` 与 `deployment.publicOrigin` 必须一致，保留 Host、Origin、CSRF 和认证校验。公共部署的新口令至少12字符，已有口令和队列不自动重置。

非默认配置需要全程携带同一路径，例如：

```sh
npm run setup -- --config /absolute/private/pocket/config.json
npm run build
npm run doctor -- --config /absolute/private/pocket/config.json
npm start -- --config /absolute/private/pocket/config.json
```

先核对已有服务与配置，保留数据和请求编号；本机验收包括 `/api/health` 成功、未登录访问 `/api/catalog` 返回401，以及本人登录后的列表/消息读取。口令只读本机文件，不输出到聊天、截图或日志。真实发送只用明确授权的测试会话，未知结果先查原回执。

`node bin/pocket.mjs service install --apply` 可安装用户级 LaunchAgent；`service uninstall --apply` 会停止并移除该自有服务登记，保留数据、附件、配置和原 Codex。先用 Ctrl+C 停止前台服务再安装后台服务。非默认配置的安装、`service status` 和卸载命令都追加 `--config /absolute/private/pocket/config.json`；口令维护使用同一路径的 `POCKET_CONFIG`。没有 `service stop` 子命令。

运行 `doctor` 只验证环境和基本来源，不等于手机网络、原会话执行和所有功能都已验收。完整安装、维护、隐私和例外见 [英文指南](SELF_HOSTING.md)、[兼容范围](COMPATIBILITY.md)与[升级恢复](UPGRADING.md)。正式公开前仍需独立新 Mac 首装与实体手机验收。

Codex 不在标准应用目录时，在所选私人 `bridge.json` 设置实际签名 App 的 `appPath`，核对 Python 路径，再使用同一配置运行 doctor；这些机器绝对路径保留在私人配置中。
