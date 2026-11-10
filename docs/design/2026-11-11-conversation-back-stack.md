# 会话引用的逐层返回

2026-11-11。欧吉安指出详情中打开另一个会话后右滑直接回列表。会话内容里的卡片/普通链接应建立访问链：A→B→C按C→B→A→列表返回，按钮与Pocket自定义右滑同源。

新增本页内存ConversationNavigationStack，只保存当前machine+readingScope下最多32个父ID。内容引用使用独立pocket-open-reference事件，真正选中目标才push；同ID不增层，普通列表/系统通知属于root替换。未知目标读取失败保持当前详情/原链，较新选择、owner变化撤销迟到引用；新scope、重载或退出不继承旧链。

回退跳过目录已消失、排除或分隔条目，已归档但可读仍可回。回父详情不运行列表焦点归还，沿Inspector的pointer/keyboard意图；只有栈耗尽回列表才用原列表焦点策略。复用原草稿Map与HistoryCache的scrollTop/nearBottom，原读取/输入/回执/权限不改变。每次应用内back同步最小machine/task URL，最终回列表去掉task；不在sessionStorage持久化栈，不增加原生浏览器前进/后退路由。

独立CR修复了missing父跳过、owner变化时取消旧pending、以及清session存储失败不得阻断URL恢复三个具体边界。12纯栈测试/通知目标相关通过，10新增Chromium/WebKit覆盖三层按钮/右滑、草稿/旧阅读位置、同ID/通知root、未知失败取消/换scope/存储异常、missing及归档父；56原通知/卡片/导航/发送/焦点浏览器通过。最终小改仅隔离URL恢复try，最后10同版复验通过；完整2176中2174过、2项既有原生恢复范围失败无skip。没有真实消息/owner/服务操作，实体iPhone手势仍需真实反馈。准确发布回CURRENT，证据`.local/qa/conversation-stack-2026-11-11/`。
