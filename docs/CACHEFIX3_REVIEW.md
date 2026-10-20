# cachefix.3 审查修复与验收

2026-10-20，基于 cachefix.2 的 `9c8367a`。本轮处理该版本审查中的 F01–F09。保留按会话保存原始来源、稳定引用与按需检索的设计；搜索无需子 Agent。ES 仍是可选后端接缝，没有加入 ES 驱动或服务。本页的离线审查验证阶段没有发送Go请求；后续新增真实Go压力长测见 [独立报告](GO_PRESSURE_CACHEFIX3.md)。

## 修复对应关系

| 编号 | 实现与验收 | 范围和边界 |
| --- | --- | --- |
| F01 | 分离轮次标记与 pending/complete/incomplete/failed/cancelled 状态；默认同一轮次/版本最多三次尝试、至少间隔250 ms。压缩维护失败保留 pending；成功后普通步骤冻结同一证据包。真实 preStep→refresh→search 测试先超时再恢复，另测退避、上限、整理失败、取消、会话切换与关闭。 | 只有后续已获准的步骤触发重试；达到上限需要显式检索或新的轮次/版本。不会自行新增主模型步骤。 |
| F02 | worker 每条已完成查询可返回精确来源验证后的部分包；worker 截止时间略早于父侧。父侧超时时使用同请求、同会话、同 surface、同来源修订的包；过期、取消或已关闭请求不收旧结果。真实 bridge/worker、实际父侧计时器及受控慢查询集成测试覆盖交付、取消、修订失效和迟到结果。 | 尚无已交付包时仍可能只有未完成提示；同步 SQLite SQL 无法由该等待预算强制中断，不保证每次超时都有引用。 |
| F03 | 检测到的错误/失败、否定/停止/纠正和控制参数整行，以及模型 priority=5 的完整范围成为提交验收条件。预算缺少关键组或检测溢出时整条不替换；原生提交前再次检查关键原句。测试动作与失败尾句、未迁移、KeyError、参数、旧/新值、停止边界、组超预算及注入 selector 绕过。 | 这是保守的已识别证据保护，不是对任意自然语言的完备证明。退回完整工具原文后，原生 Basic 仍可执行自己的摘要。 |
| F04 | 核对 DSH 原生字段 `tool/call.data.arguments` 字符串，原样封装为 assistant 发起的动作来源；结果保留 tool 角色与原文字节。新增 append-only 工具来源关联表，以 callEventSeq 和 callId 配对，避免重复 callId 串线。旧归档游标首次幂等补录，最终提交 projectionVersion=2；崩溃/取消可续做。`memory_read` 提供角色、事件位置与关联定位引用。 | 旧结果 metadata、文本和 `[n]` 引用不改写；后补记录的 SQLite 插入序号不代表原生事件顺序，使用 eventSeq。未开始或找不到对应调用的结果不臆造配对。已 spill 的结果仍受宿主原有保留边界影响。 |
| F05 | 单纯“继续”时，从最多4096条原始事件中查最近四条用户原文，取当前输入及最多两条有意义背景；带 eventSeq，总预算2000码点。新实质目标只用本轮，停止边界阻止继续追溯更早目标；长文本明确标节选。 | 有界相关性提示，不能保证所有早期约束均在提示内；历史不构成授权。助手和运行时文本不提升为用户原文。 |
| F06 | bridge、工具 schema、worker 的 search/index 统一1..1000 Unicode码点，明确 `INVALID_QUERY`。测试1000/1001个非BMP字符、2000 ASCII、空值和直接worker入口。 | 查询长度按码点；不是UTF-16长度。 |
| F07 | `autoRecall.metrics` 记录从原生入口开始的完整耗时，分 nativePreStep/workerPreparation/snapshot/refresh/consolidation；复用/退避边界也记录 attempted=false。慢阶段与错误仍记已消耗时间。 | 与 `retrieval.metrics` 的搜索等待是不同口径。没有把500 ms改成整个原生preStep或模型整理的硬上限；指标不进常驻证据正文。 |
| F08 | 未完成提示仅确认原始会话仍在；progress 给出 queryStarted、archivedThroughSeq 和 targetSeq。真实worker归档被阻塞时，测试返回旧提交游标与更大目标，随后重试找到原文。 | 原始会话日志、SQLite归档与当前交付包是不同层次。 |
| F09 | 独占创建临时文件后才登记所有权，写入/关闭/替换均在清理保护范围；部分写入失败也清理，清理异常附为 cleanupError，保留首个错误。 | 保留Windows瞬时锁有界重试与旧提交游标；不能删除没有成功创建的临时文件。故障注入覆盖ENOSPC、EXDEV+EACCES、EEXIST。 |

## 验证

本机完整回归 **351/351**，DSH原生检查启用，零跳过。原生测试为隔离的真实Session、Basic继承及安装/回滚，不是桌面端真实长任务或Go模型质量评测。可复跑：

```powershell
node scripts/verify.cjs
$env:DSH_EXE='安装目录\DeepSeek Harness.exe'
$env:DSH_RUNTIME_NATIVE_TEST='1'
node scripts/test.cjs
```

关键测试见 [恢复/部分交付](../plugin/tests/review-recovery.test.mjs)、[工具来源与旧库](../plugin/tests/tool-provenance.test.mjs)、[关键证据与任务背景](../semantic-pruner/tests/review-fidelity.test.mjs)、[原生提交保护](../semantic-pruner/tests/adapter.test.mjs)、[状态写入故障](../plugin/tests/atomic-state.test.mjs)。旧325项的有效断言保留；原先允许关键遗漏的诊断测试改为要求拒绝替换。新增26项。

## 本轮独立检索测速

完整结果及源码哈希见 [review-cachefix3-summary.json](../validation/review-cachefix3-summary.json)。固定合成材料，每规模20次连续查询、20次四路并发、10次重开后的查询；与测试串行执行，不清除OS缓存。

| 消息数 | 首次搜索ms | 连续P95/P99 ms | 四路并发P95/P99 ms | 目标原文返回：连续/并发/重开 | 未完成：连续/并发/重开 |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 513.96（未完成） | 20.78 / 21.95 | 75.93 / 79.12 | 20/20；20/20；10/10 | 0/0/0 |
| 10,000 | 504.80（未完成） | 107.82 / 116.74 | 408.26 / 459.53 | 20/20；20/20；10/10 | 0/1/0 |

1,000条：剩余归档1739.12 ms，最终归档1000条；模型调用0次，状态替换成功前重试0次。
10,000条：剩余归档21089.11 ms，最终归档10000条；模型调用0次，状态替换成功前重试1次。

部分交付增加装包与校验开销。请求内只在来源修订未变时复用用户来源扫描，避免每条查询重复扫描整个用户历史；最终候选仍核对当前来源。旧cachefix.2测速为另一轮60次连续样本，不能把两轮数字当作严格A/B或承诺提速。P99在小样本中接近最大值，没有服务等级保证。

首次大批归档仍可能达到500 ms等待预算，返回未完成；等待返回不等于查询完成。本表仅为本地检索测速；新增Go压力长测另见 [独立报告](GO_PRESSURE_CACHEFIX3.md)，cachefix.1的6/10数据仍为历史记录。
