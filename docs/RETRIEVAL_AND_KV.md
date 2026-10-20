# 多路检索、耗时评估与 KV 缓存

版本 0.4.2-cachefix.2。原文仍按会话保存在本地 SQLite；原始引用、角色、范围、失效关系与哈希仍由现有库校验。搜索不启动子 Agent，也不调用生成模型。

## 检索行为

`memory_search` 使用现有的完整查询、具体标识符、路径、错误及中文关键词生成最多九条去重查询。即使第一条结果已达到数量上限，也继续执行预算内的其他查询，合并命中；同一条查询中的重复引用不增加排名。原有用户原文优先、纠正、衔接与背景整组打包规则继续使用。查询之间让出 worker 调度，并在打包前再次核对原文有效性。

新增配置 `searchTimeoutMs`，默认 **500 ms**，可设 1..10000 ms。预算覆盖 worker 准备、归档同步、队列等待、检索和返回证据的等待。到期时返回 `searchIncomplete:true` 和明确的“检索未完成”提示；不能将超时当作无记忆、无约束或全库查全。调用方取消仍向上传播，磁盘/worker 等错误不伪装成成功检索。

这是客户端等待预算，**不是严格实时保证，也不能中断正在同步执行的 SQLite SQL**。worker 会在查询间检查截止时间；主线程的取消计时器负责停止等待。线程拥塞、归档与单条 SQL 仍须通过实际负载评估。后台归档继续以幂等游标修复，不丢弃已经提交的原文。必要时缩小关键词或适当提高预算后重试。

`memory_status.retrieval` 给出 backend、预算与最近 256 次搜索的 P50/P95/P99、最大值和最近分阶段耗时；calls/incomplete/errors 是当前 worker 生命周期累计计数。worker 重开后该诊断窗口重置，不伪装成持久历史。诊断没有请求正文，**耗时、计数和时间戳不进入常驻证据包**。首次 worker/大批归档可能超时，最近的用户输入仍保留在原生会话中；需要历史约束时应实际回读，不能仅凭超时提示决策。

Windows 大批归档曾在旧版与开发版复跑中触发状态游标替换的 `EPERM`。本版使用唯一临时文件，并仅对 `EPERM/EACCES/EBUSY` 做最多四次、合计 200 ms 的 worker 内等待重试；不删除旧的已提交游标，持续失败仍上报错误。`memory_status.stateReplacementRetries` 记录当前 worker 成功替换前实际执行的重试数。归档原文幂等保存与游标恢复逻辑保留。功能性原文测试使用较宽预算验证完整性；较短预算的取消和不完整提示另有专项检查。

## 运行测速

```powershell
node scripts/benchmark-retrieval.mjs --sizes 1000,10000 --queries 60 --out retrieval-results.json
```

若需同机旧版对照，可加 `--baseline-root` 指向未改动的旧版解压目录。夹具是固定生成的用户/工具文本；不读取真实会话、不发模型请求。分别测首次新库搜索、完成剩余归档后的连续查询、四路并发查询和重开 worker。每次查询检查目标原文是否返回，并单列未完成结果。重开 worker 不代表操作系统冷缓存，不给未经实测的 ES 延迟数字。

## ES 的预留位置

`plugin/lib/retrieval.mjs` 的 `collectQueries` 接受 `lookup(query,{signal})` 后端函数。当前只连接 SQLite 的 `memory.recall({useModel:false})`，**未安装 ES、未发送会话内容到外部服务，也没有可直接启用的 ES 配置开关**。

后续 ES 实现可接入该函数，但必须先将候选映射回同一 SQLite 会话，验证稳定引用、原文范围/哈希和当前失效状态；ES `_score`、highlight 和旧索引不能成为新的原文或授权。需另行实现索引同步、重建、截止时间、不可用回退及最近纠正的本地补入，再以同一夹具评估。预留函数不是已完成的 ES 驱动。

## KV 缓存能控制什么

目前使用的是 OpenCode Go 托管的 `deepseek-v4.1-flash` API。可由客户端实施的操作：

- 为同一会话主/辅助请求发送稳定的实际 `x-opencode-session`，避免并发会话互相覆盖；cachefix.1 已实现。
- 保持已发送消息前缀稳定，同一轮普通工具步骤复用记忆包；检索诊断留在状态中，不制造每步变化的运行时快照。
- 通过真实 API usage 统计 cache-read token，分开计算主请求、压缩、索引及去重；本地检索缓存和 `cacheChars` 不能代替 API KV 命中率。

截至本次核对，Go 公开接口没有提供可供插件调用的 KV 张量读写/导出、锁定缓存驻留、设置任意 TTL 或把压缩前后 KV 拼接的管理端点。没有加入未经文档支持的请求参数，也没有发送额外保活请求。稳定会话头帮助路由与提示缓存，不能保证网关始终保留副本。

原生压缩改写前缀后，旧 KV 不能任意套到新摘要上。cachefix.1 的六次实际压缩中，压缩后首个主请求加权命中 **1.03%**，检索后的正常续轮 **98.88%**；这说明续轮可复用，但不是消除压缩后的冷缓存。此数据属于 cachefix.1 的已完成 6/10 长测，不是 cachefix.2 的新 Go 压力测试。

DeepSeek 直连文档说明上下文缓存自动管理、尽力而为；其 Responses 文档明确不支持 `prompt_cache_key` / `prompt_cache_retention`。这些直连说明不能作为 Go 网关的 TTL 或命中承诺。直接控制推理 KV 通常需要管理推理服务，本次没有引入自托管模型。

资料核对日期：2026-10-20。

- [OpenCode Go：稳定会话头](https://opencode.ai/v2/docs/console/go/#where-can-i-use-it)
- [DeepSeek：上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)
- [DeepSeek：Responses 参数支持](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
