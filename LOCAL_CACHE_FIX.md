# 本地缓存修复版 0.4.2-cachefix.1

这是基于 0.4.2 的缓存修复试用版。新增原生压力长测完成 6/10 次，统计和限制见 [缓存验证记录](docs/CACHE_FIX_VALIDATION.md)；旧 0.4.2 Releases 安装包不含此修复。
仍只支持 Windows DSH 0.2.1-rc.2。

默认 `cachePolicy: stable-prefix`：自动召回在新用户输入、模型路由变化或原生上下文替换时更新；同一轮普通工具步骤复用同一个记忆包，不搬移或改写历史快照。模型去重及历史快照整理延后到 DSH 原生压缩/替换边界。原生摘要、阈值及语义筛选预算不变。`memory_search`、`memory_read`、`memory_index`、`memory_status` 仍可使用。

自动召回还会核对源事件序号、Unicode 码点范围及 SHA-256：召回的全部证据如果已经原样存在于活动对话中，就不再追加副本。发生压缩、原文不再可见或来源无法证明时，仍保留召回正文和缺失提示。显式 memory_search 的结果不受此项去重影响。

这一策略会保留压缩前已发送的历史记忆快照，避免破坏缓存前缀；它们随 DSH 原生历史压缩处理。每个新记忆包仍受 6000 码点预算约束，这不是所有历史快照之和的上限。当前运行中途的新用户纠正会触发更新，普通工具结果直接留在当前对话，并在后台归档。

OpenCode Go：修复 DSH pi-ai Chat Completions 路径的会话头缺失。在每次调用的独立 provider snapshot 上添加实际对话 ID 的 `x-opencode-session`，覆盖过时的静态同名值；主请求及辅助请求一致，同一 provider 的并发会话各自隔离。只匹配官方 `https://opencode.ai/zen/go/v1` 与 `https://opencode.ai/inference/go/openai/v1`。不改全局 fetch、不修改 ASAR，不持久化凭据或变更模型设置。插件停止时恢复原适配器方法。

安装与回滚仍使用 scripts/install.cjs。安装器为记忆插件额外生成绑定本机 pi-ai 适配器的 runtime-binding.mjs。校验清单按本地修复版重新生成。

`cachePolicy: legacy` 仅用于保留旧行为的回归和对照，不建议常规使用。上游 README 中有关每步快照整理的描述在默认修复模式下已变更；阅读本文件优先。

缓存命中由服务端决定。客户端前缀稳定和正确会话头不能保证网关副本始终保有缓存，也不能把新加入的源代码 token 计成缓存命中。实测应区分冷启动、合法新增内容、主请求及辅助请求；不得把重复请求的高命中率当成所有真实任务的保证。
