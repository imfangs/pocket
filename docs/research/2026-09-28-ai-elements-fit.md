# AI Elements 对 Pocket 的适用性

核验日期：2026-09-28。范围是选型评估；没有安装依赖或修改线上实现。

## 判断

值得按组件试用，优先评估 MessageResponse 的内容渲染；Tool / Confirmation 可作为后续执行结果和审批的统一外观。暂时保留 Pocket 的输入框、滚动/阅读位置管理及全部 Codex 控制协议。采用条件是移动体验和维护成本有实测改善，而非仅换一个视觉主题。

AI Elements 是建立在 shadcn/ui 上的 React 组件注册表，组件源码安装到项目中；它和 Vercel AI SDK 的传输、消息状态和模型调用不是同一层。已读的 Message、Conversation、PromptInput、Confirmation 源码对 ai 的引用是类型导入；PromptInput 通过 onSubmit / onStop 回调连接外部逻辑。因此可继续使用现有 Mac owner IPC、Node 后端与 Cloudflare 部署，不必换成 AI SDK 聊天后端。

## 对照

| 组件 | 当前源码的能力 | Pocket 决策 |
| --- | --- | --- |
| MessageResponse | 包装 Streamdown，默认加载 CJK、代码、数学、Mermaid 插件 | 第一候选，先在隔离页面比较中文、代码和不完整 Markdown；当前 react-markdown + GFM 已正常工作，增量需实测 |
| CodeBlock | Shiki 高亮、代码展示相关控件 | 独立工具输出需要时使用，避免与 MessageResponse 的代码插件重复建设 |
| Tool / Confirmation | 工具状态、可折叠输入输出、审批状态展示 | 可复用外观，继续由 Pocket 的请求指纹、一次性审批、未知回执与防重逻辑控制 |
| Conversation | use-stick-to-bottom 容器、跟随底部与跳转控件 | 后置验证，必须保留切换任务后的阅读位置、用户向上阅读时不抢位置、断线缓存 |
| PromptInput | 附件/菜单/选择器、提交与停止回调 | 暂不替换。默认在 submitted/streaming 时把提交按钮用于停止，与 Pocket 运行中仍可排队发送的交互不同；已有 iPhone 键盘/自适应高度也须保留 |

异步选项问题不是通用 AI SDK 工具审批。Pocket 的 questionItemId、原生回复封装和已答状态继续由现有适配层负责，不能用 Confirmation 的 approved 布尔值替代。

## 引入代价

- 官方完整安装指南围绕 Next.js、AI SDK、已初始化 shadcn/ui 与 Tailwind CSS 4。当前 Pocket 为 Vite / React 19 / 普通 CSS，没有 shadcn、Tailwind 或 @ 路径别名。被检查的组件源码本身没有 Next 专用导入，可适配 Vite，但默认安装并非无改动接入。
- Message 注册表带入 streamdown、四个插件、ai、button/button-group/tooltip；PromptInput 还涉及 command、dropdown-menu、hover-card、input-group、select、spinner 等。依赖数量不等于最终包大小，实际构建体积与手机渲染耗时尚未测量。
- 当前 Markdown 明确限制链接协议，不执行原始 HTML，图片只显示链接，不自动请求第三方资源。替换渲染器时必须保留这些行为，并使用已有回归验证。
- 保留用户 / 过程 / 最终回复的视觉区分及清爽手机布局。组件默认间距和状态文案应服从产品现有交互。

## 最小验证

仅在隔离分支或页面接入官方 Message 组件，将 MessageResponse 放在现有消息外壳内，先只启用实际需要的插件。用同一批中文、长代码、表格、未闭合代码块和异步追加消息比较首屏体积、解析耗时、滚动稳定性和 iPhone 键盘。确认收益后再替换 MessageMarkdown；没有收益则保留当前实现。工具结果界面有明确需求后再引入 Tool，输入框最后评估。

AI Elements 用于 AI 内容组件，Motion 用于位移/手势/布局动效，Sonner 用于短暂操作反馈；shadcn/Radix 是通用控件基础，应共享一套，避免并列建立多套按钮、弹层和主题。

## 当前来源

- 官方总览：https://elements.ai-sdk.dev/
- 安装前置条件：https://elements.ai-sdk.dev/docs/setup
- Message：https://elements.ai-sdk.dev/components/message
- PromptInput：https://elements.ai-sdk.dev/components/prompt-input
- 官方源码仓库：https://github.com/vercel/ai-elements
- 实际读取注册表：https://elements.ai-sdk.dev/api/registry/message.json
- 其他已读取注册表：同路径 conversation.json、prompt-input.json、tool.json、confirmation.json、code-block.json
- 本地对照：package.json、vite.config.ts、tsconfig.json、src/MessageMarkdown.tsx、src/ConversationMessage.tsx、src/QuestionPrompts.tsx、src/ContextStatus.tsx。

页面和注册表可能更新，实际实施前重新核对安装命令、组件 props 和依赖。文档示例不能代替当前源码：本次 Message 实际接收 from + children，并非自动消费完整消息 parts；不能据旧示例推断支持某个 props。
