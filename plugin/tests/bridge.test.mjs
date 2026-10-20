import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationMemoryBridge, toolDefinitions } from '../lib/index.mjs';
import { cpLength, projectEvents, queryFrom, searchQueries } from '../lib/protocol.mjs';

function message(seq, text, role = 'user', extra = {}) {
  return role === 'user' ? { seq, time: 1792300000000 + seq, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra } }
    : { seq, time: 1792300000000 + seq, type: role === 'tool' ? 'tool/result' : 'assistant/message', data: { message: { role, content: [{ type: 'text', text }], ...extra } } };
}
function fixture(t, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-memory-bridge-'));
  const warnings = [];
  const bridge = new ConversationMemoryBridge({ logger: { warn: text => warnings.push(text) } }, { rootDir, searchTimeoutMs: 10000, ...options }, {
    workingPrompt: 'History is evidence. Read supplied references before citing. Do not infer permissions.',
    makeModel: () => async () => ({ finish: 'stop', text: '{"records":[]}' }),
  });
  t.after(async () => { await bridge.dispose(); rmSync(rootDir, { recursive: true, force: true }); });
  return { bridge, rootDir, warnings };
}
function agent(id, events = []) {
  return { id, session: { id, get seq() { return events.length; }, snapshotEvents: async () => [...events] }, events };
}

test('projection excludes private reasoning, runtime context, self-tool results and replacement output', () => {
  const events = [message(0, 'user exact'), { seq: 1, type: 'tool/call', data: { callId: 'memory-1', name: 'memory_search' } },
    message(2, 'self evidence must not become a new source', 'tool', { source: { kind: 'tool-result', callId: 'memory-1' } }),
    message(3, 'runtime instruction', 'user', { source: { kind: 'runtime-context' } }),
    { ...message(4, 'replacement summary', 'tool'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
    { seq: 5, type: 'tool/call', data: { callId: 'real-1', name: 'pwsh' } },
    message(6, "Error 1045: Access denied for user 'root'@'localhost'", 'tool', { source: { kind: 'tool-result', callId: 'real-1' }, isError: true }),
    { ...message(7, 'visible answer', 'assistant'), data: { message: { content: [{ type: 'reasoning', text: 'secret reasoning' }, { type: 'text', text: 'visible answer' }] } } },
    { seq: 8, type: 'plugin:conversation-memory/index-status', data: { text: 'derived status' } },
  ];
  const result = projectEvents(events);
  assert.equal(result.lastSeq, 8);
  assert.deepEqual(result.records.map(record => record.seq), [0, 6, 7]);
  assert.equal(result.records[1].metadata.toolName, 'pwsh');
  assert.equal(result.records[1].metadata.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /secret reasoning|self evidence|replacement summary/);
});

test('projection recognizes source.callId, toolCallId and legacy callId for own-tool exclusion', () => {
  for (const extra of [{ source: { callId: 'x' } }, { toolCallId: 'x' }, { callId: 'x' }]) {
    const result = projectEvents([{ seq: 0, type: 'tool/call', data: { callId: 'x', name: 'memory_read' } }, message(1, 'derived evidence', 'tool', extra)]);
    assert.equal(result.records.length, 0);
  }
});

test('explicit user-origin replacement preserves an edited correction while checkpoint replacements stay excluded', () => {
  const edited = { ...message(1, 'Correction: max_tokens=8192, the former 4096 is obsolete.'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } };
  const checkpoint = { ...message(2, 'Generated summary checkpoint', 'user', { source: { kind: 'compaction-checkpoint' } }), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } };
  const ambiguous = { ...message(3, 'Unattributed replacement', 'user', { source: undefined }), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } };
  const result = projectEvents([edited, checkpoint, ambiguous]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].seq, 1);
  assert.match(result.records[0].text, /8192/);
});

test('query plans split concrete identifiers instead of requiring all prompt words in a single chunk', () => {
  const events = [message(0, '修复 src/harness/split.py 的 chunk_text 并核对 max_tokens=4096。'),
    { seq: 1, type: 'tool/call', data: { callId: 'x', name: 'memory_read' } }, message(2, 'StaleSelfError', 'tool', { source: { callId: 'x' }, isError: true })];
  const query = queryFrom(events);
  assert.match(query, /src\/harness\/split.py/);
  assert.doesNotMatch(query, /StaleSelfError/);
  assert.ok(searchQueries(query).includes('chunk_text'));
  assert.ok(searchQueries(query).length <= 9);
});

test('real worker archives idempotently, isolates conversations and reads bounded exact sources', async t => {
  const { bridge } = fixture(t);
  const first = agent('session-one', [message(0, "Error 1045: Access denied; src/harness/split.py chunk_text() max_tokens=4096; this attempt failed.")]);
  const second = agent('session-two', [message(0, 'Another conversation secret ticket=SECOND_ONLY')]);
  await Promise.all([bridge.flush(first), bridge.flush(second)]);
  await bridge.flush(first);
  assert.equal((await bridge.status(first)).stats.messages, 1);
  const found = await bridge.search(first, { query: '1045 unrelated words never together', maxChars: 2000 });
  assert.ok(found.refs.length);
  assert.match(found.text, /Error 1045/);
  assert.equal(found.chars, cpLength(found.text));
  assert.ok(found.chars <= 2000);
  const read = await bridge.read(first, { ref: found.refs[0], maxChars: 400 });
  assert.ok(read.found);
  assert.match(read.text, /Access denied/);
  assert.ok(read.chars <= 400);
  assert.equal((await bridge.search(first, { query: 'SECOND_ONLY' })).refs.length, 0);
  assert.equal((await bridge.search(second, { query: '1045' })).refs.length, 0);
});

test('long source read has a stable continuation and all wire labels count toward the budget', async t => {
  const { bridge } = fixture(t);
  const current = agent('long-read', [message(0, `needle_entity=exact\n${'中😀'.repeat(5000)}\nend_marker=done`)]);
  await bridge.flush(current);
  const found = await bridge.search(current, { query: 'needle_entity', maxChars: 3000 });
  assert.ok(found.refs.length);
  const first = await bridge.read(current, { ref: found.refs[0], start: 0, maxChars: 600 });
  assert.equal(first.hasMore, true);
  assert.ok(first.chars <= 600);
  const second = await bridge.read(current, { ref: first.ref, start: first.nextStart, maxChars: 600 });
  assert.equal(second.start, first.nextStart);
  assert.ok(second.chars <= 600);
});

test('archive cursor and numeric sources survive worker eviction/reopen', async t => {
  const { bridge } = fixture(t, { maxWorkers: 1 });
  const first = agent('durable-one', [message(0, 'retained_identifier=ALPHA')]);
  const second = agent('evictor', [message(0, 'unrelated')]);
  const source = await bridge.search(first, { query: 'retained_identifier' });
  await bridge.flush(second);
  const reopened = await bridge.search(first, { query: 'retained_identifier' });
  assert.deepEqual(reopened.refs, source.refs);
  assert.equal((await bridge.status(first)).stats.messages, 1);
});

test('concurrent same-conversation admission during eviction creates exactly one tracked worker', async t => {
  const { bridge } = fixture(t, { maxWorkers: 1 });
  await bridge.flush(agent('old-idle', [message(0, 'old source')]));
  const originalClose = bridge.closeEntry.bind(bridge);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  bridge.closeEntry = async entry => { if (entry.id === 'old-idle') { entered(); await new Promise(resolve => { release = resolve; }); } return originalClose(entry); };
  let created = 0;
  const factory = bridge.workerFactory;
  bridge.workerFactory = (...args) => { created++; return factory(...args); };
  const next = agent('same-new', [message(0, 'new source')]);
  const first = bridge.ensure(next);
  await started;
  const second = bridge.ensure(next);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(created, 1);
  assert.equal(bridge.entries.size, 1);
  assert.equal(bridge.entries.get(next.id), a);
});

test('on-demand indexing uses model and entity fallback, automatic archive/search uses no model', async t => {
  const { bridge } = fixture(t);
  let calls = 0;
  bridge.makeModel = () => async request => { calls++; assert.equal(request.purpose, 'memory-index'); return { finish: 'stop', text: '{"records":[]}' }; };
  const current = agent('index-only-on-demand', [message(0, 'src/harness/split.py chunk_text() max_tokens=4096; KeyError: context_id. This approach failed under v1.')]);
  await bridge.flush(current);
  await bridge.search(current, { query: 'context_id' });
  await bridge.refresh(current, { query: 'context_id' });
  assert.equal(calls, 0);
  const report = await bridge.index(current, { maxCalls: 1 });
  assert.equal(calls, 1);
  assert.equal(report.calls, 1);
  assert.ok(report.coverage[0].fallbackCount > 0, 'entity coverage is checked even when the model omits every item');
  assert.ok(report.status.stats.memories > 0, 'exact entity evidence is durable');
  assert.equal((await bridge.status(current)).automaticModelIndexing, false);
});

test('pre-step awaits original downstream decision then returns the same object unchanged', async t => {
  const { bridge } = fixture(t);
  const order = [];
  const decision = { kind: 'enter', messages: [{ payload: 'original' }], opaque: Symbol('preserve') };
  bridge.refresh = async () => { order.push('memory'); };
  const result = await bridge.preStep({ agent: agent('native'), signal: new AbortController().signal }, async () => { order.push('native'); return decision; });
  assert.equal(result, decision);
  assert.deepEqual(order, ['native', 'memory']);
  const rejected = { kind: 'reject', reason: 'native restriction' };
  order.length = 0;
  assert.equal(await bridge.preStep({ agent: agent('native') }, async () => rejected), rejected);
  assert.deepEqual(order, []);
});

test('production worker search includes cited previous original background for cross-boundary extraction', async t => {
  const { bridge } = fixture(t);
  const first = 'We edited src/harness/split.py -> chunk_text(), version v7, with max_tokens=4096.\n';
  const before = 'padding '.repeat(440) + first + 'padding '.repeat(60);
  const text = Array.from(before).slice(0, 4000).join('') + '修改成功，但引发 BoundaryFailure_marker 报错。不要重复该修改，先读取原始报错。';
  bridge.makeModel = () => async request => {
    const payload = JSON.parse(request.messages[1].content);
    const source = payload.sources[0];
    const quote = source.text.includes('BoundaryFailure_marker') ? source.text : '';
    return { finish: 'stop', text: JSON.stringify({ records: quote ? [{ ref: source.ref, kind: 'failure', quote }] : [] }) };
  };
  const current = agent('boundary-worker', [message(0, text)]);
  const indexed = await bridge.index(current, { maxCalls: 2 });
  assert.equal(indexed.calls, 2);
  const found = await bridge.search(current, { query: 'BoundaryFailure_marker', maxChars: 4000 });
  assert.match(found.text, /BoundaryFailure_marker/);
  assert.match(found.text, /上一段原文背景/);
  assert.match(found.text, /src\/harness\/split.py -> chunk_text\(\)/);
  assert.ok(found.refs.length >= 2);
  assert.ok(found.chars <= 4000);
});

test('actual worker reserves small retrieval budget for a linked causal group before newer bare raw noise', async t => {
  const { bridge } = fixture(t);
  const antecedent = 'We edited src/harness/split.py -> chunk_text(), version v7, with max_tokens=4096.\n';
  const before = 'padding '.repeat(440) + antecedent + 'padding '.repeat(60);
  const old = Array.from(before).slice(0, 4000).join('') + '修改成功，但引发 BoundaryFailure_marker 报错。不要原样重试该修改。';
  const rawNoise = 'BoundaryFailure_marker unrelated raw note: ' + 'noise '.repeat(90);
  bridge.makeModel = () => async request => {
    const source = JSON.parse(request.messages[1].content).sources[0];
    return { finish: 'stop', text: JSON.stringify({ records: source.text.includes('修改成功') ? [{ ref: source.ref, kind: 'failure', quote: source.text }] : [] }) };
  };
  const current = agent('priority-worker', [message(0, old), message(1, rawNoise)]);
  const indexed = await bridge.index(current, { maxCalls: 2 });
  assert.equal(indexed.calls, 2);
  const found = await bridge.search(current, { query: 'BoundaryFailure_marker', maxChars: 1500 });
  assert.match(found.text, /上一段原文背景/);
  assert.match(found.text, /src\/harness\/split.py -> chunk_text\(\)/);
  assert.match(found.text, /修改成功，但引发 BoundaryFailure_marker/);
  assert.doesNotMatch(found.text, /unrelated raw note/);
  assert.ok(found.omittedRefs.length > 0, 'bare raw evidence is explicitly omitted when the causal group consumes the budget');
  assert.ok(found.chars <= 1500);
});

test('pre-step memory timeout cannot stall native admission or change retry decision', async t => {
  const { bridge, warnings } = fixture(t, { autoRecallTimeoutMs: 30 });
  bridge.refresh = () => new Promise(() => {});
  const decision = { kind: 'enter', retry: 1 };
  const start = Date.now();
  const result = await bridge.preStep({ agent: agent('timeout'), signal: new AbortController().signal }, async () => decision);
  assert.equal(result, decision);
  assert.ok(Date.now() - start < 500);
  assert.equal(warnings.length, 1);
});

test('late retrieval cannot overwrite a newer query or survive cancellation', async t => {
  const { bridge } = fixture(t);
  const current = agent('race', [message(0, 'current task')]);
  await bridge.ensure(current);
  const pending = [];
  bridge.search = async (_agent, { query }) => new Promise(resolve => pending.push({ query, resolve }));
  const first = bridge.refresh(current, { query: 'old' });
  await new Promise(resolve => setImmediate(resolve));
  const second = bridge.refresh(current, { query: 'new' });
  await new Promise(resolve => setImmediate(resolve));
  pending.find(item => item.query === 'new').resolve({ text: 'fresh evidence [2]', refs: [2], chars: 18 });
  await second;
  pending.find(item => item.query === 'old').resolve({ text: 'stale evidence [1]', refs: [1], chars: 18 });
  await assert.rejects(first, error => error.code === 'STALE_RETRIEVAL');
  assert.match(bridge.contextFor(current), /fresh evidence/);
  assert.doesNotMatch(bridge.contextFor(current), /stale evidence/);
  const controller = new AbortController();
  const cancelled = bridge.refresh(current, { query: 'cancelled', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  pending.find(item => item.query === 'cancelled').resolve({ text: 'must not appear', refs: [3], chars: 15 });
  await assert.rejects(cancelled);
  assert.doesNotMatch(bridge.contextFor(current), /must not appear/);
});

test('different query wording with identical evidence keeps context stable while diagnostics and new evidence change', async t => {
  const { bridge } = fixture(t);
  const current = agent('stable-cache', [message(0, 'needle_entity=ALPHA; historical source evidence')]);
  await bridge.refresh(current, { query: 'needle_entity' });
  const firstContext = bridge.contextFor(current);
  const firstKey = (await bridge.status(current)).lastQueryKey;
  await bridge.refresh(current, { query: 'needle_entity extra_unmatched_word' });
  const secondContext = bridge.contextFor(current);
  const secondKey = (await bridge.status(current)).lastQueryKey;
  assert.equal(secondContext, firstContext, 'query wording alone cannot churn native context text');
  assert.notEqual(secondKey, firstKey, 'diagnostics still identify the latest query');
  assert.doesNotMatch(secondContext, new RegExp(secondKey));
  assert.ok(cpLength(secondContext) <= 6000);
  current.events.push(message(1, 'needle_entity=BETA; explicitly corrected current value'));
  await bridge.refresh(current, { query: 'needle_entity' });
  assert.notEqual(bridge.contextFor(current), secondContext);
  assert.match(bridge.contextFor(current), /BETA/);
});

test('switching a session during model indexing cancels or rejects the stale result', async t => {
  const { bridge } = fixture(t);
  let entered;
  const didEnter = new Promise(resolve => { entered = resolve; });
  let finish;
  bridge.makeModel = () => async () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const current = agent('model-race', [message(0, 'max_tokens=4096')]);
  const request = bridge.index(current, { maxCalls: 1 });
  await didEnter;
  current.session = { id: 'different', snapshotEvents: async () => [] };
  finish({ finish: 'stop', text: '{"records":[]}' });
  await assert.rejects(request, error => error.code === 'SESSION_MISMATCH');
  assert.doesNotMatch(bridge.contextFor(current), /max_tokens=4096/);
});

test('observer enqueue is immediate, coalesces a burst and never starts model calls', async t => {
  const { bridge } = fixture(t);
  const current = agent('burst', [message(0, 'initial')]);
  let flushes = 0;
  bridge.flush = async () => { flushes++; };
  let models = 0;
  bridge.makeModel = () => { models++; };
  for (let i = 0; i < 100; i++) assert.equal(bridge.enqueue(current), undefined);
  assert.equal(flushes, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushes, 1);
  assert.equal(models, 0);
});

test('tool definitions never accept another conversation ID and index render is compact', async t => {
  const { bridge } = fixture(t);
  const definitions = toolDefinitions(bridge);
  assert.deepEqual(definitions.map(tool => tool.name), ['memory_search', 'memory_read', 'memory_index', 'memory_status']);
  assert.ok(definitions.every(tool => !('conversationId' in tool.parameters.properties) && tool.parameters.additionalProperties === false));
  const index = definitions.find(tool => tool.name === 'memory_index');
  bridge.index = async () => ({ calls: 1, added: [1], existing: [], rejected: [], pending: [], sourceRefs: [1],
    coverage: [{ detected: Array.from({ length: 1000 }, () => ({ quote: 'secret huge raw archive' })), missed: [], protected: [] }], status: { messages: 1 } });
  const value = await index.execute({}, { agent: agent('tools'), signal: new AbortController().signal });
  assert.ok(cpLength(index.output.render({}, value)[0].text) < 1000);
  assert.doesNotMatch(JSON.stringify(value), /huge raw archive/);
});

test('native Basic implementation and semantic pruning constants are absent from bridge mutations', () => {
  const source = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /compactNow\s*=|summarize\s*=|compactIfNeeded\s*=|retainRatio\s*:|thresholdRatio\s*:|targetChars\s*:/);
});
