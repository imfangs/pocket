# Pocket 五项动效实现

2026-10-15。方帅确认将[10-14动效评审](2026-10-14-motion-study.md)中的1–5项全部落地。本轮复用React、CSS与Web Animations API，没有添加动效依赖。发布身份及最终验收数量以 CURRENT 为准。

## 实际行为

| 范围 | 实现 | 保留的边界 |
| --- | --- | --- |
| 详情进退 | 手机点击进入从右侧接入；边缘拖动实时跟手，短拖动回弹，明确距离/近期速度完成返回。最多240ms，途中可反向或被新操作打断 | 桌面、键盘和减少动态效果即时处理；原列表位置、正文/草稿节点保留。文本选择、输入、表格横滚、多指与键盘高度不交给转场控制。 |
| 主动展开/收起 | 长Query、过程内容与更多设置使用180ms有界高度过渡，逐帧保持阅读锚 | 自动后台更新不演出；超过视口中适当距离、选字、减少动态效果时直接切换。原生details保留真实open与ref；浏览器不支持安全关闭内容时，关闭保持原生切换。 |
| 创建和消息衔接 | 创建确认后原弹窗120ms轻退，同时新详情接入；同一Query保留。准确回显/队列接管时，临时卡120ms退出，目标内容180ms淡入；成功提示保留原8秒时长后轻退 | 请求立即执行，动效不延迟提交。沿用requestId、完整正文及附件匹配，不改变接收/发送/完成判定。unknown、失败和编辑中的内容保留，不凭消失猜测成功。 |
| 主动置顶换位 | 只有本次pin的目标值实际确认后，最多8个原本和最终都在屏内的行做180ms纵向移动 | 最终位置仍服从Rank；不动画化后台目录轮询。滚动、触控、选择、覆盖层、范围变化会跳过/取消。外层Y与原左划内层X相互独立。 |
| 状态与轻反馈 | 按实际状态key变化淡入列表状态槽；复制成功后原按钮变为确认图标并淡入；独立图标有轻按压反馈，统一120/180/240ms节奏 | 首屏、重复轮询和时间tick不重播；没有新增数字翻滚、整列入场或持续闪动。键盘焦点、按钮触控区域与状态文字仍可直接使用。 |

## 跨组件连续性

`motion.ts`提供共享时长、曲线、减少动态效果检查与阅读门控。移动中的内容仍可能在自己的滚动根内“可见”，所以详情进退、内容高度变化及回执交接全程持有独立的 `data-reading-overlay` 标记，最后一个运动结束/取消后恢复观察，不提前清除原生未读。

详情平时继续保留原有全高底层遮盖，避免键盘收起时露出列表；只有导航期间临时显露真实列表。没有给visualViewport尺寸、textarea输入高度或其祖先加transition。

创建成功保留原对话框至退出完成，背景新详情同时进入。原生dialog真正关闭后再恢复阅读观察；手机焦点仅在仍是同一详情、没有新焦点或其他对话框时交给返回按钮。普通取消继续恢复原入口，未完成内容确认保持。

选中的回执原文或带焦点的控件可暂停自动离场，切后台也不删除这些节点。回前台重新核对，保护解除后继续退出；取消/卸载清理动画、事件监听和阅读门控。

## 验证与证据

- 基线：生产构建 `a2c69c83ec51d0ba585cb31758c7ffdf7e593f6ba0dd1c2ab02f8566b98ab2fe`。私有基线录屏是同一合成数据的旧构建复现，并非历史真机录像。
- 新回归覆盖：披露反向/锚、原生details同步open和focus、导航/页隐藏/取消、pin屏内换位/横向手势、状态不重播、精确回显和选区/焦点后台往返。
- 分项浏览器验证：`.local/qa/disclosure-motion-2026-10-15/`（Chromium与WebKit）、`.local/qa/navigation-motion-2026-10-15/`、`.local/qa/motion-list-2026-10-15/`、`.local/qa/motion-2026-10-15/receipt-verdict.json`。
- 完整页面：`.local/qa/motion-2026-10-15/app-verdict.json`、`app-baseline.webm`和对应的新构建录屏；覆盖组合时序、320/390px、真实组件与模拟API回执。所有测试数据为合成，不向真实任务发送或管理。
- 完整页面验证发现并修复披露结束时误恢复“跟随底部”的跳位；成功动画的中间帧通过不能替代结束帧阅读位置检查。最终版本与重新验收结果回 CURRENT。

浏览器尺寸和WebKit验证不能替代iPhone主屏幕、实际键盘、语音输入法或长期使用的手感。此前原生IPC未读同步异常仍独立记录，本轮没有通过修改本地蓝点绕过原生确认，也未重启Codex。

## 代码入口

- 导航：`Inspector.tsx`、`inspectorMotion.ts`、`mobileInspector.ts`、`navigation-motion.css`。
- 披露：`useDisclosureMotion.ts`、`UserQueryBody.tsx`、`ProgressDisclosure.tsx`、`AnimatedDetails.tsx`、`useProgressMessages.ts`。
- 交接：`receiptMotion.ts`、`useReceiptHandoff.ts`、`Conversation.tsx`、`Outbox.tsx`、`SubmittedQueryCards.tsx`、`TaskOperationStatus.tsx`；新建由`App.tsx`与`Dialogs.tsx`衔接。
- 列表与轻反馈：`taskListMotion.ts`、`TaskList.tsx`、`SwipeTaskRow.tsx`、`CopyButton.tsx`、`motion.ts`、`motion.css`。
