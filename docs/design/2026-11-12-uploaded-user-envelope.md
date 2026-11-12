# 已上传用户图片的保存历史展示

2026-11-12。指定会话的原生历史已经包含 68 字实际 Query 和一张已上传附件；保存历史是 507 字的 Files mentioned 包装，包含四个 typed part：文件上下文与 Query、图片开标签、真正 input_image、图片闭标签。旧文字投影跳过图片块后拼入开闭标签，随后附件记录的旧精确 wrapper 匹配失效。

`shared/user-attachment-envelope.mjs` 是纯显示 schema，只接受完整已知 formatter 前缀、字段和终端图片标签。它返回 Query 与描述性附件信息，不登记文件、不开放路径。`server/history.mjs` 只有在真实 typed 图片与开闭文本段、顺序、计数、路径一致时才产生内部 attachmentPaths；注入 provenance、代码和纯文本 XML 没有这份证明。

`Attachments.enrich` 在 desktop/rollout 来源上把完整 wrapper 的 Query 与 paths 精确匹配同一线程已存在的附件派发记录。真实已上传附件沿用稳定的私有 attachment URL、SHA 和预览元数据；新形状保留原 id、role、turn、timestamp 和全部 raw text，不核销回执或改变派发指纹。旧 formatter 的精确绑定显示保持原契约。

`attachmentEnvelope: true` 仅是服务端产生的显示证明。前端只有带此标志的完整消息才抽取 Query，并复制同一可读 Query；未知、截断、引用、代码与用户自写相似 wrapper 保留原文。真实 typed 图片没有对应的已上传记录时，只显示无链接、无图片请求的「附件需在 Mac 中查看」卡。纯阅读缓存仅保留这个用户消息 boolean 与 raw text，不保存 attachmentPaths、附件 URL、files/images 或读取能力；重新认证并取得新 manifest 后才恢复实际预览。

真实指定样本的候选投影已用只读 Pocket DB 核对：raw SHA 与旧保存消息一致，显示 Query SHA 与原生 Query 一致，准确关联原已上传 PNG，原 accepted 状态保持。没有复制文件、开启目录权限、修改 Codex 原数据、连接 owner、发送消息或发布；图片字节/解码和手机实际显示由集成验收另证。

`tests/uploaded-user-envelope.test.mjs` 覆盖真实四段接缝的合成等价样本、多图与文件混合、原文/指纹保持、纯文本伪造、代码/引用、未知/未闭合标签、计数/路径/provenance 负例、foreign thread、未知来源、旧 wrapper 与缓存只保存显示证明。真实样本和核验回执仅留 `.local/qa/uploaded-envelope-2026-11-12/`。最终全量、浏览器和发布结果由负责人回写 CURRENT。

同日集成：新实际API只读回读确认该507字raw SHA保持、attachmentEnvelope=true并准确绑定1件附件；910583字节PNG原件200／签名一致。总回归／发布和权限边界见[上传与图片缓存](2026-11-12-upload-pipeline-and-image-cache.md#同日集成与发布)与CURRENT；不把这次读取当成模型发送或Documents权限已恢复。
