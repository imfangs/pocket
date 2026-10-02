# Ged 模型选择实验与撤回 · 2026-10-02

## 最终范围

方帅明确“模型切换先不用做在APP里面了，其他都保持继续开发”。因此撤回本轮模型选择接口与服务端候选，Ged继续继承原Codex对话设置，模型在Codex管理。原型提交`c738bc4`及终止失败恢复修复`ee97dc9`保留在Git历史；撤回提交`4ceaf91`、`0e824c9`。不保留未采用的公网写入入口。

## 实测结果

- 原owner的`thread-follower-update-thread-settings`可以更新原thread下一轮model/effort，设置回读与实际生成是两个验证阶段。
- Astra→Luna设置确认，Luna两条连续消息均完成、逐字回显一致、0工具；说明该样本中设置能跨轮沿用。
- Sol设置确认，但生成遇到上游429；不能按配置候选宣称可用。
- Luna→Astra设置确认，随后生成失败`invalid_encrypted_content`。失败项目精确追溯到本次Luna QA产生的一条加密reasoning。没有证据支持将同一provider标签、候选目录或HTTP设置成功等同于历史密文兼容。
- 模型超时回执的移动端重启恢复、所有读取入口的不可变目标校验，也需在未来重启此功能时重新设计和测试。未发布的客户端原型已删除。

## 受控对象恢复

仅对受控QA原thread的Astra请求使用既有代理的精确hash兼容项，省略上述一条Luna QA隐式推理；from/to使用同一原通道标签。原AppID、模型/effort/provider、原历史前缀、可见消息和工具记录保持。Astra随后完成唯一受控回显且0工具，恢复原归档/非置顶状态，只移除本次自动重试排除项，并回到开发任务。

兼容项仍保留，否则旧QA密文会再次导致Astra失败。这是对本次测试副作用的有界修复，不是完全原样回滚，也不是未来产品默认的跨模型策略。没有全局剥离加密内容、编辑Codex JSONL/SQLite或新建执行实例。

私有证据：`.local/qa/model-selection-2026-10-02/`中的`roundtrip-source.json`、`cleanup-summary.json`及其引用回执。原型201项测试通过只证明合成契约，不替代以上真实生成结果。
