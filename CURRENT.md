# Pocket 当前状态

维护日期：2026-10-23。本次仅整理交接文档；代码与发布回执核对到下列版本，线上验收事实截止2026-10-22，未把旧PID/健康快照当作今日在线保证。

## 下一次先看

- **最近待续：运行中与未读互斥，尚未实现。** 欧吉安提出运行中不应归入未读；会话里已给出“运行中优先、结束后按阅读水位判断”的方案，但随后处理的是横滚故障，没有实现这一调整。当前代码和回归仍允许运行中同时计入未读。具体范围、证据和验收条件见[待续方案](docs/design/2026-10-22-pocket-read-state.md#待续运行中与未读的列表呈现)。不要把上一条建议当作已上线。
- **已完成且无需重做**：Pocket阅读水位＋单向吸收桌面已读，以及详情横滚/右滑返回修复均已发布、回读并清理。没有待续上传、服务切换或未完成的本轮外部操作。
- **继续方法**：先读[AGENTS](AGENTS.md)和本页，再沿对应设计入口看代码与回执。普通接续不用重读全部历史；需要原始取舍时看[HISTORY](HISTORY.md)。

## 继续方式

用途保持为手机查看和接续 Mac 上的 Codex 原会话。欧吉安已认可统一、安静的视觉方向，后续精修完整操作路径，优先减少重复入口、反馈和阅读占位，不重新推倒整套UI。设计复盘见[顺手标准](docs/research/2026-10-11-pocket-interaction-retrospective.md)。

开发按新的用户反馈继续，不恢复旧“持续打磨 Pocket”heartbeat：2026-09-30用户取消，10-01回读为PAUSED。这与Pocket服务、用户已提交队列和通知的运行无关。Claude接入仍延缓；Happy/HAPI只作为阅读模型的参考，没有迁入其runner/hub。

## 最近已验证版本

| 范围 | 已核对记录 |
| --- | --- |
| 公网与本机 | [x.fangs.cc](https://x.fangs.cc) / [threads.local](https://threads.local)；API loopback4397、连接器健康4399，配置在 `config/` |
| 前端/网关源码 | `7640ba1b887b2ca9b32932616b6e07e1311288a5`，修复详情横滚；文档提交 `bedc4ab` 仅记录发布 |
| 两机API源码 | `0dbdf39c904877de152fc29a9a1d4f8910a43f2e`，已读合并；前端与API版本不同是正常的分层发布，不需要为对齐SHA重启服务 |
| 前端build | `b794a7805c6b09868fc1691cf5b645adb3cffc5a617519f5eb9f3681e95951d4` |
| Pages部署 | `ee918004-7835-44f8-8be9-c922b047fb41`；10-22 ready=true，29/29公开文件和功能检查通过 |
| 最近验证 | 1326项全测；横滚修复166项浏览器检查，含Chromium CDP触摸输入与WebKit几何/DOM滚动。已读合并64项浏览器、豌豆127项回归及两机公网提示/正文回读通过 |
| 证据 | `.local/qa/detail-overflow-2026-10-22/release-verdict.json`、`report.md`、`pages-deploy-after-auth.json`；`.local/qa/merged-read-2026-10-22/final-verdict.json`、`public-read.json`、两机upgrade及CR回执 |
| 数据与运行 | `~/Library/Application Support/CodexNavigator/`；两轮均保留11条既有待发记录、逐条投递策略与凭据。最近一轮仅网页更新，未重启两机API/Codex/隧道 |

本次交接不推送或重发部署。后续涉及运行维护时再查实际进程、服务配置和公网；历史发布、完整旧能力描述与路由已归入[整理前快照](HISTORY.md#2026-10-23-接续整理前快照)。

## 必须保持的产品决定

| 主题 | 当前行为与权威入口 |
| --- | --- |
| 阅读状态 | 客户端按电脑＋来源scope＋thread ID保存版本水位，不存正文。实际可见阅读立即标读；新鲜桌面已读提示只推进对应版本。原生旧true不反弹；新内容重新未读。见[阅读状态](docs/design/2026-10-22-pocket-read-state.md) |
| 单向合并边界 | 原生只有会话级布尔标记，没有逐消息水位。服务端将提示绑定精确内容，至少两次间隔2秒复核；未知、运行中或扫描失败撤销候选。此处“运行中不新确认桌面已读”不等于列表已排除运行中的未读 |
| 阅读与输入 | 默认单条输入栏，展开保留原textarea、草稿、选区和IME；错误在对应卡片/输入条内轻量呈现。见[单条输入栏](docs/design/2026-10-13-reading-composer-and-row-state.md)、[反馈收敛](docs/design/2026-10-22-reading-errors-and-sort.md) |
| 导航与排序 | 分类/项目、状态、排序是独立维度。全部/关注/置顶保持；Pocket关注与Codex置顶独立。创建按创建时间，活动及列表显示时间按最后消息时间，不能用点击时间冒充。见[智能排序](docs/design/2026-10-14-smart-navigation.md) |
| 多机与模型 | 电脑信息只在设置，记住选择，原owner/目录/模型/权限不跨机。支持同型号思考强度；新建保留目标桌面的有效默认强度，不能统一硬编码Ultra。跨型号仍未开放。见[多机](docs/design/2026-10-17-multi-machine.md)、[模型](docs/design/2026-10-18-model-settings.md) |
| 发送与缓存 | 自动直接发送默认开，只影响新提交并逐条保存策略；旧队列不升级，未知不重放。活跃预取最多32项，前台刷新状态，不取正文、不连接或标读。见[直发](docs/design/2026-10-22-auto-direct-send.md)、[预取](docs/design/2026-10-22-active-thread-prefetch.md) |
| 消息与附件 | 用户长Query可展开；文件引用与Codex标记走统一受控解析。附件、下载、发送回执不借阅读缓存扩大权限。见[消息组件](docs/design/2026-10-22-message-components.md)、[附件](docs/design/2026-10-10-attachments.md) |

其它功能和代码路由只在[AGENTS](AGENTS.md)维护；能力对照见[DESKTOP-PARITY](docs/DESKTOP-PARITY.md)。

## 阻塞、未决记录与验证缺口

- **原生标读写回未稳定恢复**：10-22重启后的Codex仍有双listener/readback_unconfirmed证据。当前主线不依赖写回；不因蓝点不一致重启Codex、批量补标或改原存储。旧局部成功只证明当次对象，见[原生同步历史](docs/design/2026-10-05-read-state-sync.md)。
- **归档仍可能长期等待writer**：原会话或spawn子树被桌面持有时，独立CLI/RPC不能完成。共享原Core的stdio适配器只做过隔离原型，未安装，真实GUI与桌面副作用未验。用户要求“Tabbit调研”及相关子会话先保留，已取消请求不得恢复。见[归档owner研究](docs/research/2026-10-16-archive-owner-route.md)。
- **旧发送未知结果与队列**：本轮未重放或清除旧条目。09-30记录只作检索入口 `.local/qa/connectivity-2026-09-30/dispatches.json`；下一次操作先查当前账本与原历史，不凭历史中缺少文本判定未发送。
- **真机与通知**：浏览器/CDP验证不等于iPhone PWA、真实键盘、锁屏通知或长期切网。豆包语音手动切回可以填入文字，自动唤回未解决；见[原排查](docs/research/2026-10-09-ios-doubao-pwa-return.md)。清站点数据/重装PWA会失去浏览器阅读水位，跨手机已读同步未实现。
- **其余范围**：共享桌面队列、分叉、工作树创建仍未接入；慢owner拖延后台串行队列的长尾待观察。仍为个人部署，未公开开源，不能承诺任意账号即装即用。

## 运行维护与恢复入口

- 本机项目是 `/Users/fangs/workspace/side/codex-navigator`；用项目的 `config/local-service.json`、`config/pages-site.json` 和FBT既有服务/发布工具。前端样式修改只发布网页。
- 豌豆已验证SSH配置为 `/Users/fangs/.ssh/ged-yuzu.conf`，目标 `wandou`；远端根为 `/Users/fangs/workspace/projects/codex-navigator`。10-22 `.local/current` 指向API源码 `0dbdf39…` 的release，机器私有配置在 `.local/config/`。远端脚本用已验证 `/opt/homebrew/bin/python3.13`，不要假定非交互 `python3` 足够新。
- 豌豆 `node_modules` 仍引用 `2f42176f35494c57212f9424d113f0437fae3d5d` release；连接器仍使用 `19d91ed4776d79fce17a79ed88ed3b79622197e7`。清理前核对依赖和launchd真实指向，不按旧日期删除。
- Pages预检401先用配置中的Wrangler `whoami`续期，核对是否上传；已上传但验证未过使用原部署 `resume --resume-verification`。本轮两个发布都已完成，不重复提交。
- 临时浏览器、fixture、传输tar、重复baseline-dist已清理，必要证据与运行/回退release保留。旧脚本中已删除的tar路径不是现成恢复包；继续发布须根据当前源码和元信息重新准备。
- 仅文档维护检查事实、链接和diff后本地commit；不跑产品部署。功能改动的验证与受控真实发送范围遵循[QUALITY](docs/QUALITY.md)。
