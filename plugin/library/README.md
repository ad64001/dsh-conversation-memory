# conversation-reference-memory

每个对话一个独立 SQLite 库。v0.2.0 在稳定的 `[1]` 引用、精确摘录、检索和有预算的工作上下文上，加入分段边界原文背景、关键实体漏选检查及按需背景回读。索引保存在库内，不整体常驻。独立库导入时不会注册宿主钩子；配套 DSH bridge 位于发行包的 `plugin/`，负责 worker 归档、记忆工具和有界召回，安装状态以发行包的部署记录为准。

## 运行

需要支持 `node:sqlite` 和 FTS5 的 Node.js 22.13+。已验证系统 Node 22.20.0 和本机 DSH 内嵌 Node 24.21.0；Node 22 会显示 SQLite 实验性功能提示。没有 npm 依赖。

```powershell
node --test tests/*.test.mjs
```

```javascript
import { ConversationMemory, WORKING_MEMORY_PROMPT } from './lib/index.mjs';

const memory = new ConversationMemory({
  rootDir: 'F:/conversation-memory',
  conversationId: 'an-explicit-conversation-id',
});
const message = memory.append({
  sourceKey: 'user-message-001', role: 'user',
  text: '生产工单 rollback_ticket=RT-551；先只读核对，未批准执行恢复。',
});
const citation = memory.cite({ messageId: message.id,
  start: 0, end: Array.from(message.text).length });
// 这是可信应用明确登记的用户约束。模型整理接口不能设置 pinned。
memory.remember({ ref: citation.ref, kind: 'constraint', origin: 'user', pinned: true });

const working = await memory.buildContext({
  query: 'rollback_ticket', currentTask: '核对工单；保持只读', maxChars: 2000, useModel: false,
  // 可选：调用方明确要求本步必留的已确认引用。默认只按查询取相关 pin。
  pinRefs: [citation.ref],
});
console.log(working.text);
// 宿主把 WORKING_MEMORY_PROMPT 加到自己的工作规则中，将 working.text
// 作为带来源的证据提供给主模型；不要覆盖宿主原有 system prompt。
console.log(memory.read(citation.ref));
console.log(memory.readSource(citation.ref, { maxChars: 4000 }));
memory.close();
```

`[n]` 在同一对话内永久对应同一条消息的同一个 Unicode 码点区间，不随摘要重新编号。编号可以不连续；两个对话中的 `[1]` 各自独立。路径按 conversationId 的 SHA-256 隔离，库内还检查身份；此隔离不是加密或操作系统权限边界。

## 模型和提示词

普通调用方可注入 `model({purpose,messages,maxTokens,signal}) -> {text,finish:'stop',usage?}`。`purpose` 为 `memory-index` 或 `memory-rerank`；messages 使用标准 role/content 字符串。超时、取消和模型路由管理由调用方负责，DSH adapter 已实现这些边界。

在 DSH 宿主中调用：

```javascript
import { createDshModel, ingestDshSession } from './lib/dsh-adapter.mjs';
const model = createDshModel({
  llm: ctx.get('llm'), getAgent: () => currentAgent,
  timeoutMs: 60000, maxTokens: 8192,
});
const memory = new ConversationMemory({ rootDir, conversationId: currentAgent.session.id, model });
await ingestDshSession(memory, currentAgent.session);
const messages = memory.store.listMessages({ afterSeq: 0, limit: 20 });
const indexResult = await memory.indexMessages({ messageIds: messages.map(m => m.id), maxCalls: 4 });
// 检查 indexResult.rejected 和 pending。分块/调用上限未处理的内容不能称为已索引。
// backgrounds 是实际传入的前段原文引用；coverage 是程序匹配实体的逐段覆盖情况。
const working = await memory.buildContext({ query: 'rollback_ticket', currentTask: '核对生产工单' });
```

适配器每次读取会话最新已使用的 requestHeader provider/model，完整缺失时才取 agent.options 中完整的一对。它调用同一路由的额外请求，不读取进行中的推理或复用模型内部状态。UI 刚切换、尚未发出请求的新模型可能还不在 durable header 中。适配器使用真实 sessionId、禁用工具、限制输出和超时，将库操作映射至 DSH 支持的 `purpose:'compaction'`，不进入 agent loop。

三个严谨提示词集中在 [prompts.mjs](lib/prompts.mjs)：

- `WORKING_MEMORY_PROMPT`：主模型核对来源、引用原文、检查矛盾和失败条件，保留当前目标、预算和停止条件。
- `MEMORY_INDEX_PROMPT`：整理模型仅提出当前正文中连续、唯一的原文摘录。前段原文只读背景不得冒充当前正文引用；参数、路径、错误及失败条件不得模糊化。程序检查整个模型响应后才写入提出的记录；不接受臆造原文、编号、额外权限或状态字段。独立的确定性实体兜底不依赖模型输出是否合法。
- `MEMORY_RERANK_PROMPT`：只在本轮候选中筛选排序，允许无相关结果；程序验证编号子集，错误结果退回本地排序。

分类不是真实性认证。`sourceRole` 是原文角色；`origin=model` 只表示模型建立了索引。引用正文和正文中自称的 `[999]` 都不会获得新权限。调用方必须实际向主模型提供检索/读取接口，编号本身不会自动触发读取。

## 状态、预算和失败

- `append` 按 sourceKey 幂等，相同 key 不同正文报错。原文、引用和关系采用 append-only 表及哈希校验；失败索引不删除原文。
- `indexMessages` 默认每次最多 4 个 4000 字符块，可显式设置 `maxCalls` 1..32、`maxChunkChars` 256..8192；只接受唯一精确 quote，模型记录不能 pinned、supersede、resolve。记录保留原文，未改写成二次摘要。`pending` 是未成功处理的区间，调用方应保留它；可用 messageIds、startOffsets、maxCalls 分批调度。配套 bridge 对单次工具调用设置了更小的调用上限。
- 每次整理带 `previousBackground:{readOnly:true,sources:[...]}`：同一消息后续块携带该块之前的原文尾部，首块携带前面最多两条非空消息的原文尾部；总量默认 1024 个码点，`maxBackgroundChars` 可设 0..2048。它们包含各自稳定 ref、角色、顺序和原文位置；不递传模型生成的摘要。只能输出当前 `sources` 的 ref，背景 ref 不能冒充当前来源。模型提出的记录由宿主附加 `scope.indexingBackgroundRefs`，不推断因果。
- `detectEntities` 按原文位置保守识别路径、函数/变量标识符、错误码/异常名、参数阈值及明确失败措辞。整条原消息扫描能保留跨硬分段的实体全名。`entityManifest` 提供本段匹配项；发送给模型的清单另设 8192 码点预算，未发送的匹配项仍接受程序漏选检查。模型摘录未覆盖的精确片段保存为 `kind:'entity',origin:'model',pinned:false`，标记 `evidenceOnly:true`；不是事实认证、根因判断或永久禁止操作。
- `indexResult.coverage` 每段含 `detectedCount`、`modelSelectedCount`、`fallbackCount` 和逐项原文引用/位置。`fallbackCount` 是未被有效模型摘录覆盖的匹配数，逐项 `status` 区分新兜底、既有证据及失效历史，不等于新增记录数。模型输出失败时原文、确定性兜底仍可保留，失败区间继续 pending。覆盖报告始终 `completenessClaimed:false`：只衡量程序识别的实体，不保证所有关键语义均已发现。
- `confirm(ref, options)` 是可信调用方的人工确认入口，新增审计，不覆盖原始记录。`supersede(old,new)` 要求旧、新记录仍有效且新来源更晚；相同关系重放幂等。`retract` / `resolve` 保留历史可读性。默认检索、recent 不重新引入与失效记录重叠的原文候选；保守排除整个重叠候选可能减少召回，显式 `read` / `readSource` 仍可检查历史。
- `recordFailure({ref,actionKey,scope})` 保存真实失败；`checkAction` 对比可信调用方提供的 scope。完全匹配及条件未知的未解决失败要求审阅；变化条件另列，不自动禁止操作，也不改变原有瞬态重试预算。
- `buildContext` 默认 16000 个 Unicode 码点，只计证据文本、来源标签、当前任务及省略提示。主规则提示词、其他系统提示和工具 schema 的 token 预算由宿主另计。它与原工具裁剪的 5159 字符上限是两个独立概念，本库不改变已安装裁剪参数。
- `buildContext` 默认 `pinMode:'relevant'`，仅将本次查询返回的相关已确认 pin 作为必留内容，不扫描全库 pin。`pinRefs:[n]` 显式声明本步必须保留的有效已确认 pin；`pinMode:'none'` 不提升查询结果为必留 pin；`pinMode:'all'` 仅供明确需要旧行为的调用方选择，不适合自动常驻。当前有效用户约束应由宿主放在 `currentTask`、原始当前指令或显式 `pinRefs` 中，不能指望一次检索替代它们。
- 当前任务、显式必留引用及本次相关 pin 必须完整放入；超预算报 `BudgetExceededError`，不能静默删约束。recent 默认关闭，避免仅因近期出现就占据检索预算。相关记录的 `scope.indexingBackgroundRefs` 默认按需展开为原文背景，和父摘录组成不可拆分的预算单元，计入同一 `maxChars`；可设 `includeBackground:false`。带背景的证据组优先于大块原文，整组放入或整组省略，不留下缺失必要背景的父摘录。必留 pin 的背景组若超限则明确报错。`groups` / `omittedGroups` 返回本轮接纳/省略的父引用与背景引用，`omittedRefs` 列出未提供的候选；相邻关系不证明因果或条件适用。
- 异步 rerank 期间若消息、记录、确认或失效关系变化，放弃旧排序，重新本地查询。失效重叠检查也适用于实体子片段及边界背景，避免旧约束绕过整段失效关系重新进入上下文。显式全 pin 模式或失败记录扫描达到 1000 条上限会明确报错，不把不完整扫描伪装成完整结果。
- `read(ref)` 返回精确片段、哈希、来源和状态；`readSource(ref,{start,maxChars})` 可扩读原消息，最多 8192 字符并返回 nextStart、hasMore。新返回的 ref 对应实际返回区间。
- `checkCitations(answer,{allowedRefs})` 仅检查引用存在且本轮可用，不能判断一句话是否真的被证据支持。

## 已验证与局限

库测试共 105 项，通过归档幂等、隔离、Unicode、引用稳定、崩溃事务恢复、源哈希损坏、中文检索、错误模型输出、失效防复活、异步纠正和硬预算检查。v0.2 新增跨段原文携带、背景引用越界拒绝、按需伴随回读、关键实体精确保留、漏选兜底、全版本号/小数阈值、无关 pin 不注入、实体子片段失效回归，以及小预算下父摘录/背景整组优先接纳和整组省略。配套 bridge 的测试及 OpenCode DeepSeek v4.1 Flash 实测结果单独记录于发行包验收报告，不应把库单元测试视为长程任务错误率证明。

本地检索是 ASCII 标识符/CJK bigram FTS 加精确子串，之后可由模型重排，不是向量语义检索；自然语言改写可能漏检，应使用具体关键词、多轮检索或扩读来源。边界背景有固定预算，仍可能未包含更早的指代或完整条件；需要原文扩读和追溯。整理模型可能误分类，确定性检测器也可能漏掉行业特有实体。库本身不安排自动队列、重试或清理；配套 DSH bridge 单独管理这些宿主行为，模型整理仍有界按需调用，不对所有原文自动发起模型请求。

DSH 归档适配器只收集原始 user/assistant/tool 的文本块，按原块顺序拼接；不保存隐藏推理、图片、工具参数或调用凭据。原 DSH 日志仍是完整事件真源。SQLite `DatabaseSync` 同步执行；配套 bridge 将其放在 worker 中。独立调用方也应避免在桌面主线程执行长归档或检索。

库缩小当前需要阅读的证据量，但不能保证模型必然使用证据或永不重犯。长上下文中的位置影响有研究依据：[Lost in the Middle](https://arxiv.org/abs/2307.03172)；长期对话还需评估更新、时间和拒答：[LongMemEval](https://arxiv.org/abs/2410.10813)。
