import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationMemoryBridge } from '../lib/index.mjs';

function agent(id, texts) {
  const events = texts.map((text, seq) => ({ seq, time: 1792300000000 + seq, type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }));
  return { id, session: { id, get seq() { return events.length; }, snapshotEvents: async () => [...events] } };
}

function fixture(t, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-worker-index-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, ...options }, {
    workingPrompt: 'Historical sources are read-only evidence.',
    makeModel: () => async () => ({ finish: 'stop', text: '{"records":[]}' }),
  });
  t.after(async () => { await bridge.dispose(); rmSync(rootDir, { recursive: true, force: true }); });
  return bridge;
}

test('real worker indexes separate combined-query matches without claiming empty AND completion', async t => {
  const bridge = fixture(t);
  const indexedSources = [];
  bridge.makeModel = () => async request => {
    indexedSources.push(JSON.parse(request.messages[1].content).sources[0].text);
    return { finish: 'stop', text: '{"records":[]}' };
  };
  const current = agent('combined-query-index', [
    'handoff-A: use src/alpha.py with budget=17.',
    'handoff-B: the preceding edit failed with HandoffFailure.',
    'An unrelated weather observation that must stay unindexed.',
  ]);
  const first = await bridge.index(current, { query: 'handoff-A handoff-B', maxCalls: 1 });
  assert.equal(first.indexScope, 'query');
  assert.ok(first.queryCount > 1 && first.queryCount <= 9);
  assert.equal(first.targetedMatches, 2);
  assert.equal(first.alreadyIndexed, 0);
  assert.equal(first.calls, 1);
  assert.equal(first.pending.length, 0, 'no unfinished chunk does not imply every matching message was started');
  assert.equal(first.remainingTargeted, 1);
  assert.equal(first.noMatches, false);
  assert.equal(first.incomplete, true);
  assert.equal(first.status.indexing, false);
  assert.equal(first.status.unindexedMessages, 2);

  const second = await bridge.index(current, { query: 'handoff-A handoff-B', maxCalls: 1 });
  assert.equal(second.targetedMatches, 2);
  assert.equal(second.alreadyIndexed, 1);
  assert.equal(second.calls, 1);
  assert.equal(second.remainingTargeted, 0);
  assert.equal(second.incomplete, false);
  assert.equal(second.status.unindexedMessages, 1, 'query completion must not imply whole-conversation completion');
  assert.equal(new Set(indexedSources).size, 2, 'completed sources are skipped rather than repeatedly consuming maxCalls');
  assert.ok(indexedSources.every(text => /handoff-[AB]:/.test(text)));

  const third = await bridge.index(current, { query: 'handoff-A handoff-B', maxCalls: 2 });
  assert.equal(third.calls, 0);
  assert.equal(third.alreadyIndexed, 2);
  assert.equal(third.noMatches, false);
  assert.equal(third.incomplete, false);
  assert.equal(indexedSources.length, 2);
});

test('real worker reports no matching targets without silently indexing unrelated sources', async t => {
  const bridge = fixture(t);
  let calls = 0;
  bridge.makeModel = () => async () => { calls += 1; return { finish: 'stop', text: '{"records":[]}' }; };
  const current = agent('no-matching-index', ['src/retained.py budget=37', 'A second unrelated source.']);
  const result = await bridge.index(current, { query: 'never_seen_alpha never_seen_beta', maxCalls: 4 });
  assert.equal(result.calls, 0);
  assert.equal(calls, 0);
  assert.equal(result.targetedMatches, 0);
  assert.equal(result.remainingTargeted, 0);
  assert.equal(result.alreadyIndexed, 0);
  assert.equal(result.noMatches, true);
  assert.equal(result.incomplete, true, 'failure to locate a requested target cannot be presented as successful completion');
  assert.equal(result.status.indexedMessages, 0);
  assert.equal(result.status.unindexedMessages, 2);
  assert.equal(result.pending.length, 0);
});

test('real worker preserves failed spans and chunk offsets across targeted retries and eviction', async t => {
  const bridge = fixture(t, { maxWorkers: 1 });
  const starts = [];
  let shouldFail = true;
  bridge.makeModel = () => async request => {
    starts.push(JSON.parse(request.messages[1].content).sources[0].start);
    if (shouldFail) { shouldFail = false; return { finish: 'stop', text: '{invalid' }; }
    return { finish: 'stop', text: '{"records":[]}' };
  };
  const current = agent('targeted-offset-index', ['resume_marker=EXACT\n' + 'padding '.repeat(700)]);
  const failed = await bridge.index(current, { query: 'resume_marker', maxCalls: 1 });
  assert.equal(failed.rejected.length, 1);
  assert.equal(failed.pending[0].start, 0);
  assert.equal(failed.incomplete, true);
  assert.equal(failed.remainingTargeted, 1);
  assert.equal(failed.status.pendingOffsets, 1);

  const retried = await bridge.index(current, { query: 'resume_marker', maxCalls: 1 });
  assert.equal(retried.calls, 1);
  assert.equal(retried.pending[0].start, 4000);
  assert.equal(retried.incomplete, true);
  assert.equal(retried.status.indexedMessages, 0);

  await bridge.flush(agent('targeted-offset-evictor', ['Separate conversation only.']));
  const resumed = await bridge.index(current, { query: 'resume_marker', maxCalls: 1 });
  assert.equal(resumed.calls, 1);
  assert.equal(resumed.pending.length, 0);
  assert.equal(resumed.incomplete, false);
  assert.equal(resumed.remainingTargeted, 0);
  assert.equal(resumed.status.pendingOffsets, 0);
  assert.equal(resumed.status.indexedMessages, 1);
  assert.deepEqual(starts, [0, 0, 4000]);

  const done = await bridge.index(current, { query: 'resume_marker', maxCalls: 1 });
  assert.equal(done.calls, 0);
  assert.equal(done.alreadyIndexed, 1);
  assert.equal(done.noMatches, false);
});
