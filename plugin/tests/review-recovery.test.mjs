import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { MAX_QUERY_CHARS, validateQuery } from '../lib/protocol.mjs';

function fixture(t, options = {}, dependencies = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-review-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 100, autoRecallRetryDelayMs: 10, ...options }, dependencies);
  const events = [{ seq: 0, time: 1000, type: 'user/message', data: { id: 'user-0', source: { kind: 'user' }, content: [{ type: 'text', text: 'fast_token slow_token' }] } },
    { seq: 1, time: 1001, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'fast_token exact archived evidence' }] } } }];
  const session = { id: rootDir, get seq() { return events.length; }, surface: { nodes: [0,1], replaceGeneration: 0 },
    append() { throw Error('unexpected history rewrite'); }, snapshotEvents: async () => [...events], requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) };
  const agent = { session }, step = () => bridge.preStep({ agent, turn: 1, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter' }));
  t.after(async () => { await bridge.dispose(); if (dirname(resolve(rootDir)) !== resolve(tmpdir())) throw Error('Unsafe cleanup'); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { bridge, agent, events, session, step };
}

test('real preStep-refresh-search recovers the same turn after archive timeout, then freezes a successful packet', async t => {
  const f = fixture(t); await f.bridge.flush(f.agent);
  const original = f.bridge.flush.bind(f.bridge); let calls = 0;
  f.bridge.flush = (...args) => ++calls === 1 ? new Promise(() => {}) : original(...args);
  await f.step(); const entry = f.bridge.entries.get(f.session.id);
  assert.equal(entry.recallState, 'incomplete'); assert.equal(entry.recallAttempts, 1);
  assert.equal(entry.retrievalMetrics.snapshot().last.queryCount, 0);
  assert.match(entry.cache, /原始会话记录仍在/); assert.doesNotMatch(entry.cache, /原文仍在本会话 SQLite/);
  await f.step(); assert.equal(calls, 1, 'backoff prevents immediate polling');
  await delay(15); f.bridge.config.searchTimeoutMs = 10000; await f.step();
  assert.equal(entry.recallState, 'complete'); assert.equal(entry.recallAttempts, 2);
  const packet = entry.cache; await f.step(); assert.equal(calls, 2); assert.equal(entry.cache, packet);
});

test('unavailable recall is capped and compaction maintenance survives incomplete and failed attempts', async t => {
  const f = fixture(t); await f.bridge.flush(f.agent); const entry = f.bridge.entries.get(f.session.id);
  let recalls = 0, maintenance = 0;
  f.bridge.refreshBounded = async () => { recalls++; return { searchIncomplete: recalls < 2 }; };
  f.bridge.consolidate = async () => { maintenance++; if (maintenance === 1) throw Object.assign(Error('failed'), { code: 'MODEL_UNAVAILABLE' }); };
  await f.step(); f.session.surface.replaceGeneration++; await f.step();
  assert.equal(entry.pendingCompactionMaintenance, true); assert.equal(entry.recallState, 'failed');
  await delay(15); await f.step();
  assert.equal(maintenance, 2); assert.equal(entry.pendingCompactionMaintenance, false); assert.equal(entry.recallState, 'complete');
  f.session.surface.replaceGeneration++; f.bridge.refreshBounded = async () => { recalls++; return { searchIncomplete: true }; };
  for (let i = 0; i < 5; i++) { await delay(15); await f.step(); }
  assert.equal(entry.recallAttempts, 3); assert.equal(entry.recallState, 'incomplete'); assert.equal(entry.pendingCompactionMaintenance, true);
});

test('automatic recall telemetry includes native admission, worker readiness, snapshot and refresh', async t => {
  const f = fixture(t); await f.bridge.flush(f.agent); const entry = f.bridge.entries.get(f.session.id);
  f.bridge.ensure = async () => { await delay(20); return entry; };
  f.session.snapshotEvents = async () => { await delay(20); return f.events; };
  f.bridge.refreshBounded = async () => { await delay(20); };
  await f.bridge.preStep({ agent: f.agent, turn: 1, messages: [] }, async () => { await delay(20); return { kind: 'enter' }; });
  const sample = entry.autoRecallMetrics.snapshot().last;
  assert.ok(sample.elapsedMs >= 65); for (const key of ['nativePreStepMs','workerPreparationMs','snapshotMs','refreshMs']) assert.ok(sample.stages[key] >= 15, key);
});

test('cancellation and session switches during refresh cannot commit or complete an old automatic recall', async t => {
  for (const mode of ['cancel','switch','close']) {
    const f = fixture(t); await f.bridge.flush(f.agent);
    const entry = await f.bridge.ensure(f.agent), controller = new AbortController();
    const search = f.bridge.search.bind(f.bridge);
    f.bridge.search = async (...args) => {
      const found = await search(...args);
      if (mode === 'cancel') controller.abort();
      else if (mode === 'switch') f.agent.session = { ...f.session };
      else await f.bridge.disposeAgent(f.agent);
      return found;
    };
    await f.bridge.preStep({ agent: f.agent, turn: 1, messages: [], signal: controller.signal }, async () => ({ kind: 'enter' }));
    assert.equal(entry.cache, ''); assert.notEqual(entry.recallState, 'complete');
    if (mode === 'cancel') assert.equal(entry.recallState, 'cancelled');
  }
});

test('real parent timer delivers validated partial worker refs before a later query completes', async t => {
  const f = fixture(t, { searchTimeoutMs: 1000 }, { libraryUrl: new URL('./fixtures/delayed-library.mjs', import.meta.url).href });
  await f.bridge.flush(f.agent);
  const entry = await f.bridge.ensure(f.agent);
  const result = await f.bridge.search(f.agent, { query: 'fast_token slow_token', maxChars: 2000 });
  assert.equal(result.searchIncomplete, true); assert.equal(result.queryCount, 2); assert.ok(result.refs.length);
  assert.equal(result.progress.queryStarted, true); assert.equal(result.progress.archivedThroughSeq, 1);
  const raw = await f.bridge.read(f.agent, { ref: result.refs[0] }); assert.match(raw.text, /fast_token/);
  const cache = entry.cache; await delay(3020); assert.equal(entry.cache, cache); assert.equal(entry.pending.size, 0);
});

test('partial progress is discarded when the session surface changes during the real wait', async t => {
  const f = fixture(t, { searchTimeoutMs: 1000 }, { libraryUrl: new URL('./fixtures/delayed-library.mjs', import.meta.url).href }); await f.bridge.flush(f.agent);
  const onMessage = f.bridge.onMessage.bind(f.bridge); let changed = false;
  f.bridge.onMessage = (entry, message) => { onMessage(entry, message); if (!changed && message.type === 'progress' && message.result.refs.length) { changed = true; f.session.surface.replaceGeneration++; } };
  const result = await f.bridge.search(f.agent, { query: 'fast_token slow_token' });
  assert.equal(changed, true); assert.equal(result.searchIncomplete, true); assert.deepEqual(result.refs, []);
});

test('caller cancellation after partial progress rejects instead of publishing old evidence', async t => {
  const f = fixture(t, { searchTimeoutMs: 1000 }, { libraryUrl: new URL('./fixtures/delayed-library.mjs', import.meta.url).href }); await f.bridge.flush(f.agent);
  const controller = new AbortController(), onMessage = f.bridge.onMessage.bind(f.bridge);
  f.bridge.onMessage = (entry, message) => { onMessage(entry, message); if (message.type === 'progress' && message.result.refs.length) controller.abort(); };
  await assert.rejects(f.bridge.search(f.agent, { query: 'fast_token slow_token', signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await f.bridge.ensure(f.agent)).cache, '');
});

test('a real worker source revision invalidates previously delivered partial candidates', async t => {
  const f = fixture(t, { searchTimeoutMs: 1000 }, { libraryUrl: new URL('./fixtures/delayed-library.mjs', import.meta.url).href }); await f.bridge.flush(f.agent);
  let revised, scheduled = false; const onMessage = f.bridge.onMessage.bind(f.bridge);
  f.bridge.onMessage = (entry, message) => { onMessage(entry, message); if (!scheduled && message.type === 'progress' && message.result.refs.length) {
    scheduled = true; revised = f.bridge.index(f.agent, { query: 'fast_token', maxCalls: 1 });
    revised.catch(() => {});
  } };
  const found = await f.bridge.search(f.agent, { query: 'fast_token slow_token' });
  assert.equal(scheduled, true); await revised;
  assert.deepEqual(found.refs, []); assert.equal(found.searchIncomplete, true);
});

test('archive timeout reports an uncommitted target and later retry resumes from the committed cursor', async t => {
  const f = fixture(t, { searchTimeoutMs: 100 }, { libraryUrl: new URL('./fixtures/slow-archive-library.mjs', import.meta.url).href }); await f.bridge.flush(f.agent);
  f.events.push({ seq: 2, time: 1002, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'archive_delay_marker exact source' }] } } });
  const found = await f.bridge.search(f.agent, { query: 'archive_delay_marker' });
  assert.equal(found.searchIncomplete, true); assert.equal(found.progress.queryStarted, false);
  assert.equal(found.progress.archivedThroughSeq, 1); assert.equal(found.progress.targetSeq, 2);
  assert.match(found.text, /原始会话记录仍在/);
  f.bridge.config.searchTimeoutMs = 10000;
  const recovered = await f.bridge.search(f.agent, { query: 'archive_delay_marker' }); assert.ok(recovered.refs.length);
  assert.equal((await f.bridge.status(f.agent)).archivedThroughSeq, 2);
});

test('query contract consistently accepts 1000 Unicode code points and rejects 1001 at bridge and worker entry', async t => {
  const f = fixture(t, { searchTimeoutMs: 10000 }); await f.bridge.flush(f.agent); const entry = await f.bridge.ensure(f.agent);
  assert.equal(MAX_QUERY_CHARS, 1000); validateQuery('😀'.repeat(1000));
  for (const query of ['😀'.repeat(1001), 'x'.repeat(2000), '', '   ']) {
    assert.throws(() => validateQuery(query), { code: 'INVALID_QUERY' });
    await assert.rejects(f.bridge.search(f.agent, { query }), { code: 'INVALID_QUERY' });
    await assert.rejects(f.bridge.index(f.agent, { query }), { code: 'INVALID_QUERY' });
    for (const op of ['search','index']) await assert.rejects(f.bridge.rpc(entry, op, { query }), { code: 'INVALID_QUERY' });
  }
  const result = await f.bridge.search(f.agent, { query: '😀'.repeat(1000) }); assert.equal(result.searchIncomplete, false);
  await f.bridge.index(f.agent, { query: '😀'.repeat(1000) });
});
