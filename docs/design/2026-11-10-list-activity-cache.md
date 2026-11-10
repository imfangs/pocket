# 弱网下保持列表活动状态

2026-11-10。欧吉安反馈短暂弱网会让列表原有「运行中」消失，随后未读、计数与排序也改变。目标是网络波动期间保持已经确认的展示事实，并在列表顶部用一行说明当前状态尚未同步。

## 原链路与修改

`taskStatuses.ts` 在离线、后台、超时、30秒过期、读取失败或服务 unavailable 时清空原运行快照。App 原先把它降为 undefined 用于计数/筛选/排序，TaskList 又按 loading/unavailable 隐藏行状态。阅读目录缓存不存运行状态，因此没有展示回退。

`listActivityCache.ts` 新增独立、本页内存的列表投影，弱网回退最多128个状态/撤销水位，无新依赖与磁盘 schema。明确运行、等待回答及等待确认可在失败、过期、恢复读取或单项 unknown/缺项时继续展示；只有更新的明确原生状态改变活动事实。idle/terminal 撤下活动但保留时间水位，unknown 读取失败不推进确认水位。来源 checkedAt 较旧或同时间冲突的 running 不得复亮；淘汰或移出可见集合后保留安全 discard floor，阻止重入的旧行复活。

当前新鲜完整集合不受回退容量限制；它保留当次逐行来源水位，供同一响应回放与新原生事实比较。本批读使用进入批次时的 discard floor，容量裁剪不删除新鲜行，也不在同批内拒掉其它同时间戳的行；裁剪优先保留活动。完整快照的未知行不推进确认水位，移出 fresh-only 行仍留下安全 discard floor。整包验收暴露的160条同时间戳（128未读/32运行）问题在此边界上修复，不提高缓存上限或修改原浏览器期待。

投影只提供给列表标签、未读互斥、两项活动计数、筛选和智能排序。排序继续使用当前关注、草稿、访问、新建等真实输入，不缓存整个最终顺序，也不制造访问事件或时间。原 `runtimeStates`、hotset/正文预取、权限、发送、停止和详情工作三点保持新鲜状态链路。

## 身份与原生事实

每个 machine + readingScope 创建新 owner，scope 未知不能建立缓存。来源变化当次 render 已拒绝旧 view，旧请求回调也受 owner 与原取消机制保护；不同机器或新页面没有共享内存。401/退出及阅读缓存失效沿原 AccessGate 卸载清理。

详情只把现有网络 history GET 已接受且 activityEpoch 仍一致的事实传给列表。回调在请求开始时绑定原 owner 与本地单调时钟起点；要求 desktop/resumed、本地请求耗时小于30秒，并拒绝明确不匹配的 pocketContent.scope。源 checkedAt 只在同源时间水位间比较，不拿手机与 Mac 的绝对时钟判断新鲜度。运行仍复用 `conversationIsWorking` 的真实原 owner/activeTurnId/inProgress 门槛，不能由缓存或 accepted 推断。active 终态只匹配非空当前 activeTurnId，旧消息轮次不能撤销新的执行。

## 顶部反馈与验证

复用 `CollectionReadFeedback` 的单行恢复入口。存在回退时显示「状态尚未同步，显示上次同步的列表状态」；没有确认缓存时只显示「状态尚未同步」。目录错误、运行缓存和重试不叠加多个提示；重试同时唤醒目录和状态读取。行内不增 stale 标签或假计时。

快速重试或 online/pageshow 恢复意图遇到进行中的旧状态读时，仍共享单一请求，但在旧读结束后合并一次立即后继读取。原先只给已 aborted 的请求排后继，成功或失败的旧读尚未结束时会吃掉新意图，再等待10秒；整包实际复现了这种竞态。本轮保留没有新意图时的10秒周期，以及离线/后台/停止取消和旧结果拒绝；重复意图不会平行请求，后继本身不会连续立即轮询。原浏览器等待和计数断言没有放宽。

本轮保留的边界：StopExecution 的 POST/GET 已明确返回 stopped/ended，但后续 history 与批量状态读取持续失败时，列表仍展示上次观测的活动，直到下一次合格 native GET 才撤销。未知 stop 回执不会推断结束；此次不改控制或停止 UI。StopReceipt 没有来源时间，批量运行也没有 turn ID，不能为列表制造时间水位或把旧轮停止套到新轮。用户实际反馈此路径，或获得可靠的同轮来源证明时，再专项接入终态回执。

验证入口：`tests/list-activity-cache.test.mjs`、`tests/collection-feedback.test.mjs`、`tests/browser/list-activity-cache.test.mjs`。私有证据留 `.local/qa/list-activity-cache-2026-11-10/`：baseline.json 在旧 bf10655 构建中，Chromium/WebKit 同样复现离线时 running 1→0、unread 0→1、运行计数1→—且无提示；当前浏览器覆盖短暂离线/503/重试/unknown、排序与计数/筛选一致、英文320宽度、scope变化与迟到响应、native 同轮终态和离线 dots。发布身份及最终同版验证由 CURRENT 记录，浏览器合成不代表实体 iPhone 切网效果。
