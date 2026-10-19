import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createDshModel, ingestDshSession, DshAdapterError } from '../lib/dsh-adapter.mjs';

const message = text => ({ role: 'user', content: text });
const request = overrides => ({ purpose: 'memory-index', messages: [message('Index these source facts')], ...overrides });
const textChunks = text => [
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text },
  { type: 'block-end', index: 1, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
function fixture({ chunks = textChunks('{"facts":[]}'), header, options, info } = {}) {
  const calls = [];
  const agent = {
    session: {
      id: 'session-A',
      async requestHeader() {
        assert.equal(this, agent.session);
        return header ?? { config: { provider: 'current-provider', model: 'current-model', reasoningEffort: 'max', maxTokens: 999999 } };
      },
    },
    options: options ?? { provider: 'fallback-provider', model: 'fallback-model' },
  };
  const llm = {
    async resolveModelInfo(provider, model, signal) {
      assert.equal(this, llm);
      calls.push({ kind: 'info', provider, model, signal });
      return info ?? { reasoning: { efforts: [{ id: 'low' }, { id: 'max' }] } };
    },
    async stream(options) {
      assert.equal(this, llm);
      calls.push({ kind: 'stream', options });
      return (async function* () { yield* chunks; })();
    },
  };
  return { agent, llm, calls, model: createDshModel({ llm, getAgent: async () => agent }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof DshAdapterError && error.code === code);

test('uses the live route and real session, low effort, no tools, and bounded tokens', async () => {
  const { agent, calls, model } = fixture();
  const originalOptions = structuredClone(agent.options);
  const response = await model(request({ purpose: 'memory-rerank', maxTokens: 9000 }));
  assert.deepEqual(response, { text: '{"facts":[]}', finish: 'stop', tracePurpose: 'memory-rerank' });
  const options = calls.find(call => call.kind === 'stream').options;
  assert.equal(options.provider, 'current-provider');
  assert.equal(options.model, 'current-model');
  assert.equal(options.sessionId, 'session-A');
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.reasoningEffort, 'low');
  assert.equal(options.purpose, 'compaction');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'Index these source facts' }] }]);
  assert.equal(Object.hasOwn(options, 'toolHistory'), false);
  assert.equal(Object.hasOwn(options, 'system'), false);
  assert.deepEqual(agent.options, originalOptions);
});

test('resolves the current agent and route again on each auxiliary call', async () => {
  const { agent, llm, calls } = fixture();
  let current = agent;
  const model = createDshModel({ llm, getAgent: () => current, maxTokens: 700 });
  await model(request({ maxTokens: 400 }));
  current = { session: { id: 'session-B', requestHeader: async () => ({ config: { provider: 'B', model: 'B2' } }) } };
  await model(request());
  const requests = calls.filter(call => call.kind === 'stream').map(call => call.options);
  assert.deepEqual(requests.map(o => [o.sessionId, o.provider, o.model, o.maxTokens]), [
    ['session-A', 'current-provider', 'current-model', 400],
    ['session-B', 'B', 'B2', 700],
  ]);
});

test('fallback uses one complete options pair and never combines partial routes', async () => {
  const f = fixture({ header: { config: { provider: 'partial-header' } }, options: { provider: 'paired', model: 'paired-model', reasoningEffort: 'max' } });
  await f.model(request());
  assert.equal(f.calls.find(call => call.kind === 'stream').options.provider, 'paired');
  const incomplete = fixture({ header: { config: { provider: 'header-only' } }, options: { model: 'options-only' } });
  await rejectsCode(incomplete.model(request()), 'NO_MODEL');
  assert.equal(incomplete.calls.length, 0);
});

test('reasoning is omitted when unsupported and uses supported current effort without low', async () => {
  for (const [efforts, expected] of [[[], undefined], [[{ id: 'max' }], 'max']]) {
    const f = fixture({ info: { reasoning: { efforts } } });
    await f.model(request());
    const options = f.calls.find(call => call.kind === 'stream').options;
    assert.equal(options.reasoningEffort, expected);
    assert.equal(Object.hasOwn(options, 'reasoningEffort'), expected !== undefined);
  }
});

test('text block ends override deltas once and reasoning is never returned', async () => {
  const f = fixture({ chunks: [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'private analysis' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private analysis' } },
    { type: 'text-delta', index: 3, text: 'beta' },
    { type: 'text-delta', index: 1, text: 'al' },
    { type: 'text-delta', index: 1, text: 'pha' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'alpha' } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, reasoningTokens: 2, secret: 'do not forward' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] });
  assert.deepEqual(await f.model(request()), {
    text: 'alphabeta', finish: 'stop', tracePurpose: 'memory-index',
    usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, reasoningTokens: 2 },
  });
});

for (const kind of ['max-tokens', 'aborted', 'error', 'tool-calls']) {
  test(`rejects ${kind} finishes and does not expose provider failure data`, async () => {
    const f = fixture({ chunks: [
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind, failure: { message: 'credential-secret', cause: { headers: 'credential-secret' } } } },
    ] });
    await assert.rejects(f.model(request()), error => {
      assert.equal(error.code, 'INCOMPLETE_RESPONSE');
      assert.equal(JSON.stringify(error).includes('credential-secret'), false);
      assert.equal(error.message.includes('credential-secret'), false);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  });
}

for (const chunk of [
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: 'call', name: 'shell', argumentsDelta: '{}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', name: 'shell', arguments: '{}' } },
]) {
  test(`rejects tool output at ${chunk.type} before it can be accepted as text`, async () => {
    const f = fixture({ chunks: [{ type: 'text-delta', index: 0, text: '{}' }, chunk, { type: 'finish', reason: { kind: 'stop' } }] });
    await rejectsCode(f.model(request()), 'TOOL_RESPONSE');
  });
}

test('rejects rich blocks even when a valid text answer is also present', async () => {
  for (const chunk of [
    { type: 'block-start', index: 2, blockType: 'image' },
    { type: 'block-end', index: 2, block: { type: 'image', data: 'ignored' } },
    { type: 'block-end', index: 2, block: { type: 'unknown' } },
  ]) {
    await rejectsCode(fixture({ chunks: [chunk, ...textChunks('{}')] }).model(request()), 'NONTEXT_RESPONSE');
  }
});

test('rejects empty, missing-terminal, malformed, duplicate-terminal, and inconsistent streams', async () => {
  const cases = [
    [[{ type: 'finish', reason: { kind: 'stop' } }], 'EMPTY_RESPONSE'],
    [[{ type: 'text-delta', index: 0, text: 'hi' }], 'INCOMPLETE_RESPONSE'],
    [[{ type: 'text-delta', index: -1, text: 'hi' }], 'INVALID_RESPONSE'],
    [[{ type: 'text-delta', index: 0, text: {} }], 'INVALID_RESPONSE'],
    [[...textChunks('hi'), { type: 'finish', reason: { kind: 'stop' } }], 'INVALID_RESPONSE'],
    [[{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'text-delta', index: 0, text: 'hi' }], 'INVALID_RESPONSE'],
    [[{ type: 'usage', usage: { inputTokens: NaN, outputTokens: 1 } }], 'INVALID_RESPONSE'],
    [[{ type: 'other' }], 'INVALID_RESPONSE'],
  ];
  for (const [chunks, code] of cases) await rejectsCode(fixture({ chunks }).model(request()), code);
});

test('validates text-only input and does not dispatch unsupported purposes', async () => {
  const f = fixture();
  for (const overrides of [
    { purpose: 'other' }, { messages: [] }, { maxTokens: 0 },
    { messages: [{ role: 'tool', content: 'tool history' }] },
    { messages: [{ role: 'user', content: [{ type: 'image', data: 'x' }] }] },
    { messages: [message('   ')] },
  ]) await rejectsCode(f.model(request(overrides)), 'INVALID_REQUEST');
  assert.equal(f.calls.length, 0);
});

test('normalizes DSH text blocks without forwarding extra source metadata', async () => {
  const f = fixture();
  const input = [{ role: 'assistant', source: { kind: 'tool', callId: 'unwanted' }, content: [{ type: 'text', text: 'facts', metadata: 'unwanted' }] }];
  await f.model(request({ messages: input }));
  assert.deepEqual(f.calls.find(call => call.kind === 'stream').options.messages, [{ role: 'assistant', content: [{ type: 'text', text: 'facts' }] }]);
  assert.equal(input[0].source.callId, 'unwanted');
});

test('aborted input never resolves an agent or dispatches a model', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('private abort message'));
  await rejectsCode(f.model(request({ signal: controller.signal })), 'ABORTED');
  assert.equal(f.calls.length, 0);
});

test('deadline bounds a stalled async model proxy and aborts its signal', async () => {
  const f = fixture();
  let signal;
  f.llm.resolveModelInfo = async (_provider, _model, currentSignal) => {
    signal = currentSignal;
    return new Promise(() => {});
  };
  const model = createDshModel({ llm: f.llm, getAgent: () => f.agent, timeoutMs: 15 });
  await rejectsCode(model(request()), 'TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.length, 0);
});

test('deadline and caller abort also bound a stalled iterator and request cleanup', async () => {
  for (const abortByCaller of [false, true]) {
    const f = fixture();
    let returned = 0;
    f.llm.stream = () => ({
      [Symbol.asyncIterator]() { return this; },
      next() { return new Promise(() => {}); },
      return() { returned++; return new Promise(() => {}); },
    });
    const controller = new AbortController();
    const model = createDshModel({ llm: f.llm, getAgent: () => f.agent, timeoutMs: abortByCaller ? 2000 : 15 });
    const pending = model(request({ signal: controller.signal }));
    const timer = abortByCaller ? setTimeout(() => controller.abort(), 15) : undefined;
    await rejectsCode(pending, abortByCaller ? 'ABORTED' : 'TIMEOUT');
    clearTimeout(timer);
    assert.equal(returned, 1);
  }
});

test('session changes before dispatch fail without a model call', async () => {
  const f = fixture();
  f.llm.resolveModelInfo = async () => { f.agent.session = { id: 'different' }; return {}; };
  await rejectsCode(f.model(request()), 'SESSION_CHANGED');
  assert.equal(f.calls.length, 0);
});

test('adapter errors do not forward arbitrary provider exception details', async () => {
  const f = fixture();
  f.llm.stream = () => { throw new Error('credential-secret'); };
  await assert.rejects(f.model(request()), error => error.code === 'MODEL_FAILED' && !String(error).includes('credential-secret') && !Object.hasOwn(error, 'cause'));
});

const event = (seq, type, content, extras = {}) => ({
  seq, type, time: 1700000000000 + seq,
  data: type === 'user/message' ? { role: 'user', content } : { message: { role: type === 'assistant/message' ? 'assistant' : 'user', content } },
  ...extras,
});
function ingestFixture(events) {
  const records = [];
  const memory = { conversationId: 'session-A', async append(record) { assert.equal(this, memory); records.push(record); return { id: records.length }; } };
  const session = { id: 'session-A', snapshotEvents() { assert.equal(this, session); return events; } };
  return { memory, session, records };
}

test('ingests only raw user, assistant, and tool text with stable source keys', async () => {
  const f = ingestFixture([
    event(0, 'session/end-seed', []),
    event(1, 'user/message', [{ type: 'text', text: 'user' }]),
    event(2, 'assistant/message', [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'assistant' }, { type: 'tool-call', arguments: 'hidden' }]),
    event(3, 'tool/result', [{ type: 'text', text: 'tool ' }, { type: 'image', data: 'hidden' }, { type: 'text', text: 'result' }]),
    event(4, 'compaction/end', [{ type: 'text', text: 'do not import arbitrary events' }]),
    event(5, 'assistant/message', [{ type: 'reasoning', text: 'hidden only' }]),
  ]);
  assert.deepEqual(await ingestDshSession(f.memory, f.session), { sessionId: 'session-A', scanned: 6, appended: 3, skipped: 3, lastSeq: 5 });
  assert.deepEqual(f.records.map(record => [record.sourceKey, record.role, record.text]), [
    ['dsh:session-A:1', 'user', 'user'], ['dsh:session-A:2', 'assistant', 'assistant'], ['dsh:session-A:3', 'tool', 'tool result'],
  ]);
  assert.deepEqual(f.records[2].metadata, { sessionId: 'session-A', seq: 3, type: 'tool/result', role: 'tool', time: 1700000000003 });
  assert.equal(f.records[2].createdAt, '2023-11-14T22:13:20.003Z');
  assert.equal(Object.hasOwn(f.records[2], 'ref'), false);
});

test('supports an async snapshot proxy and async event iterator, afterSeq exclusive', async () => {
  const f = ingestFixture([]);
  f.session.snapshotEvents = async () => (async function* () {
    yield event(1, 'user/message', [{ type: 'text', text: 'old' }]);
    yield event(2, 'assistant/message', [{ type: 'text', text: 'new' }]);
  })();
  const result = await ingestDshSession(f.memory, f.session, { afterSeq: 1 });
  assert.deepEqual(f.records.map(record => record.sourceKey), ['dsh:session-A:2']);
  assert.equal(result.lastSeq, 2);
});

test('repeat ingestion produces the same source keys for store idempotency', async () => {
  const f = ingestFixture([event(1, 'user/message', [{ type: 'text', text: 'original' }])]);
  await ingestDshSession(f.memory, f.session);
  await ingestDshSession(f.memory, f.session);
  assert.deepEqual(f.records[0], f.records[1]);
});

test('rejects an unbound or other-conversation memory before reading any events', async () => {
  for (const conversationId of [undefined, 'session-B', ' session-A']) {
    const f = ingestFixture([]);
    f.memory.conversationId = conversationId;
    f.session.snapshotEvents = () => { throw new Error('must not read'); };
    await rejectsCode(ingestDshSession(f.memory, f.session), 'SESSION_MISMATCH');
    assert.equal(f.records.length, 0);
  }
});

test('rejects foreign event identity and a session change during backfill', async () => {
  const foreign = ingestFixture([event(1, 'user/message', [{ type: 'text', text: 'foreign' }], { sessionId: 'session-B' })]);
  await rejectsCode(ingestDshSession(foreign.memory, foreign.session), 'SESSION_MISMATCH');
  assert.equal(foreign.records.length, 0);
  const changed = ingestFixture([]);
  changed.session.snapshotEvents = async () => { changed.session.id = 'session-B'; return []; };
  await rejectsCode(ingestDshSession(changed.memory, changed.session), 'SESSION_MISMATCH');
});

test('malformed event sequences and timestamps fail before writing', async () => {
  for (const extras of [{ seq: NaN }, { time: NaN }, { time: 8.64e15 + 1 }]) {
    const f = ingestFixture([event(1, 'user/message', [{ type: 'text', text: 'bad' }], extras)]);
    await rejectsCode(ingestDshSession(f.memory, f.session), 'INVALID_RESPONSE');
    assert.equal(f.records.length, 0);
  }
});

test('durable memory append failures propagate and stop ingestion', async () => {
  const f = ingestFixture([event(1, 'user/message', [{ type: 'text', text: 'first' }]), event(2, 'user/message', [{ type: 'text', text: 'second' }])]);
  const error = new Error('storage unavailable');
  let writes = 0;
  f.memory.append = async () => { writes++; throw error; };
  await assert.rejects(ingestDshSession(f.memory, f.session), current => current === error);
  assert.equal(writes, 1);
});

test('real SQLite store accepts ingestion timestamps and preserves idempotent source identity', async () => {
  const { ConversationStore } = await import('../lib/sqlite-store.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'conversation-memory-dsh-adapter-'));
  let store;
  try {
    store = new ConversationStore({ rootDir, conversationId: 'session-A' });
    const f = ingestFixture([event(1, 'user/message', [{ type: 'text', text: 'unique-evidence-42' }])]);
    await ingestDshSession(store, f.session);
    await ingestDshSession(store, f.session);
    const rows = store.listMessages();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceKey, 'dsh:session-A:1');
    assert.equal(rows[0].createdAt, '2023-11-14T22:13:20.001Z');
    assert.equal(rows[0].metadata.time, 1700000000001);
    assert.equal(rows[0].text, 'unique-evidence-42');
  } finally {
    store?.close();
    // Delete only the exact temporary test directory created above.
    const absolute = resolve(rootDir);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.split(sep).at(-1).startsWith('conversation-memory-dsh-adapter-')) throw new Error('Unexpected test directory');
    rmSync(absolute, { recursive: true });
  }
});
