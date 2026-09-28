# 远控实现原理文章：来源与交付记录

日期：2026-09-28。本文档供后续维护者核验，不作为文章正文发布。

## 产物

- [article.md](article.md)：完整中文正文。
- [architecture.svg](architecture.svg)：与学城上传版本同源的架构图，SVG 内含可编辑 mxGraph 数据。
- [architecture.drawio.xml](architecture.drawio.xml)：学城上传所需的平铺 mxCell 源。
- 私有发布、正文回读、权限与发送证据：项目根 `.local/shares/2026-09-28-remote-control/`。该目录受 Git ignore 保护；不把公司收件人信息、学城对象 ID 和鉴权数据放入可共享源码。

## 事实基线

读取时仓库 HEAD：`a69d4c1`，工作区初始干净。发布回执绑定前端源码 `a327e5d742bc3c9611f9617fd7aa1719ce0212e4`，部署 `64c50223-0b00-44c7-b3e9-9197504548bb`。本文没有改造产品、重新部署或向真实任务发送测试 query。

| 文章结论 | 当前源码与证据入口 |
| --- | --- |
| 两入口共用本机 Node，loopback/Caddy/4397 | `config/local-service.json`；`server/index.mjs:287`；`docs/QA.md` 服务与拒绝路径 |
| Pages 与 Worker 分流，KV 寻址与转发 | `edge/worker.mjs:53` 起的 fetch 路径 |
| 5 分钟续登记、15 分钟 TTL、机器 key 与管理凭据隔离 | `bin/tunnel.mjs:90` 起；`bin/publish-connection.mjs`；`edge/worker.mjs:11`、`:44` |
| 来源只读、分组独立 | `server/source.mjs:6`、`:10`、`:12`；`docs/ARCHITECTURE.md` 所有权契约 |
| owner 快照、steering 去重、可发送状态 | `bin/desktop-bridge.py:38`、`:51`、`:70`、`:124` |
| rollout 路径、身份与字数边界 | `server/history.mjs:60` 起；`parseHistoryLines()` |
| dispatch 账本、requestId 哈希防重、unknown 回读 | `server/desktop.mjs:76`、`:124`、`:145`；`src/Conversation.tsx` 的 receive/submit |
| 原 owner 执行且继承设置 | FBT `experimental/codex-retry/scripts/app_ipc.py` 的 `snapshot()`、`start()`；`bin/desktop-bridge.py:128` |
| Cookie、CSRF、loopback bearer | `server/auth.mjs`；`server/index.mjs:103` 起；`edge/worker.mjs` 的头白名单 |
| 展示、刷新、HTML/链接/图片边界 | `src/Conversation.tsx` 的 8000ms 定时器；`src/MessageMarkdown.tsx` |
| 已验证与待验证 | `CURRENT.md`；`docs/QA.md`；下列既有验收回执 |

本次独立回读既有 `.local/pages-site.json`、`.local/pages-site.integrity.json` 和 `.local/qa/markdown-rendering-browser.json`：发布身份吻合，10 个公开文件匹配，浏览器记录包含真实历史 Markdown 结构、390px 布局与无 error/warn。33 项测试结论引用同日 `docs/QA.md` 的已执行记录；本次文档任务未重跑产品测试。

## 文档验证与维护

本地 Markdown 经现有 remark AST 生成原生 CitadelXML。XML 有且仅有一个首位 `km-title`，五张原生表格、三段原生代码块，不使用 `km-markdown`。官方转换器校验及本地往返文本比较通过。图形按坐标检查正交连线、非端点节点遮挡与交叉，并经过受控预览；域名注释放在走线通道外，去除了渲染器对未知 shape 的提示标记。

远端内容修改遵循读取最新 XML → 在占位段插入上传后的 `km-drawio` → 带 stepVersion 更新 → 再次读取。发布与消息最终结果以私有 `delivery.json` 为准。正文修改应先更新本文目录下的 Markdown，再针对最新远端 XML 做必要修改并回读；不以聊天摘要代替正文，不用旧 XML 覆盖用户编辑。

## 边界

- 本文分享架构与实现原理；不含实际口令、Cookie、API token、机器 key、账户标识、真实聊天正文或个人绝对路径。
- 图中的箭头是应用请求方向；隧道的建连方向另有文字说明。
- 传输加密与端到端加密分开；不把“不存 KV”扩写为云端不可见。
- accepted、执行完成、真实端到端验收三者分开；手机真机与休眠/隔夜可靠性继续待验。
- 学城目录与标题查询仅用于确定现有个人分享位置和避重，未读取无关正文；搜索不返回高密文档的限制不作为“没有任何历史文档”的证明。
