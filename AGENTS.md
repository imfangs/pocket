# Codex Navigator · 任务架

个人本机 Codex 会话导航工具。用户在 2026-09-27 授权从研究进入实现：管理大量现有会话，按领域/项目分组，保留稍后继续的意图，并准确打开官方 App 的原会话。

## 接续

先读 `CURRENT.md` 的验证状态；功能与运行命令见 `README.md`，架构/数据契约见 `docs/ARCHITECTURE.md`。研究依据为 `/Users/fangs/workspace/study/research/2026-09-27-codex-thread-management.md`。

## 数据边界

- Codex 是原会话、标题、归档、目录与历史的权威来源。源 SQLite 使用只读连接；本工具不编辑 Codex 数据库、全局 JSON 或 rollout，不创建新的 Agent 执行进程。
- 任务架只保存自己的分组、接续意图、备注和访问记录，数据位于用户 Application Support，禁止提交真实会话数据、截图、索引和备份。
- 以来源 + 原 thread ID 识别会话；导航用原 ID。显示分组不改变 cwd、项目绑定或访问权限。原版归档与本工具“资料留存”是不同概念。
- 运行 idle、旧更新时间、生成摘要不能自动变成用户的待办承诺。默认未分类；用户编辑优先于以后同步。
- 本地服务只监听 loopback，严格校验 Host/Origin。无公网部署、遥测或外部模型调用。

## 实现与验证

React/Vite + Node 原生 HTTP/SQLite。模块分为源导入、导航数据、API、UI；服务生命周期复用 FBT local，配置留在 `config/local-service.json`。

验收覆盖真实源导入、过滤/分组、稍后与接续备注、刷新/重启持久化、原 ID 导航、来源只读和失败保留已有状态；原会话打开须独立回读，不能把 `open` 退出 0 当作导航完成。

使用合成数据做自动测试；本机验收只对任务架元数据操作并恢复测试修改。新增需求先保持当前用户的管理成果，再迭代。
