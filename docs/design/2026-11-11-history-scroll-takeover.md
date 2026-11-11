# 历史加载让位于新的滚动意图

同日欧吉安进一步明确问题仍发生在最新一轮；本页历史竞态修复不等于完整最新对话问题已解决。后续来源切换、重复展示与阅读位置保护见[最新对话连续性](2026-11-11-live-source-scroll-continuity.md)。

2026-11-11。欧吉安反馈「飞象工作台」向下滚动跳回，无法到消息底部。只读该会话保存投影的结构：19条、hasMore=true、idle、最后final682字符，尾部多条过程消息；没有读取业务服务、发送或打开owner。该结构不单独证明全部手机回跳的唯一原因。

实证发现useEarlierConversation在loading/ready/error等每次reader通知捕获锚点，React稍后commit还会恢复：用户在通知后140→440，新渲染又将scrollTop恢复140。实际hook可控commit的旧版3/5失败，真实React Chromium/WebKit旧版0/2；新版本保持440，真正prepend仍保持新选择的同一消息及像素偏移。

锚点记录capture的scrollTop，在DOM修改之前的render阶段发现新位置差超过2px便撤销旧锚点；不把DOM提交后prepend/native anchoring自身调整误认成用户滑动。未关闭历史加载、未更换滚动根/消息节点，不改一般最新跟随、草稿/回执、模型状态或返回栈。

5新增hook/31相关history纯测、代理8浏览器与Root最后48同版历史/返回栈/结构消息/发送阅读回归通过，完整2181中2179过，2项旧原生恢复范围失败保持。Root首轮广回归日志在前两通过后记录启动失败但没有完整明细，单独2项TAP与同源48TAP复验均通过；原失败日志保留，不指定未经证实环境原因。没有真机惯性采样，目标手机完整现象仍以使用反馈校准。证据`.local/qa/scroll-history-2026-11-11/verification.json`与`.local/qa/scroll-rebound-2026-11-11/`，最终发布回CURRENT。
