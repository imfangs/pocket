# Pocket 分层缓存：开源组件选择

核验日期：2026-10-28。任务是为本轮已授权的浏览器持久阅读缓存选择组件；比较期间未安装依赖、修改产品源码或部署。源码对照基线为 `2804dbd94b620eb521a2f83b7e0209f473b2a55e`；后续实现与发布状态回到 [CURRENT](../../CURRENT.md)，本页保存选型依据。

## 结论

采用 **`idb@8.0.4`**，只负责 IndexedDB 存取、索引与事务；继续让 Pocket 自己负责缓存投影、容量、失效与业务状态。测试可加入 **`fake-indexeddb@6.2.6`** 为开发依赖，以现有 Node 测试入口验证真实适配器的事务和多连接行为，另在 Chromium/WebKit 验证浏览器 IndexedDB。

本轮不引入 Dexie、TanStack Query 或 SWR。后两者擅长管理异步查询及内存缓存，但当前缺口是磁盘阅读快照和减少重复响应字节。它们不会自动提供正文版本协商，也不能替代 Pocket 已有的来源识别、发送回执或阅读状态规则。

这不是长期排除：当产品真正需要 IndexedDB 内复杂组合查询或多个视图订阅本地数据时再评估 Dexie；当出现一组尚无可靠管理层的新读接口时再评估查询库，不为这次缓存改造迁移整个会话控制层。

## 当前接口决定了选型

| 当前入口 | 已有能力 | 组件应放置的位置 |
| --- | --- | --- |
| [conversationFeed.ts](../../src/conversationFeed.ts) | 最近 10 个会话的 `HistoryCache`；正文、transcript、阅读位置和展开状态；单飞轮询、18 秒 deadline、前后台/网络恢复和错误退避 | 保留内存读取路径；在受限阅读投影后异步写 IndexedDB，恢复结果经过版本与代次校验再进入内存 |
| [catalogReader.ts](../../src/catalogReader.ts) | `generation` 使本地编辑、暂停和新请求淘汰旧回读；`sourceError` 的 HTTP 200 不算刷新成功 | 持久目录是首屏提示来源，不能绕过 generation，也不能让旧磁盘结果覆盖已到达的新目录 |
| [api.ts](../../src/api.ts)、[machineScope.ts](../../src/machineScope.ts) | 按机器路由、校验响应机器、401 失效、CSRF 刷新、私人请求 `no-store` | 存储层接收已经验证的来源；不接管登录、令牌、路由或自动重试写操作 |
| [queryTimeline.ts](../../src/queryTimeline.ts) | `requestId/clientMessageId` 决定稳定消息行；正文投影不能确认回执 | 缓存可保留消息身份用于展示；从缓存恢复不能调用 accepted 确认或操作队列 |
| [pocketReadState.ts](../../src/pocketReadState.ts) | 机器与 source scope 隔离；精确内容版本的已读水位与冲突检测 | 不与正文缓存合成一个可任意回退的整包；缓存命中、预取和恢复本身不产生阅读事实 |
| [AccessGate.tsx](../../src/AccessGate.tsx) | `authenticated` 后才挂载 App；登录/退出/失效使旧认证结果无效 | 保留门控；磁盘里有正文不等于当前拥有访问权限 |

`History` 当前同时包含 `canSend/canQueue/canStop`、`outbox`、`pendingRequests`、`connection`、`compactionRequest` 等操作信息。直接序列化并恢复完整对象，会把阅读缓存与执行事实重新绑在一起；不能把它当作一个通用 query value 无差别持久化。现有 [架构缓存节](../ARCHITECTURE.md#阅读缓存与传输) 对传输与服务端缓存的分层仍成立。

## 四个候选的真实增量与代价

| 候选 | 提供什么 | 对 Pocket 的增量 | 本轮迁移成本与取舍 |
| --- | --- | --- | --- |
| **idb** | Promise 化的 IndexedDB，保留事务、索引、版本升级；`blocked`、`blocking`、`terminated` 回调与 `tx.done` | 免去手写 IDBRequest 事件包装；可用事务同时检查失效代次、更新快照与容量元数据；不规定 React 状态模型 | 低。加一个独立存储适配器，原 feed 与控制器保持。缓存策略、projection、异常降级仍由项目实现 |
| **Dexie** | 更高层 schema/index/query API；`liveQuery` 根据写入自动更新订阅，React hook 在另一个包中 | 如果要在本地数据库内做组合筛选、范围查询、多视图响应式订阅，会明显减少代码 | 当前快照按 key 读取，LRU/容量只需少量索引；没有这些查询需求。引入较大的数据库抽象及其生命周期，暂缓 |
| **TanStack Query** | query key、请求共享、观察者、stale/refetch/gc、重试、失效；持久化另有 persister 包和 restore 协调 | 对全新 GET 数据面有价值；原有 `startFeed` 和 `catalogReader` 已覆盖大量相同职责 | 中高。要重新表达双正文来源、动态轮询、前后台、旧请求淘汰和本地修改优先；持久化还要另配过滤、代次、生命周期及容量。不能借默认 mutation 恢复处理 unknown 发送 |
| **SWR** | React key/fetcher 内存缓存、请求去重、焦点/网络重新验证、重试、自定义 cache provider | 新增简洁 GET hook 时容易用；现有读控制层收益有限 | 中。自定义 provider 接口以同步 Map 风格为核心，官方 localStorage 示例不是满足本项目异步 IndexedDB、分项容量和撤销要求的现成方案；仍须写内存桥与持久化管理 |

TanStack Query 官方默认把缓存标为 stale，非活动 query 默认 5 分钟回收，失败 query 默认重试 3 次；focus/reconnect/mount 可重新拉取。其 persistence 文档明确提示异步恢复与查询挂载存在竞争，提供 `PersistQueryClientProvider` 协调，还需配置 `gcTime/maxAge/buster`。这些是成熟能力，但新状态层仍须准确表达 Pocket 的业务边界。[Q1][Q2]

SWR 官方默认 `revalidateOnFocus=true`、`revalidateOnReconnect=true`、`shouldRetryOnError=true`、`dedupingInterval=2000`。这些选项和目前 Pocket 的可见性、单飞与重试规则重叠；直接叠加会有两套触发源，应迁移后只留一个负责者，不能同时启动两套轮询。[S1][S2]

## 版本、许可与体积证据

以下 latest、发布日期、直接依赖来自本次实时读取的 npm registry。发布日期按 UTC；许可又与这些精确版本的发布 tarball 中 LICENSE 核对。最近发布是维护活动的证据，不等同于维护者响应速度、安全审计或未来支持承诺。

| 包 | 本次 latest | 该版发布日期 | 许可 | 直接运行时依赖 | npm 解包体积 |
| --- | --- | --- | --- | --- | ---: |
| `idb` | `8.0.4` | 2026-10-06 | ISC | 无 | 82,588 B |
| `dexie` | `4.4.7` | 2026-10-19 | Apache-2.0 | 无 | 3,242,014 B |
| `@tanstack/react-query` | `5.105.0` | 2026-10-26 | MIT | `@tanstack/query-core@5.105.0` | 1,797,389 B，不含 query-core |
| `swr` | `2.5.1` | 2026-08-12 | MIT | `dequal ^2.0.3`、`use-sync-external-store ^1.6.0` | 320,306 B |
| `fake-indexeddb`，仅测试 | `6.2.6` | 2026-10-16 | Apache-2.0 | 无；Node >=18 | 490,834 B |

解包体积包含源码、类型、map 等，不能当作下载到手机的 JavaScript。为避免此误读，本次把精确发布 tarball 下载到独立临时目录，不运行安装脚本；以项目现有 esbuild `0.28.2` 对以下入口实际打包，随后清除全部临时文件。

共同条件：`--bundle --minify --platform=browser --format=esm --target=es2022`；React 与 React DOM external；gzip level 9。Query core 和 SWR 的两项依赖包含在对应结果里。React 19 满足两家当前 peer 声明。

| 测量入口 | 压缩后 JS | gzip |
| --- | ---: | ---: |
| `export { openDB, deleteDB } from 'idb'` | 3,458 B | **1,400 B** |
| `export { default } from 'dexie'` | 100,322 B | 32,750 B |
| `export { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'` | 33,031 B | 9,924 B |
| `export { default, SWRConfig, mutate } from 'swr'` | 13,981 B | 6,408 B |

这是指定入口的可复现构建比较，**不是 Pocket 集成后的最终包增量**，也不是速度基准。没有测 Dexie React hooks、TanStack persistence/devtools，也没有证明用户感知提速。idb 官方 README 的约 1.19 kB 指 Brotli，与此处 gzip 口径不同。[I1]

## 两条必须守住的边界

1. **持久化阅读事实，不持久化当前操作资格。** 使用白名单投影；按机器、来源 scope、thread ID 和缓存 schema 隔离，保留原消息身份与内容版本。`csrfToken`、发送/审批/停止回执、队列状态、连接权限、签名文件/附件能力 URL 不随阅读快照恢复。正文缓存不得触发 accepted、自动重发、连接或已读推进；只有实际可见阅读才按对应精确版本记录水位。恢复要经过当前认证门控，不能通过本地磁盘绕过登录或把另一来源的内容当成当前任务。
2. **撤销、过期与迟到结果有优先级。** logout、401、source scope 改变时，先使当前读取/写入代次失效并通知其它标签，再清除对应机器/来源的磁盘数据；事务提交前核对共享失效代次，阻止退出后旧请求重新落盘。异步 hydrate 永远不能覆盖更新的网络/本地事实。容量按条数和字节有界，长消息不按流式每字落盘；超额、存储被禁用、升级阻塞或异常关闭都回到内存/网络路径。缓存失效与发送结果未知是两件事，清缓存不改回执。

idb 不替我们实现上述策略。它还明确要求事务开始后不要 await 网络等非 IndexedDB 工作，否则事务可能在 await 期间自动关闭；合并写入和网络计算应在开事务前完成。以 `tx.done` 成功判断存储提交；旧连接在 `blocking` 中关闭，新开库被 `blocked` 卡住时不得阻塞首屏。[I1]

## 最小验证

用已有合成 fixture 验证一条长会话：登录后阅读并保存，刷新时先恢复同机器/同来源阅读内容，再收到新版本；记录从缓存可见到新数据可见的时间及传输字节。只有版本协议可直接证明减少重复正文传输，装入库本身不能证明。

围绕实际新边界补验证：网络先到而磁盘后到；旧会话/另一机器晚到；退出时正在 hydrate 或写入；第二标签持有旧连接并发生升级；401 后另一标签继续读写；满额/单条超额/禁用存储。确认新鲜操作资格、unknown 回执、消息行身份、草稿和已读水位保持。`fake-indexeddb` 可覆盖逻辑与事务，不能替代 iOS Safari 的 quota、后台清理和真实主屏幕 App 行为。

## 原始来源

- [I1] [idb 官方 README](https://github.com/jakearchibald/idb#readme)：Promise API、生命周期回调、事务生命周期、`tx.done`、体积口径；实际回读 [raw](https://raw.githubusercontent.com/jakearchibald/idb/main/README.md)。
- [D1] [Dexie 官方仓库](https://github.com/dexie/Dexie.js)、[schema/index](https://dexie.org/docs/Version/Version.stores())、[liveQuery](https://dexie.org/docs/liveQuery())：数据库抽象、schema、响应式查询和独立 React hooks。
- [Q1] [TanStack Query 默认行为](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)，官网本轮返回 HTTP 403，改为回读同一官方仓库的 [文档源码](https://github.com/TanStack/query/blob/main/docs/framework/react/guides/important-defaults.md)。
- [Q2] [TanStack Query persistence](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient)，同样回读 [官方文档源码](https://github.com/TanStack/query/blob/main/docs/framework/react/plugins/persistQueryClient.md)：persister、restore 竞争、`gcTime/maxAge/buster` 与 provider。
- [S1] [SWR API](https://swr.vercel.app/docs/api)：默认去重、恢复与重试选项。
- [S2] [SWR cache provider](https://swr.vercel.app/docs/advanced/cache)：Map 风格 provider、localStorage persistence 示例和清理语义。
- [N1] npm registry 精确版本：[idb 8.0.4](https://registry.npmjs.org/idb/8.0.4)、[Dexie 4.4.7](https://registry.npmjs.org/dexie/4.4.7)、[React Query 5.105.0](https://registry.npmjs.org/@tanstack%2Freact-query/5.105.0)、[SWR 2.5.1](https://registry.npmjs.org/swr/2.5.1)、[fake-indexeddb 6.2.6](https://registry.npmjs.org/fake-indexeddb/6.2.6)。`latest` 与发布时点由对应无版本 registry 文档的 `dist-tags`、`time` 字段核验。
- [N2] 用于体积复验的传递依赖：[query-core 5.105.0](https://registry.npmjs.org/@tanstack%2Fquery-core/5.105.0)、[dequal 2.0.3](https://registry.npmjs.org/dequal/2.0.3)、[use-sync-external-store 1.6.0](https://registry.npmjs.org/use-sync-external-store/1.6.0)。

后续升级以锁文件中的实际版本重验。若新需求涉及数据同步、离线写入或数据库成为事实源，应重开选型；本结论仅针对可丢弃、可回源的阅读缓存。
