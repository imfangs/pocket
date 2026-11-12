# 手机附件发送

2026-10-10，方帅选择直接路线：手机选图/文件，经Pocket认证连接上传到Mac，再交给原Codex会话。FBT `msstest-share` 的公网文件分享不作为会话附件的默认中转。当前入口在已有会话的输入框旁，新建弹窗仍以文字Query起笔。

## 交互与恢复

回形针调用系统文件选择，也接受输入框里粘贴的图片。附件卡显示名称、缩略图或文件图标、上传状态，可移除、重试或核对；只有全部上传完成才能与文字一起发送，也允许只发附件。上传归属于共享草稿Map，切换会话后继续完成；迟到结果只更新同一个上传ID，不覆盖新文字或新附件。

上传与发送各有独立编号。上传回复丢失先GET元数据核对，不自动重传；发送回复未知只查原requestId，不自动重发。附件随已提交卡片和待发队列保存，排队文字可编辑，附件身份保持。原生完整回显必须同时匹配requestId、文字及附件，才能替换本地提交记录；仅看到相同文本不算送达。未知发送和服务重启后未决提交持久留在队列供继续核对。

## 本机文件与接口

`server/attachments.mjs` 管理Pocket私有数据目录下的 `attachments/` 与SQLite附件、派发快照、引用关系。目录0700、文件0600；上传只能指定threadId、随机uploadId和文件名，客户端不能指定Mac路径。Cookie/本机认证、同源及CSRF检查沿用现有API。

| 接口 | 用途 |
| --- | --- |
| `PUT /api/tasks/:id/attachments/:uploadId?name=…` | 有界流式上传原字节；同ID/同文件幂等，异内容冲突 |
| `GET /api/tasks/:id/attachments` | 恢复该会话未绑定的附件草稿 |
| `GET /api/tasks/:id/attachments/:uploadId?metadata=1` | 上传结果核对；上传仍在处理时返回409 |
| `GET /api/tasks/:id/attachments/:uploadId` | 认证读取图片或下载普通文件 |
| `DELETE /api/tasks/:id/attachments/:uploadId` | 幂等移除未绑定附件；在途或已绑定附件保持保护 |
| `POST /api/tasks/:id/messages` | 在原有字段上增加 `attachments: string[]`；文字可为空，至少有文字或附件 |

PublicAttachment只返回id/name/size/mime/kind/url/sha256及原件校验信息，不返回原磁盘路径。图片另有私有 `previewUrl`（原URL加 `?preview=1`），用于最长边512px的小预览；点开仍是完整原件，使用[会话内查看层](2026-10-15-image-viewer.md)并提供固定关闭；发送路径/哈希不被缩略图替换。每条最多6个、单原件与可发文件最多20MiB；本机总附件额度1GiB，最多2000条。未绑定草稿与无记录孤儿超过7天可清理，所有仍绑定的待发、失败、未知和已接收附件保持，以供原任务后续读取。取消消息才释放相应引用，并把附件恢复到可见草稿；别的消息仍在使用的文件继续保留。

图片同时验证真实格式、尺寸（最多4000万像素/单边16384）和可解码性。解码检查生成明确1×1副本，避免按最长边缩到1时横图/长图短边变0；用户原件保持。HEIC/HEIF在Mac本地转JPEG并保留原件。普通HTML/SVG等文件走下载，设置nosniff和sandbox；文件上传不会执行其中的代码。图片与文件不进入公开构建、Service Worker或第三方图床。现有JSON导出仍只备份整理元数据；附件和发送账本需要连同整个Mac私有数据目录保留。

公网转发保持流式body，只给附件PUT增加180秒预算；其他API仍为20秒。上传端190秒超时后保留结果核对，不假定Mac没有收完文件。

## 原会话与历史

已核验桌面 `26.1007.21159:20052` 的start/steer接收原生 `localImage`。图片路径和普通文件的原生上下文元数据通过原owner提交，继续继承模型、cwd与权限；普通文件由原任务按其权限读取。发送前再次验证文件大小、hash和路径，已知requestId优先回读而不重复派发。

Python仅在原生附件元数据与精确文件包装一致时还原原Query，兼容localImage及可证明对应的data URL回显，输出路径元数据供服务端匹配。HTTP只根据该thread已绑定的附件记录生成读取URL，并保留原生消息ID映射；未知路径、普通Markdown链接和伪造附件标签不授予文件访问能力。纯附件消息虽无文字，仍保留阅读卡片。

## 验证入口

相关回归位于 `tests/attachments.test.mjs`、`tests/desktop-protocol.test.mjs`、`tests/edge.test.mjs` 与前端附件/提交状态测试。真实流程和受控模型验收证据在 `.local/qa/attachments-2026-10-10/`；发布身份、通过结果及仍待真机验证的范围统一看 [CURRENT.md](../../CURRENT.md)。

本轮最终628项回归及构建、25项合成浏览器流程通过。原owner实际读取随机图片数字，只有userMessage/agentMessage，native输入为text/localImage；普通文件通过公网上传并由原任务一次只读sed调用读出其独有验证码，两轮completed且原设置/归档已恢复。公网隔离Chrome也通过真实选图上传、512px解码、原件字节hash和删除验证，没有发送消息。

慢上传验收最初的Node流式HTTP/2请求返回NGHTTP2_PROTOCOL_ERROR；独立GET确认uploadId为404、requestId为not_found，未重放消息。随后使用有明确文件长度的curl HTTP/1.1限速64字节/秒，耗时36.6秒、HTTP200并逐字节回读，确认上传没有被旧20秒网关预算截断。浏览器File上传路线独立通过，不把该脚本的传输错误当作手机上传失败。

合成浏览器/临时API均已停止。原生看图验收所引用的小测试文件保留在已记录的私有fixture目录，避免破坏该原会话中的路径；真实公网文件测试附件继续由生产引用关系保存。原始回执和路径只在私有QA目录，不进入公开构建。

## 2026-11-12：上传不中断提交

以上保留10-10的6附件、上传完成再发送及当时验收记录。新的实现改为每条16附件／16路上传，散列准备独立2路；点击发送即可把原File／uploadId移交给同requestId的稳定消息行，输入框可继续编辑。Mac先持久化上传清单及原队列位置，所有文件到齐并校验后才派发，ready不等于accepted；未知结果核对原ID不重放，移除中的附件不能提交。新POST `attachmentUploads`与旧完成态 `attachments`互斥兼容，PUT可带requestId；20MiB单件、1GiB总量、2000条与原权限保持。图片原件／缩略图增加校验元数据并接私有缓存。完整恢复、容量与PWA挂起边界见[本轮契约](2026-11-12-upload-pipeline-and-image-cache.md)；实际发布及最终验证身份看CURRENT，不由本段历史追加证明。
