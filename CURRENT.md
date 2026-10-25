# Pocket 当前状态

维护日期：2026-10-25。新建独立及时核对已上线，消除旧轮询对创建确认的额外等待；当前发布及验证范围见下表。

## 下一次先看

- **最近已上线：新建确认延迟修复**：[定位与验证](docs/design/2026-10-25-create-confirmation-latency.md)。近期格得实际创建约3秒；前端现对已登记的新建请求立即独立核对，不再等待4秒空闲计时或慢旧归档批次。同ID单飞、后台/离线暂停、恢复及时检查，未知不重放。合成后端已就绪场景的额外反馈由3810/7404ms降至54/92ms；1354项全测、浏览器计时、独立CR与29个公网资源/功能回读通过。实际手机耗时不由合成计时保证。

- **最近已上线：重命名快速清空**：[交互契约](docs/design/2026-10-11-rename-and-management.md#2026-10-25快速清空名称)。名称右侧清空按钮可一键删除原标题并留在输入框；空白名称禁用保存，未决操作保护保持。1344项全测、73项双浏览器检查及29个公网资源/功能回读通过，只更新共享网页。

- **已完成：豌豆更新与附件恢复**：[本轮契约](docs/design/2026-10-25-wandou-update-and-attachment-recovery.md)。CLI0.164精确版本通过142项真实隔离验证；豌豆API与内置网页已切换到 `1d6da5c`，公网附件修复也已发布。空稿附件列表失败不再强迫大面板，条内保留轻量重试，真实附件保护保持。1344项全测、远端170项、44项浏览器、独立CR和29个公网资源通过；目录/scope/型号读取正常，未重启Codex或连接器。

- **最近已上线：发送画面连续性**：[输入与发送连续性](docs/design/2026-10-25-send-ui-continuity.md)。普通发送保留输入焦点，确认后不再误缩为一条；迟到回执不覆盖等待期间的上滚位置。IME、明确收起和键盘导航保持。1342全测、48项双浏览器与833帧消息交接检查通过；29个公网资源及功能回读通过，仅网页更新，系统键盘/PWA真机尚未直接验证。

- **10-25发送等待候选，仍待续**：[调查结果](docs/research/2026-10-25-updates-and-send-experience.md)。发送POST无deadline、等待回执锁按钮、跨会话队列串行与重复history已隔离复现，但具体体感根因和耗时尚未确认；用户明确体感是输入/键盘/画面，因此先修前端。这些后端候选尚未实施；CLI兼容与豌豆更新已在随后完成。后端仍按需SSH发布，未安装自动更新任务。

- **最近已完成**：[引用、刷新和控件](docs/design/2026-10-23-annotations-refresh-controls.md)。问题优先、引用紧凑披露；刷新反馈不叠加且来源失败不假报成功；顶部选中态增强但保持克制。1342项全测、两阶段双浏览器、独立CR/视觉与29个公网资源/功能检查通过。仅网页发布，原始消息/回执/阅读水位与两机服务保持。

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
| 前端/网关源码 | `55564ba4f1f7ac93bf64d72dbf1072e371089752`，新建独立核对；重命名清空、发送连续性与空稿附件恢复保持 |
| 两机API源码 | 豌豆 `1d6da5cb0a29229fa9db6c2a144cc72e77f95895`，API PID73421；格得保留此前 `0dbdf39c904877de152fc29a9a1d4f8910a43f2e` 启动的进程PID8828。分层版本不同无需为对齐SHA重启 |
| 前端build | 公网 `892dc99facccaf4da2036c87ae499b9258e7d6548855d5a39d49c9e69999cfd5`；豌豆内置网页随API release保留 `7cd2cf2e…`，本次共享网页优化不要求重启API |
| Pages部署 | `e9ffb5f9-f3a6-4201-bb3e-4bfee1bb27d2`；10-25 ready=true，29/29公开文件与功能检查通过，上传一次 |
| 最近验证 | 1354项完整回归；新建调度相关35项、真实hook浏览器计时/竞态/网络恢复与独立CR通过。此前清空73项、豌豆170项＋142项CLI、附件恢复44项证据保持；不等同iPhone真机实测 |
| 证据 | `.local/qa/create-latency-2026-10-25/` 的 `release-verdict.json`、`frontend/probe-after-result.json`、`polling-cr.json`、`pages-deploy.json`；此前重命名、豌豆升级、发送与引用证据保持原路径 |
| 数据与运行 | `~/Library/Application Support/CodexNavigator/`；豌豆切换前后旧账本、逐条发送策略、凭据、scope/identity保持，目录同步正常。格得API/两机Codex/连接器进程未动；格得待发数量在使用中变化，不对跨两小时快照声称数据全等。本轮未处置或重放旧条目 |

以上发布已回读完成，接续时不重复上传；新功能改动仍按项目配置发布。后续涉及运行维护时再查实际进程、服务配置和公网；历史发布、完整旧能力描述与路由已归入[整理前快照](HISTORY.md#2026-10-23-接续整理前快照)。

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
- 豌豆已验证SSH配置为 `/Users/fangs/.ssh/ged-yuzu.conf`，目标 `wandou`；远端根为 `/Users/fangs/workspace/projects/codex-navigator`。10-25 `.local/current`、私有服务配置working_directory和launchd实际命令均指向 `1d6da5c…` release；机器私有配置在 `.local/config/`。远端脚本用已验证 `/opt/homebrew/bin/python3.13`，测试也从bridge配置取解释器。
- 豌豆 `node_modules` 仍引用 `2f42176f35494c57212f9424d113f0437fae3d5d` release；连接器仍使用 `19d91ed4776d79fce17a79ed88ed3b79622197e7`。清理前核对依赖和launchd真实指向，不按旧日期删除。
- Pages预检401先用配置中的Wrangler `whoami`续期，核对是否上传；已上传但验证未过使用原部署 `resume --resume-verification`。本轮发布和豌豆切换均完成，不重复提交。
- 临时浏览器、fixture、两次传输tar、重复baseline/fixed-dist及未启用的失败release `fa1168d…` 已清理。当前、回退 `0dbdf39…`、依赖与连接器release保留；清理回执在 `wandou-update-2026-10-25/final/`。旧脚本中的已删tar不是现成恢复包，继续发布须重新准备。
- 仅文档维护检查事实、链接和diff后本地commit；不跑产品部署。功能改动的验证与受控真实发送范围遵循[QUALITY](docs/QUALITY.md)。
