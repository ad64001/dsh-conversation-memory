import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { collectQueries, incompleteNotice, RetrievalMetrics } from '../lib/retrieval.mjs';
import { ConversationMemoryBridge, evidenceAlreadyVisible } from '../lib/index.mjs';

test('query plan continues past a full first result and merges independently found originals', async () => {
  const calls = [];
  const result = await collectQueries({ queries: ['combined', 'identifier', 'error', 'error'], deadlineAt: Infinity,
    yieldControl: async () => {}, lookup: async query => {
      calls.push(query);
      return { records: query === 'error' ? [{ ref: 20, text: 'independent failure' }] : [{ ref: 1 }, { ref: 2 }, { ref: 1 }] };
    } });
  assert.deepEqual(calls, ['combined', 'identifier', 'error']);
  assert.equal(result.candidates.get(1).hits, 4, 'duplicates in one route cannot inflate ranking');
  assert.ok(result.candidates.has(20));
  assert.equal(result.incomplete, false);
});

test('deadline retains collected evidence and reports an incomplete query plan', async () => {
  let clock = 0;
  const result = await collectQueries({ queries: ['one', 'two'], deadlineAt: 10, now: () => clock,
    yieldControl: async () => { clock = 11; }, lookup: async () => ({ records: [{ ref: 7 }] }) });
  assert.equal(result.queryCount, 1);
  assert.equal(result.plannedQueryCount, 2);
  assert.equal(result.incomplete, true);
  assert.ok(result.candidates.has(7));
});

test('caller cancellation stops the plan rather than disguising cancellation as no matches', async () => {
  const controller = new AbortController(), reason = new Error('caller stopped');
  await assert.rejects(collectQueries({ queries: ['one', 'two'], deadlineAt: Infinity, signal: controller.signal,
    lookup: async () => ({ records: [] }), yieldControl: async () => controller.abort(reason) }), error => error === reason);
});

test('rolling latency percentiles have a fixed window and separate all-time failure counts', () => {
  const stats = new RetrievalMetrics(3);
  assert.equal(stats.snapshot().p99Ms, null);
  for (const elapsedMs of [100, 1, 2, 3]) stats.record({ elapsedMs, incomplete: elapsedMs === 100 });
  assert.deepEqual([stats.snapshot().calls, stats.snapshot().windowSamples, stats.snapshot().incomplete,
    stats.snapshot().p50Ms, stats.snapshot().p95Ms, stats.snapshot().p99Ms], [4, 3, 1, 2, 3, 3]);
});

function fixture(t, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-retrieval-test-'));
  let models = 0;
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, ...options }, {
    workingPrompt: 'Read exact historical evidence.', makeModel: () => async () => { models++; throw Error('Search must not invoke a model'); },
  });
  const events = ['keep_original module=cache_worker batch_size=128', 'Correction: keep_original batch_size=64; readonly=true.']
    .map((text, seq) => ({ seq, time: 1792300000000 + seq, type: 'user/message',
      data: { id: 'source-' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }));
  const agent = { session: { id: 'retrieval-test', seq: events.length, snapshotEvents: async () => [...events] } };
  t.after(async () => {
    await bridge.dispose();
    if (dirname(resolve(rootDir)) !== resolve(tmpdir())) throw Error('Unsafe cleanup');
    rmSync(rootDir, { recursive: true, force: true });
  });
  return { bridge, agent, models: () => models };
}

test('real worker search is model-free, reads original corrections, and keeps timing out of the evidence packet', async t => {
  const { bridge, agent, models } = fixture(t, { searchTimeoutMs: 3000 });
  await bridge.refresh(agent, { query: 'keep_original' });
  const first = bridge.contextFor(agent);
  const found = await bridge.search(agent, { query: 'keep_original batch_size' });
  assert.ok(found.refs.length);
  assert.match(found.text, /batch_size=64/);
  assert.equal(found.searchIncomplete, false);
  assert.ok(found.workerSearchMs >= 0);
  const source = await bridge.read(agent, { ref: found.refs[0] });
  assert.equal(source.found, true);
  const status = await bridge.status(agent);
  assert.equal(status.retrieval.backend, 'sqlite');
  assert.equal(status.retrieval.metrics.calls, 2);
  assert.equal(models(), 0);
  assert.equal(bridge.contextFor(agent), first);
  await bridge.refresh(agent, { query: 'keep_original' });
  assert.equal(bridge.contextFor(agent), first, 'fresh latency samples cannot rewrite memory text');
});

test('an archive wait that never settles returns explicit incompleteness within the client budget', async t => {
  const { bridge, agent } = fixture(t, { searchTimeoutMs: 25 });
  await bridge.flush(agent);
  bridge.flush = () => new Promise(() => {});
  const result = await bridge.search(agent, { query: 'keep_original' });
  assert.equal(result.searchIncomplete, true);
  assert.equal(result.userOriginalCoverageIncomplete, true);
  assert.match(result.text, /检索未完成/);
  assert.doesNotMatch(result.text, /未命中/);
  assert.equal((await bridge.status(agent)).retrieval.metrics.incomplete, 1);
});

test('search cancellation and operational errors remain errors rather than false successful searches', async t => {
  const { bridge, agent } = fixture(t);
  const controller = new AbortController(), reason = new Error('cancelled'); controller.abort(reason);
  await assert.rejects(bridge.search(agent, { query: 'keep_original', signal: controller.signal }), error => error === reason);
  bridge.flush = async () => { throw Object.assign(new Error('disk failed'), { code: 'STATE_WRITE_FAILED' }); };
  await assert.rejects(bridge.search(agent, { query: 'keep_original' }), { code: 'STATE_WRITE_FAILED' });
});

test('incomplete searches cannot be suppressed as visible evidence and notices respect tiny budgets', () => {
  assert.equal(evidenceAlreadyVisible({ refs: [1], searchIncomplete: true }, [], []), false);
  for (const maxChars of [1, 4, 20, 100]) {
    const text = incompleteNotice(maxChars);
    assert.ok(Array.from(text).length <= maxChars);
    assert.ok(text.length);
  }
});
