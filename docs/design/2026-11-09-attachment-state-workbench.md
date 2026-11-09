# 附件状态工作台与手机可读性

2026-11-09。欧吉安要求把 Jakub Krehel 的界面 Skills 用到 Pocket，实际寻找并优化问题。本轮选择待发送附件，用真实组件的可达状态做工作台，再用编译后的整套 App 复现与回验。

## 已确认的问题与改动

1. 同前缀、结尾不同的两个文件，在草稿卡上被省略为一样的文字。完整名只放在 span 的 title 中，手机没有可靠的悬停入口。旧构建的 Chromium/WebKit 均复现：名称可用宽度 146px，内容宽度约 270px，结尾被截断。
2. failed/unknown 有两个44px操作按钮，会进一步挤窄名称、状态和错误说明。320px工作台中，unknown文字区仅113px；按钮与文字应在空间不足时分行。

只改 `src/attachments.css` 的草稿卡：名称按内容换行，长英文串也可断行；允许 flex 换行；failed/unknown双操作状态的文字基准140px，操作空间不足就换到下一行，仍靠行尾对齐。单按钮卡沿原 flex 排布，避免短文件名在窄桌面网格里额外占一行。

没有改变组件、状态模型、上传编号、按钮禁用条件、原件/预览、发送门槛或任何 API。消息中已经提交的附件卡保持原样。用户可以读到后缀、区分附件，再决定核对、重试或移除。

## 状态试验与验证边界

工作台导入 `DraftAttachmentList`，沿用 Pocket Theme、tokens和实际样式，操作由无网络写入的 controller 替身记录。覆盖 queued、uploading、uploaded、failed、unknown、removing，以及 checking、离线可本地移除、恢复错误和六附件组合。后两者是组合/页面条件，不能算新增业务状态。

- 最终工作台：Chromium/WebKit × 中英 × 220/320/390/768px × 10场景，160/160，无横向溢出或运行异常。unknown的320px文字区由113px增至213px；两个按钮仍44×44。
- 实际编译 App：24组中英、320/390/768、亮暗主题，两张同前缀附件结尾可读；实际移除第一张后保留第二张。补充4条长英文名链路：失败→键盘Enter重试→结果未知→仅GET核对→已上传→移除。两次PUT分别来自初次尝试和明确重试，核对没有重传。
- 8组 CSS zoom=2 的真实组件检查通过，按钮随之变为88×88；这是640px工作台的CSS缩放检查，不能替代浏览器菜单缩放或实体iPhone。
- 36项附件UI/草稿/提交状态回归通过；TypeScript与构建通过。全库2130项，2128通过，原有两项archive-thread恢复范围失败保持，不跳过或改断言。
- 整包浏览器首个候选165/165通过；最终属性选择器的受影响附件场景另行回验，不能把首个候选的构建ID写成最终版本。

独立复验在收窄选择器时发现WebKit动态`:has`重算缺口：从单按钮进入failed/unknown后，选择器匹配但flex-basis仍为0%，文字仅99px；Chromium为199px。最终改用组件已有`data-upload-status`属性选择器，并在失败→未知→核对的永久回归中检查双操作实际位于文字下方。静态工作台通过不能替代动态状态转换的回验。

修复后的独立定向复验：两浏览器、220/266px卡宽，failed/unknown即时获得140px，操作换至文字下方；切回单按钮恢复原基准，短文件卡仍66px、按钮44×44，无剩余P1/P2。

另一条审查提醒保留：检查文字自身边界不代表所有附件同时出现在屏幕上；六附件或键盘打开的96px上限仍需滚动。新回归同时保留文字后缀Range边界与scrollWidth两种断言，避免WebKit椭圆省略的单一断言误判。

没有实际上传私人文件、发送消息、激活原owner或改变Mac服务。物理iPhone键盘、读屏播报与长期使用未实测。

## 接续与证据

新增永久回归：`tests/browser/attachment-layout.test.mjs`，沿现有合成服务及静态CSP，没有添加生产状态页或依赖。

本地证据：`.local/qa/attachment-states-2026-11-09/`。含baseline/final工作台JSON、同一回归在旧构建的失败与最终构建通过日志、实际App前后截图、zoom方法记录、附件/全库/整包日志。工作台源码和runner仅保留为本地试验入口。

```sh
node .local/qa/attachment-states-2026-11-09/inspect.mjs final
node .local/qa/attachment-states-2026-11-09/zoom.mjs
POCKET_BROWSER_DIST=dist node --test tests/browser/attachment-layout.test.mjs
```

这种工作台的收益是固定短暂状态，并在相同组件/样式下暴露不同操作数量的布局差异。主要长文件名问题也能被已有break-ui发现；本轮不证明新Skill整库优于现有能力，也没有因此安装全局Skills。

上游机制来源：[state-machine](https://github.com/jakubkrehel/skills/blob/659cc4e5b6df90cfe1f306f5ae1c83fa549e075c/skills/state-machine/SKILL.md)、[break](https://github.com/jakubkrehel/skills/blob/659cc4e5b6df90cfe1f306f5ae1c83fa549e075c/skills/break/SKILL.md)。前轮研究见 `/Users/fangs/workspace/study/research/2026-11-09-jakub-skills-for-us.md`。

## 发布接续

状态：本地完成，网页发布待确认。仅共享前端/Pages更新，沿原ged/wandou个人profile；Mac API不需要更新。具体发布回执与最终在线状态待写入本节及CURRENT，不能把本地检查计为已上线。
