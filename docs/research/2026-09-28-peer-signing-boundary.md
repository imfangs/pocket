# 新建任务路径的签名边界

核验日期：2026-09-28。对象为本机 Codex App `26.903.71938:8576`，不是对未来版本或公共 SDK 的承诺。

## 结论

给 Pocket 辅助进程签署自己的 Apple Developer ID、使用临时签名或办理公证，不能使它获得当前 App Tools 原生管道的信任。此处要求固定的 OpenAI 团队身份和程序身份链，不是通用的 macOS「已签名即可」。

## 只读证据

- `codesign -dvv /Applications/ChatGPT.app`：Developer ID Application 为 OpenAI OpCo, LLC，TeamIdentifier 为 `2DC432GLL2`。
- 当前 `/opt/homebrew/bin/python3`：ad hoc 签名，TeamIdentifier 未设置。此前只读 tools/list 探测被拒绝，桌面日志原因为 `missing-code-signing-identity`。
- App 打包模式为动态 App Tools 管道启用 `browser-use-peer-authorization.node`，读取 Unix socket 对端的系统 audit token，再读取当前进程、父进程和祖父进程的签名身份。
- 对原生授权模块进行只读静态检查确认：三个层级均须具有身份；团队标识比较常量是 `2DC432GLL2`。另有固定签名标识名单，包含 Codex 的正式版/测试版/运行时及指定辅助程序。开发模式分支不改变生产包的上述接入契约。
- 模块 SHA-256：`0f781b0eef12e5c72751af0bb651ce6e68e48eff5e9bc0919317a3a33070a3e8`。
- 私有反汇编证据：`.local/qa/peer-authorizer-disassembly.txt`。未修改 App、未重签其可执行文件、未调整校验配置、未再次尝试绕过管道。

## 对 Pocket 的影响

现有网页历史、排队、Steer、压缩和命令审批通过另一个版本限定的 owner IPC 工作，本次只读诊断没有改变这些功能。

一键新建任务仍待实现。应另行验证由 App 明确支持的创建入口，或评估独立运行服务的产品与权限语义；不能将 App Server 存在等同于能复用当前桌面实例，也不能把仅预填 Mac 输入框的 deep link 当作手机创建成功。已有研究任务可以继续考察同类项目的架构，但结果不能替代当前机器的真实验证。

参考：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。该文档描述传输与任务创建协议，不承诺第三方进程可通过桌面的私有 App Tools 管道。
