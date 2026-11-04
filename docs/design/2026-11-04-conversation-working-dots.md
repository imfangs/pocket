# 会话末尾的运行反馈

2026-11-04。用户截图中，最新 Query 下方没有进度反馈，只有输入条显示「运行中」。此次在会话正文的真实末尾增加三个中性圆点，帮助确认原 Codex 正在处理当前轮次。

## 状态与位置

`conversationIsWorking` 只接受本次页面已通过网络读取的原桌面状态：`source=desktop`、`resumeState=resumed`、`runtime=active`、非空 `activeTurnId` 与 `latestTurnStatus=inProgress`。缓存首读、纯排队/accepted、离线、读取或连接失败、实际阻塞请求、上下文压缩、归档/不可用，以及明确兼容性失败不显示。

显示观察代次独立于原阅读缓存基线：visibilitychange/pageshow 恢复时递增代次并撤销旧 active 观察，owner GET 开始时记录代次，只有相同代次的响应才重新显示；读取失败也撤销。不修改阅读缓存、网络基线或现有恢复请求。独立CR补齐了后台完成后旧 snapshot 复亮，以及 pageshow 前已经在途的旧 active GET 不能更新恢复后的动画两种反例。

同轮停止的 pending/accepted/unknown/stopped/ended 回执和精确同轮的已记录 terminal timing 会隐藏圆点。旧轮停止或最终回复不能隐藏新轮的工作；异步可选问题也不被当成阻塞操作。该判断仅用于展示，不参与发送许可、队列或回执核销。

原生 activeFlags/unconfirmedTurnSubmissions/goal confirmation 可能等待用户，但没有可投影的请求卡。只在 `canSend=false` 且命中原 owner 明确「等待审批或输入」提示时排除；不能把普通设置写入核对或其他发送能力限制概括成模型停止。

圆点放在最新 Query/助手进度之后，位于普通消息滚动区域，不使用固定悬浮位置。分页查看旧历史时不显示；在同一正文内上翻时圆点仍留在真正末尾而非旧消息附近。复用原贴底 effect、选区保护和阅读位置，状态切换不重新挂载 Query、消息或输入框。

## 动效与可达性

无需新库或 JavaScript 时钟。5px 圆点使用 ink 色，opacity 0.55–1、纵向移动2px；循环1.2秒，错峰0/120/240ms，复用 `--motion-feedback` 与 `--ease-move`。动画只更新 transform/opacity，不改变布局。

减少动态效果沿用现有全局约定：三个静态点，opacity 0.7。读屏仅有一次稳定的「正在运行 / Running」状态文字，圆点对读屏隐藏；CSS 循环不会重复修改 live region。

## 验证

- 4项业务状态回归覆盖缓存/排队、真实运行、阻塞/失败、原生无卡等待、同轮停止和已记录结束、旧轮反例。
- 完整2,045项测试通过；最后恢复页代次修正仅涉及显示回调，受影响的6项实际浏览器流程追加复验通过。
- Chromium/WebKit 6项实际 Conversation 专测通过：新鲜状态、单 Query 身份与输入焦点、完成/阻塞/压缩/旧停止/失败/断网、切换会话，以及英文/暗色/减少动态与上翻位置。
- 中期完整59项浏览器/设施检查通过；最终pageshow在途旧响应修复后，6项Chromium/WebKit专测再次通过。最终版本与发布由 root 集成回读；本轮没有目视、实体 iPhone 或真实发送，没有发布、服务重启或后台操作。

证据：`.local/qa/working-dots-2026-11-04/`。原生触感和细节质感仍需实际手机使用反馈校准。

## 共享网页发布

发布源`dd7e01376474ee0ef04fbbb11983ba0546f2bc3a`，UI实现提交`3b72330`。沿用私有个人双机Pages兼容配置，不用通用MyMac profile覆盖现有入口；仅共享网页/Worker更新，无Mac API/Codex/连接器重启或真实发送。最终版本`92bfebf04a0ff1f22e2d2369f8084af11619fe406dd33500db7c4b111dcfa8f2`，Pages`4e4b5c8a-a06e-44cd-856c-201b2c4ee4a3`。单次上传exit0，35/35公开资源和原功能通过；`release-verification.json`额外对照公网version与private client profile一致。

发布认证先只读inspect确认过期/无未决操作，再单次refresh成功且28项scope保持，账号/项目GET核验后发布。无重复上传或待续外部操作。最新源码原全测2,045、净历史候选1,872合成及构建通过；最后epoch相关6双浏览器流程已在最终包复验。上述均不是实体iPhone或目视验证。

## 2026-11-05 水平居中

按用户要求，运行三点改为在消息正文的可用宽度中水平居中。仅给 `.conversation-working` 增加 `justify-content: center`，行高20px、下方8px留白与动画保持；不修改状态判断、恢复代次、消息/输入节点或阅读锚点。验证与发布回执在 `.local/qa/working-dots-center-2026-11-05/`，发布身份完成后追加。

居中版源`34e30d4`，build`5419a550501602fdccd99cc7a7c16c2f9f7a50b43c95a80ae4de91cff7013f1a`，Pages`71dbcaf2-469f-409c-8d0e-abd3bc9b6161`。2,045全测、24屏双浏览器/中英/亮暗居中误差0、原6状态/阅读/epoch流程通过；行高20px与8px留白不变。上传前账号GET401，确认过期且无未决后单次续期（28scope保持）并目标200核验，随后只真正上传一次。35/35资源及原功能通过，独立公网version/profile一致，无API/Codex/连接器重启或未决发布。
