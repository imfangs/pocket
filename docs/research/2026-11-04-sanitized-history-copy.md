# Pocket 脱敏历史副本：本地制作与验收

日期：2026-11-04。用户要求先制作一份可回退的本地脱敏历史，评估保留情况再决定是否公开；并行增加远端运行中的三点反馈。本记录属于私有维护资料，不进入公开源码白名单。线上功能发布与源码/历史公开是两个独立动作。

## 固定原始基线

初始原仓库 `92fa63c8d0538f9bb8243dd518f0d2e30ce49b6c`，365 个 main 提交、无 merge；全部 reachable 历史均在 main，额外只有一条 origin 跟踪 ref。原始完整历史继续保留。本轮未改写原仓库的任何已有 Git 对象或身份配置；并行 UI 与本任务文档可产生正常新提交，不把这种追加称为历史改写。

保护快照与精确私人规则位于 `.local/qa/history-copy-2026-11-04/`，规则及原始摘要为0600。公共副本不附原路径、旧SHA对应表或替换值列表。

## 制作方法

1. `git clone --mirror --no-hardlinks` 到本任务私有隔离目录，确认不与原对象库共享 alternates/hardlinks。
2. 仅在该副本删除 main 之外 refs，再进行完整 `git-filter-repo`。不使用会隐式进入 partial 的 `--refs`，不对原仓库执行 force、gc、reflog清理或push。
3. 保留稳定源码前缀与必要公开文件，覆盖曾改名/删除的历史源码，而非仅采用最新文件清单。排除私人配置、运维/设计回执和工作数据；历史README保留经处理的原内容，私人AGENTS排除。已知私人域名、实际家目录、基础设施值和内部registry替换为示例值，遥测配置关闭；合成fixture路径/临时域名保留，第三方许可身份不作全局短名称替换。
4. 所有提交身份改为通用贡献者，作者/提交时间、父链、经脱敏的提交意图保留。`--prune-empty=never` 保留私人资料删除后形成的空提交。
5. 历史结束后通过明确的新提交将当前树对齐经验证的自部署导出，补通用配置、bundled bridge、中英文入口和公共历史说明。历史版本只展示演进，不宣称均可首装或接受了新版配置。
6. 仅对副本 expire reflog/gc，独立核对全部Git对象与当前源码；交付净clone/Git bundle，不把带私有filter日志/map的原副本`.git`直接打包。

## 第一轮观察与独立验收

- 原盘点365提交、3,124个blob，最大811,193字节，无大小跳过；除了既有私有标记，还识别内部registry与私人遥测project key。临时域名候选均源于明确测试fixture，没有误当真实部署删掉。
- 第一轮保留365→365一一映射、日期与parent顺序；SHA全部变化。178个提交成为公共树不变的空提交，保留的是私有文档/运维迭代事件，不能说365个不同公开代码版本。
- 副本3,215个对象（365 commit、2,164 blob、686 tree），全部可达；只main，无remote、reflog、alternates或dangling原对象，strict fsck通过。
- 独立检查已知私人值及常见编码变体、强凭据模式、树路径/mode、身份/签名/header均零finding。保留归档的592成员和图片元数据已检查；公开第三方版权原文保持。
- 不声称任意个人事实/未知密钥或所有历史版本行为均已认证。公开前仍沿既有Alpha的新Mac/实体手机、完整许可、远程入口与正式仓库/支持流程门槛。

第一轮证据：`inventory-*.json`、`filter-receipt.json`、`filter-stats.json`、`independent-history-audit.json`、`independent-context-resolution.json`。加入最新UI/维护提交与当前源码基线后，最终副本须再次核对；最终身份及路径以同目录的最终回执和CURRENT为准。
