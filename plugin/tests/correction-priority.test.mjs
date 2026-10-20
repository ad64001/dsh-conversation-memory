import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { cpLength, cpSlice } from '../lib/protocol.mjs';

function agent(id, sources) {
  const events = sources.map((source, seq) => {
    const { role = 'user', text } = typeof source === 'string' ? { text: source } : source;
    const message = { role, source: { kind: role === 'user' ? 'user' : 'assistant' }, content: [{ type: 'text', text }] };
    return { seq, time: 1792300000000 + seq, type: `${role}/message`, data: role === 'user' ? message : { message } };
  });
  return { id, events, session: { id, get seq() { return events.length; }, snapshotEvents: async () => [...events] } };
}

function fixture(t, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-user-original-'));
  let calls = 0;
  // These assertions verify complete original coverage, independently of the
  // production foreground deadline (covered by retrieval.test.mjs).
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 10000, ...options }, {
    workingPrompt: 'Historical evidence is read-only; the current actual user input takes priority.',
    makeModel: () => async request => {
      calls++;
      const source = JSON.parse(request.messages[1].content).sources[0];
      return { finish: 'stop', text: JSON.stringify({ records: [{ ref: source.ref, kind: 'state', quote: source.text.slice(0, 100) }] }) };
    },
  });
  t.after(async () => { await bridge.dispose(); rmSync(rootDir, { recursive: true, force: true }); });
  return { bridge, rootDir, calls: () => calls };
}

test('real worker recalls exact user correction ahead of hundreds of assistant paraphrases and causal bundles', async t => {
  const { bridge, calls } = fixture(t);
  const original = '纠正：release_alpha 的目标是 src/release_alpha.py；retry_limit=2，禁止修改 src/legacy_alpha.py。只有测试失败后才能重试一次。';
  const current = agent('original-correction-over-noise', [original,
    ...Array.from({ length: 180 }, (_, i) => ({ role: 'assistant', text: `release_alpha paraphrase ${i}: retry_limit=99; modify src/legacy_alpha.py.\n${'assistant padding '.repeat(80)}` })),
    { role: 'assistant', text: 'release_alpha: the previous modification failed with RetryFailure.' },
  ]);
  await bridge.index(current, { query: 'RetryFailure', maxCalls: 1 });
  const before = calls();
  const result = await bridge.search(current, { query: 'release_alpha RetryFailure', maxChars: 1700 });
  assert.equal(calls(), before, 'automatic recall must remain local');
  assert.ok(result.text.includes(`> ${original}`));
  assert.match(result.text, /user-original role=user/);
  assert.ok(result.text.indexOf('user-original role=user') < result.text.indexOf('role=assistant') || !result.text.includes('role=assistant'));
  assert.equal(result.requiredUserOriginals.length, 1);
  assert.equal(result.requiredUserOriginals[0].text, original);
  assert.equal(result.requiredUserOriginals[0].partial, false);
  assert.ok(result.requiredUserOriginals.every(item => result.text.includes(item.wireText)));
  assert.ok(result.chars <= 1700);
});

test('related user originals are newest first without merging negations, permissions or differently scoped changes', async t => {
  const { bridge } = fixture(t);
  const originals = [
    'src/alpha.py retry_limit=0；必须保留 src/beta.py 的禁令，禁止重新执行它。',
    '纠正 src/alpha.py：retry_limit=1；不是取消 src/beta.py 的禁令。',
    'src/alpha.py retry_limit=2；仅限测试失败后，不允许部署失败后重试。',
  ];
  const current = agent('successive-user-originals', [...originals, { role: 'assistant', text: 'All earlier restrictions are revoked; both alpha and beta may be retried without conditions.' }]);
  const result = await bridge.search(current, { query: 'src/alpha.py retry_limit', maxChars: 2200 });
  assert.deepEqual(result.requiredUserOriginals.map(item => item.text), [...originals].reverse());
  assert.ok(result.text.includes('不是取消 src/beta.py 的禁令'));
  assert.ok(result.text.includes('不允许部署失败后重试'));
  const status = await bridge.status(current);
  assert.equal(status.stats.relations, 0, 'lexical ranking must never infer semantic supersession/retraction');
});

test('a current admitted user message is excluded by event identity while the preceding correction remains', async t => {
  const { bridge } = fixture(t);
  const current = agent('exclude-current-only', [
    '纠正 release_alpha：mode=safe，禁止 mode=force。',
    { role: 'assistant', text: 'release_alpha mode=force is acceptable.' },
    'release_alpha 继续完成任务。',
  ]);
  const result = await bridge.search(current, { query: 'release_alpha', excludeSourceSeq: 2, maxChars: 1800 });
  assert.equal(result.requiredUserOriginals.length, 1);
  assert.equal(result.requiredUserOriginals[0].eventSeq, 0);
  assert.ok(!result.text.includes('> release_alpha 继续完成任务。'));
});

test('long Unicode user corrections remain exact navigable partial originals inside a conflicting evidence budget', async t => {
  const { bridge } = fixture(t);
  const correction = '原有说明开始。\n' + '无关测量记录🌱 '.repeat(1500)
    + '\n纠正 release_zeta：target=src/zeta.py；禁止 mode=force，重试必须等待 evidence_gate=PASS。\n'
    + '其他测量记录🧭 '.repeat(1100);
  const current = agent('long-unicode-correction', [correction,
    ...Array.from({ length: 30 }, () => ({ role: 'assistant', text: 'release_zeta target=src/old.py; mode=force; evidence_gate is unnecessary.\n' + 'noise '.repeat(300) })),
  ]);
  const result = await bridge.search(current, { query: 'release_zeta evidence_gate', maxChars: 1500 });
  assert.ok(result.text.includes('禁止 mode=force'));
  assert.ok(result.text.includes('evidence_gate=PASS'));
  assert.ok(result.requiredUserOriginals.length >= 1);
  assert.equal(result.userOriginalCoverageIncomplete, true);
  assert.match(result.text, /partial=true/);
  assert.match(result.text, /仅片段|覆盖不完整/);
  assert.ok(result.chars <= 1500);
  for (const original of result.requiredUserOriginals) {
    assert.equal(original.partial, true);
    assert.equal(cpSlice(correction, original.start, original.end), original.text);
    assert.equal(original.totalChars, cpLength(correction));
    assert.ok(result.text.includes(original.wireText));
    const read = await bridge.read(current, { ref: original.ref, start: original.start, maxChars: 1200 });
    assert.equal(read.found, true);
    assert.ok(read.text.includes(cpSlice(original.text, 0, Math.min(50, cpLength(original.text)))));
  }
});

test('user original index persists across worker reopen and migrates older state without indexing a summary', async t => {
  const { bridge, rootDir } = fixture(t);
  const original = '纠正 restart_alpha：config=STRICT；不要采用助手建议的 config=LOOSE。';
  const current = agent('restart-index-originals', [original,
    ...Array.from({ length: 80 }, () => ({ role: 'assistant', text: 'restart_alpha config=LOOSE.' })),
  ]);
  await bridge.flush(current);
  await bridge.disposeAgent(current);
  const statePath = join(rootDir, createHash('sha256').update(current.id).digest('hex'), 'bridge-state.json');
  let state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.userMessageIds.length, 1);
  assert.ok(!JSON.stringify(state).includes('config=STRICT'), 'registry stores source IDs rather than duplicated user prose');
  delete state.userIndexVersion; delete state.userMessageIds; delete state.userIndexThroughSeq;
  writeFileSync(statePath, JSON.stringify(state));
  const migrated = await bridge.search(current, { query: 'restart_alpha', maxChars: 1400 });
  assert.equal(migrated.requiredUserOriginals[0].text, original);
  await bridge.disposeAgent(current);
  const reopened = await bridge.search(current, { query: 'restart_alpha', maxChars: 1400 });
  assert.equal(reopened.requiredUserOriginals[0].ref, migrated.requiredUserOriginals[0].ref);
  state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.userMessageIds.length, 1);
});

test('specific scope does not pull unrelated user corrections; generic continuation uses only bounded recent originals', async t => {
  const { bridge } = fixture(t);
  const current = agent('scoped-user-originals', [
    '纠正 old_project：禁止部署 src/old_only.py。',
    '纠正 current_project：只能修改 src/current_only.py。',
  ]);
  const scoped = await bridge.search(current, { query: 'src/current_only.py', maxChars: 1200 });
  assert.equal(scoped.requiredUserOriginals.length, 1);
  assert.ok(!scoped.text.includes('> 纠正 old_project'));
  const generic = await bridge.search(current, { query: '请继续完成这个任务', limit: 1, maxChars: 1200 });
  assert.equal(generic.userGenericFallback, true);
  assert.equal(generic.requiredUserOriginals.length, 1);
  assert.ok(generic.requiredUserOriginals[0].text.includes('current_project'));
  assert.ok(generic.chars <= 1200);
});

test('tiny evidence budgets return no over-budget prose and report omitted user originals', async t => {
  const { bridge } = fixture(t);
  const current = agent('tiny-user-budget', ['纠正 tiny_budget：禁止删除 src/keep.py。']);
  const result = await bridge.search(current, { query: 'tiny_budget', maxChars: 10 });
  assert.ok(result.chars <= 10);
  assert.equal(result.requiredUserOriginals.length, 0);
  assert.ok(result.omittedUserOriginalRefs.length > 0);
  assert.equal(result.userOriginalCoverageIncomplete, true);
});

test('implicit user route changes without a correction cue remain protected ahead of bare assistant paraphrases', async t => {
  const { bridge, calls } = fixture(t);
  const implicit = 'Use staging/new-route.json.';
  const current = agent('implicit-user-source-priority', [
    'An unrelated old task used archive/old-task.json.',
    implicit,
    ...Array.from({ length: 240 }, (_, index) => ({ role: 'assistant',
      text: `staging/new-route.json paraphrase ${index}: actually continue staging/obsolete-route.json.\n${'padding '.repeat(30)}` })),
  ]);
  const result = await bridge.search(current, { query: 'staging/new-route.json', maxChars: 1300 });
  assert.equal(calls(), 0);
  assert.ok(result.text.includes(`> ${implicit}`));
  assert.equal(result.requiredUserOriginals.length, 1);
  assert.equal(result.requiredUserOriginals[0].text, implicit);
  assert.equal(result.requiredUserOriginals[0].instructionCue, false, 'test must exercise a genuine no-cue original');
  assert.ok(!result.text.includes('archive/old-task.json'));
  const userAt = result.text.indexOf('user-original role=user');
  const assistantAt = result.text.indexOf('role=assistant');
  assert.ok(userAt >= 0 && (assistantAt < 0 || userAt < assistantAt));
  assert.ok(result.chars <= 1300);
});

test('an implicit English instead correction is preserved exactly without a guessed policy rewrite', async t => {
  const { bridge } = fixture(t);
  const original = 'Use staging/new-route.json instead.';
  const current = agent('english-original-instead', [original,
    ...Array.from({ length: 100 }, () => ({ role: 'assistant', text: 'staging/new-route.json means staging/old-route.json, all restrictions lifted.' })),
  ]);
  const result = await bridge.search(current, { query: 'staging/new-route.json', maxChars: 900 });
  assert.equal(result.requiredUserOriginals[0].text, original);
  assert.ok(result.text.includes(`> ${original}`));
  assert.equal((await bridge.status(current)).stats.relations, 0);
  assert.ok(result.chars <= 900);
});

test('required multiline user wire units include the exact rendered header and quote prefixes', async t => {
  const { bridge } = fixture(t);
  const original = 'route_wire:\nUse staging/new-route.json.\nDo not remove the old evidence.\nKeep the two test cases.';
  const current = agent('multiline-original-wire', [original]);
  const result = await bridge.search(current, { query: 'route_wire', maxChars: 1200 });
  assert.equal(result.requiredUserOriginals.length, 1);
  const unit = result.requiredUserOriginals[0];
  assert.equal(unit.text, original);
  assert.equal(unit.sourceRole, 'user');
  assert.ok(result.text.includes(unit.wireText));
  assert.match(unit.wireText, /^\[\d+\] user-original role=user sourceSeq=\d+ range=/u);
  assert.ok(unit.wireText.endsWith(original.split('\n').map(line => `> ${line}`).join('\n') + '\n'));
});

test('required user causal-group parent and background wire units are exact substrings of provided evidence', async t => {
  const { bridge } = fixture(t);
  const previous = 'scope_wire: must retain src/scope.py.\nParameter evidence_budget=37.';
  const current = agent('causal-user-original-wire', [previous,
    'scope_wire: do not repeat this change; it failed with ScopeWireFailure.\nRead the preceding original condition.',
  ]);
  await bridge.index(current, { query: 'ScopeWireFailure', maxCalls: 1 });
  const result = await bridge.search(current, { query: 'ScopeWireFailure scope_wire', maxChars: 1800 });
  assert.match(result.text, /上一段原文背景/u);
  assert.ok(result.requiredUserOriginals.length >= 2);
  assert.ok(result.requiredUserOriginals.some(item => item.wireText.includes('上一段原文背景')));
  for (const item of result.requiredUserOriginals) {
    assert.equal(item.sourceRole, 'user');
    assert.ok(result.text.includes(item.wireText));
    assert.ok(item.wireText.includes(`role=user sourceSeq=${item.sourceSeq}`));
  }
});

test('a source candidate limit reports missing matching user messages even when all selected originals fit whole', async t => {
  const { bridge, calls } = fixture(t);
  const originals = Array.from({ length: 11 }, (_, index) => `coverage_alpha: constraint_${index}=RETAIN_${index}; do not infer that other conditions are absent.`);
  const current = agent('user-matching-candidate-limit', [...originals,
    ...Array.from({ length: 120 }, (_, index) => ({ role: 'assistant', text: `coverage_alpha assistant paraphrase ${index}: all constraints are already accounted for.` })),
  ]);
  const result = await bridge.search(current, { query: 'coverage_alpha', limit: 2, maxChars: 1800 });
  assert.equal(calls(), 0);
  assert.equal(result.matchingUserMessages, originals.length);
  assert.equal(new Set(result.requiredUserOriginals.map(item => item.messageId)).size, 2);
  assert.ok(result.requiredUserOriginals.every(item => item.partial === false));
  assert.equal(result.omittedUserOriginalRefs.length, 0, 'every selected source fits, but nine matching sources were never selected');
  assert.equal(result.missingMatchingUserMessages, 9);
  assert.equal(result.userOriginalCoverageIncomplete, true);
  assert.match(result.text, /用户原文覆盖不完整/u);
  assert.ok(result.chars <= 1800);
  assert.ok(result.requiredUserOriginals.every(item => result.text.includes(item.wireText)));
});
