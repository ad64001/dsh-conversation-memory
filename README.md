# DSH Conversation Memory

> cachefix.5 已完成新的三次 Go 原生压缩实测，见 [KV 与维护结果](docs/GO_PRESSURE_CACHEFIX5.md)。

> 当前源码为 **0.4.2-cachefix.5**：统一完整证据包预算，在压缩后的单次调用内完成有界检索，移除每次空归档的重复全库扫描。见 [维护修复与验证](docs/CACHEFIX5_MAINTENANCE.md)。

[English](#english) · [安装步骤](docs/INSTALL.zh-CN.md) · [测试与已知边界](docs/VALIDATION.md)

给 **DeepSeek Harness（DSH）** 使用的实验性对话记忆插件。用当前对话正在运行的模型判断工具结果该保留哪些原文，以及旧记忆是否重复；把原始证据保存在本对话的库里，用 `[1]`、`[2]` 引用按需回读。

**当前源码试用版 0.4.2-cachefix.5，基于 0.4.2。自动安装器仅支持 Windows + DSH 0.2.1-rc.2；其他 DSH 版本会拒绝安装。** 真正长程测试使用 OpenCode 的 `opencode-go/deepseek-v4.1-flash`。同模型表示复用当前 provider/model 路由，会产生额外辅助请求、费用和等待时间。未对所有模型做兼容保证。

## 做了什么

- 代替固定的“保留开头 + 结尾”：模型选择原文片段，程序校验出处和长度。
- 跨段传递上一段原文背景；关键失败、否定、纠正和控制参数缺失时拒绝语义裁剪，原文交给原生后续流程。
- 用户纠正原文优先，保留引用及角色，不用助手转述替代。
- 每个会话一个 SQLite 库，全文索引按需调用，完整索引不常驻上下文。
- 旧记忆快照由同一路由模型判断重复、失效和保留顺序。程序做精确原文校验、关键证据验收、预算准入和提交。
- 提供 `memory_search`、`memory_read`、`memory_index`、`memory_status`。

工具结果触发阈值仍为 **8192 Unicode 码点**，最终选择预算仍为 **5159 码点**，记忆 provider 包上限 **6000 码点**。原生 Basic 摘要、阈值参数、尾部保留、重试和溢出恢复继续使用 DSH 自带实现。去重辅助调用单次最多 **3 分钟**，整个整理计划最多 **5 分钟**。

## 快速安装

1. 从 [main 源码 ZIP](https://github.com/ad64001/dsh-conversation-memory/archive/refs/heads/main.zip) 下载并解压，或克隆本仓库。旧 Releases 中的 0.4.2 安装包不包含本次缓存修复。
2. 安装 Node.js **22.13+**（推荐 24），完整启动过一次 DSH 后退出 DSH，包括托盘进程。
3. 在解压目录运行 PowerShell：

```powershell
node scripts/verify.cjs
node scripts/install.cjs --check
node scripts/install.cjs
```

若找不到安装位置，在后两条命令后加 `--dsh-dir "D:\Apps\DeepSeek Harness"`。**安装器不会下载模型，也不需要填写新 API Key**；先在 DSH 中配置并选中自己的模型。安装不需要 `npm install`，也不需要管理员权限。

4. 重启 DSH，在 Standard / PTC / Cordis 预设中新建会话。先让模型调用 `memory_status({})`，再进行一个短任务；详细验证、回读和卸载见 [完整步骤](docs/INSTALL.zh-CN.md)。

安装器先备份 profile，再复制两个插件并生成本机 runtime 绑定；已有自定义参数会保留。旧截断器禁用。无法证明配置兼容、遇到第三方 compaction backend 或未受管理的同名插件目录时会停止。默认不改变 Minimal 或其他自定义预设。

## 验证情况

新增cachefix.4真实Go测量完成3/3次压缩；六个正常续轮加权KV命中98.95%，全部请求66.49%。维护恢复、预算拒绝和严格答案检查单独报告，见 [三周期实测](docs/GO_PRESSURE_CACHEFIX4.md)。

cachefix.4 的变更、离线归档回放与真实API边界见 [复查验收](docs/CACHEFIX4_RECHECK.md)。cachefix.3 的历史审查修复、回归结果与测速见 [验收记录](docs/CACHEFIX3_REVIEW.md)。cachefix.2 的 325/325 回归与旧测速保留在 [历史结果](docs/RETRIEVAL_BENCHMARK.md)。当前不部署 ES。新增cachefix.3真实Go压力长测完成10/10次原生压缩，正常续轮加权命中98.78%，全部请求71.97%；[完整口径、失败请求与自动召回限制](docs/GO_PRESSURE_CACHEFIX3.md)。

上一版 cachefix.1 本地回归 **313/313**。新增原生压力长测计划 10 次，实际完成 **6/10**，第 7 周期被服务端 `content_filter` 终止。六次压缩后的首个主请求加权命中率 **1.03%**，检索完成后的正常续轮为 **98.88%**；主请求整体 **84.15%**，包含辅助请求的整体 **77.36%**。压缩会改变前缀，不能把续轮命中率当成首请求或所有任务的保证。六轮回忆和原文回读均正确，但摘要也保留关键事实，不能证明答案只来自归档检索。见 [本次完整边界](docs/CACHE_FIX_VALIDATION.md)。

以下为 0.4.2 的历史验证：

冻结 0.4.2 从空会话跑完 **16 轮**真实 DSH 长程任务：中途纠正、跨段依赖、条件未变不重试、条件改变后合法重试、自动压力摘要、压缩后回读原文；46 次去重辅助调用没有超时。原开发回归 **292/292**，包括一个 DSH 原生 Session 集成检查。

**原始“所有辅助调用均成功”判定仍是 false**：原有语义筛选发生一次 180 秒整轮预算取消。已独立验证未完成候选原文完整保留并进入原生摘要；这次取消不计作模型成功。公开安装器另有隔离安装/回滚测试。详见 [测试记录](docs/VALIDATION.md)。

模型仍可能漏选、误判或超时；插件不保证任意长程任务零遗忘。默认 DSH spill 可能在插件归档前把巨大结果变成预览和临时文件指针，因此不保证所有超大工具原文永久保存。注意力问题没有被彻底消除：控制常驻包大小、按需回读和保留失败证据，是这里采取的措施。

## 源码与开发

```powershell
npm test
```

- `plugin/`：DSH bridge、模型去重与自动召回。
- `semantic-pruner/`：模型选择工具原文，继承桌面端自带 BasicCompactionEngine。
- `library/`：可单独使用的会话引用库，没有 npm 依赖；见 [库 API](library/README.md)。
- `scripts/`：安装、检查、回滚和测试工具。
- `validation/`：可公开的结果概要与运行源码哈希，不包含原始会话或本机路径。

问题反馈请附 DSH 版本、OS、插件版本、模型路由、复现步骤和脱敏后的 `memory_status`；不要提交 API Key、会话数据库或完整私密日志。

MIT。预设声明来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，其许可证保留在 [THIRD_PARTY_NOTICES](semantic-pruner/THIRD_PARTY_NOTICES.txt)。本项目是社区试用插件，与 DeepSeek 官方无隶属关系。

## English

The current source is **0.4.2-cachefix.5**, based on 0.4.2. Download the main source ZIP for this fix; the older 0.4.2 release archive does not contain it. See [maintenance repair and validation](docs/CACHEFIX5_MAINTENANCE.md). The fix preserves ordinary request prefixes and supplies conversation-specific OpenCode Go headers. The cachefix.1 native pressure run completed **6 of 10** planned compactions before a provider `content_filter` termination. Weighted cache hit rates were **1.03%** on the first main request after compaction and **98.88%** on normal continuations after retrieval. See [cache validation and limitations](docs/CACHE_FIX_VALIDATION.md).

Experimental, conversation-scoped evidence memory for DeepSeek Harness. The active conversation's own model selects exact tool-result excerpts and consolidates old snapshots. Raw user corrections take priority; `[n]` citations support on-demand original read-back. The complete index stays in the per-conversation SQLite library.

The installer supports **Windows DSH 0.2.1-rc.2 only**. Download the Windows ZIP from Releases, extract it, install Node.js 22.13+ (24 recommended), quit DSH, then run `node scripts/verify.cjs`, `node scripts/install.cjs --check`, and `node scripts/install.cjs`. Add `--dsh-dir "D:\Apps\DeepSeek Harness"` if detection fails. Restart DSH and start a new Standard/PTC/Cordis conversation. No npm dependencies, new API key, native ASAR modification, or admin rights are required.

Tested with `opencode-go/deepseek-v4.1-flash` in a fresh 16-turn native conversation. The original all-auxiliary-stream-success gate remains **false** because one existing semantic-pass deadline cancelled; exact original preservation and normal native continuation were independently verified. No dedup helper timeout occurred. This trial does not promise perfect recall or universal model compatibility. See the [installation guide](docs/INSTALL.zh-CN.md) and [validation boundaries](docs/VALIDATION.md).
