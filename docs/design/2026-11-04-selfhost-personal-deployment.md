# 自部署准备版部署到现有 Pocket

2026-11-04。用户授权部署并要求保留现有使用。此次是个人格得／豌豆与共享x.fangs.cc的升级，不是公开源码仓库或外部自部署正式发布。

## 版本与配置

两机API运行`da53fa306909dc8a4c3cf97f59d84b779afe23b9`不可变release。网页/Worker发布源码`7e24660b1c20cc5e04eeebc6c5d6ec8928746587`，build`1ef5620b64d244c0f0c1d909b192f5fb0deb72d2941e89ff415bd816b658a7c0`，Pages`2dff18cb-ab4c-4788-a86f-d76087080b6c`。35/35公开资源与项目功能回读通过，另行下载公网version/bootstrap与本地产物一致，只上传一次。

公共和格得本机使用原ged默认＋ged/wandou profile，原Cookie名称、电脑ID、浏览器偏好和公开入口保持。豌豆本机动态引导为wandou单机，手机仍使用共享公共profile。两机显式保留原bridge/Python配置、通知subject与VAPID，不启用通用新部署口令策略，不轮换现有access/relay凭据。

格得服务管理继续使用稳定`config/local-service.json`，内容指向本机`.local/releases/da53fa…/server/index.mjs`及保留的私有profile。豌豆继续稳定`.local/config/local-service.json`，其bridge/client固定在`.local/config/desktop-bridge-da53fa306909.json`与`client-da53fa306909.json`。格得运行Node26；豌豆的已用Node24在此次隔离回归与HTTP下确认可运行现有server入口，未以新安装CLI的Node26门槛强行替换或升级系统运行时。独立自部署仍按声明的Node26执行。

## 切换与数据

先准备候选和旧source回退、核验字节与依赖，再分别stop→确认launchd卸载→停机备份→原稳定source配置原子切换→up service-only。Codex、连接器及本地域名代理未重启。每机只执行一次实际成功切换，没有重放未决上传、发送或服务操作。

停止前最后短SQLite采样无active写入；停止后再次核验已持久交付身份和正文哈希。格得原有1条queued记录保持；豌豆0条。access、VAPID、relay、反馈配置，source scope、逐条直发策略、交付/附件记录、隐藏/关注偏好和原auth_sessions表均前后一致。完整数据库/凭据/附件停机快照留在私有QA；活跃连接器的connection.json/.tmp只作动态哈希观测，排除在静止数据快照外。检查是采样保护，不宣称原子在线drain，不回写业务快照覆盖后续回执。

所有实际生命周期动作沿管理器已登记source路径，不能拿dry-run通过当成另一配置路径拥有当前job。原QA候选路径因command/cwd不同而不满足owned，已在实际切换前修正。异常路径经过本机11项mock与远端6项恢复测试：日志/备份失败不阻断可用性恢复，SIGTERM进入保护；健康候选保留；交付改变或不可读时不盲回滚源码/数据，已卸载则恢复所选同一source。SIGKILL/断电须读journal和实际状态接续。

豌豆原依赖树保留，新release建立只读共享目录overlay并补精确i18next26.7.1；322个当前平台包缺失/错版0，原依赖合同未变。传输原补包因AppleDouble元数据在提取前拒绝，清理后合法内容SHA复核；没有候选服务误启动。

## 验证层

- 2,029全测；私有配置51项完整浏览器/设施与四条双引擎/双机附件发送等合成链路。
- 豌豆161隔离回归、6项合成HTTP，809个release文件hash，预备及切换后的源/依赖/配置身份独立回读。
- 两机实际loopback认证目录和deployment/source readiness200、匿名目录401、动态profile200；本地域名HTTPS服务回读ready。
- 公网两机health200/身份匹配、匿名目录401；manifest/index meta/资源/SW/bootstrap匹配。
- 格得公网新登录/只读catalog/deployment200，原Cookie名与HttpOnly/Secure/Strict保持；本次QA会话logout200且context关闭。
- 豌豆原部署不保存明文口令，未猜测或重新登录，未轮换其凭据。已有auth_sessions表和access哈希保持，loopback认证读取及公网路由/匿名拒绝通过；fresh公网登录这一层明确未验证。

没有真实发送、激活owner、修改用户偏好或原Codex数据用于QA。浏览器与真实HTTP并不等于实体iPhone键盘、长期弱网和外部新Mac首装验收。UI更新仍由用户明确点击，草稿与未决操作保护保持。

证据：`.local/qa/deploy-selfhost-2026-11-04/`内`local-switch-result.json`、`remote-switch-output.json`、`remote-independent-verify.json`、`local-private-api-independent.json`、`browser-only/public-readback.json`、`pages-deploy.json`与`release-summary.json`。脚本、停止快照及独立复核保留；临时传输/重复构建收尾可清理，当前/回退/依赖树不能按旧日期删除。
