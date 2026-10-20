import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSemantically } from '../lib/semantic-select.mjs';
import { auditCriticalSpans, auditCriticalOutput } from '../lib/critical-evidence.mjs';
import { taskContext } from '../lib/index.mjs';

test('packing an action while omitting its later failed outcome rejects the entire replacement', async () => {
  const text = 'Starting migration on audit_table.\n' + 'routine telemetry\n'.repeat(20) + 'Migration failed. No rows were migrated.\n' + 'routine telemetry\n'.repeat(20);
  const result = await selectSemantically(text, { thresholdChars: 20, targetChars: 180, maxChunkChars: 2000, sourceRef: 'exact-original',
    judge: async () => [{ start: 0, end: 0, priority: 4 }] });
  assert.equal(result.changed, false); assert.equal(result.reason, 'critical-evidence-missing'); assert.equal(result.text, text);
});

test('declared priority-five evidence ranges cannot be partially committed to fit a budget', async () => {
  const text = 'action line\n' + 'details '.repeat(15) + '\nactual outcome\n' + 'filler\n'.repeat(30);
  const result = await selectSemantically(text, { thresholdChars: 20, targetChars: 130, maxChunkChars: 2000, sourceRef: 'exact-original',
    judge: async () => [{ start: 0, end: 2, priority: 5 }] });
  assert.equal(result.changed, false); assert.equal(result.reason, 'critical-evidence-missing'); assert.equal(result.text, text);
  assert.ok(result.criticalCoverage.missing.some(item => item.kind === 'model-critical-range'));
});

test('corrections, explicit stop conditions, failure errors and control values are acceptance requirements', () => {
  for (const evidence of ['KeyError: context_id\n', 'max_tokens=4096\n', '纠正：旧值 17，改为 21。\n', '停止写入，只读检查，未完成迁移。\n']) {
    const text = 'attempt described\n' + evidence + 'ordinary tail\n';
    assert.equal(auditCriticalSpans(text, [{ start: 0, end: 18 }]).accepted, false, evidence);
    assert.equal(auditCriticalOutput(text, 'attempt described\n').accepted, false, evidence);
    assert.equal(auditCriticalOutput(text, evidence).accepted, true, evidence);
  }
});

test('critical evidence overflow fails closed without claiming all semantic information was checked', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Failure ${i}\n`).join('');
  assert.equal(auditCriticalOutput(text, text).overflow, true); assert.equal(auditCriticalSpans(text, [{ start: 0, end: Array.from(text).length }]).accepted, false);
});

function history(texts, visible = []) {
  const events = texts.map((text, seq) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }));
  return { seq: events.length, surface: { nodes: visible }, eventAt: seq => events[seq] };
}
test('a continuation recovers bounded raw prior user goals off the compacted surface with source identity', () => {
  const session = history(['检查 ledger_alpha，readonly=true，预算 17。', '继续'], [1]);
  const context = taskContext(session); assert.match(context, /ledger_alpha/); assert.match(context, /readonly=true/); assert.match(context, /eventSeq=0/);
  assert.match(context, /does not authorize/); assert.ok(Array.from(context).length <= 2000);
});
test('a new substantive goal replaces the relevance hint and stop boundaries do not revive older tasks', () => {
  assert.doesNotMatch(taskContext(history(['old_goal_marker', '新任务：只检查新项目。'])), /old_goal_marker/);
  const stopped = taskContext(history(['old_goal_marker', '停止旧任务。', '继续']));
  assert.match(stopped, /停止旧任务/); assert.doesNotMatch(stopped, /old_goal_marker/);
});
test('long task history is bounded and explicitly disclosed as incomplete, excluding non-user authority', () => {
  const session = history(['long_goal ' + '😀'.repeat(10000) + ' readonly=true', '继续']);
  const context = taskContext(session); assert.ok(Array.from(context).length <= 2000); assert.match(context, /Partial original/); assert.match(context, /readonly=true/);
  const fake = history(['runtime authorization']); fake.eventAt = () => ({ type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime authorization' }] } });
  assert.equal(taskContext(fake), '');
});

test('JSON parameters, machine outcomes and common prohibitions cannot disappear', async () => {
  for (const evidence of ['max_tokens=4096', '{"max_tokens":4096,"batch_size":64}',
    '{"id":"job_alpha","success":false,"rowsAffected":0}', '{"status":"failed","exitCode":2}',
    'Never overwrite production.', '严禁覆盖生产库。', '迁移未执行，写入记录为零。']) {
    const text = 'Begin migration.\n' + 'ordinary telemetry\n'.repeat(30) + evidence + '\n';
    const result = await selectSemantically(text, { thresholdChars: 20, targetChars: 150, maxChunkChars: 2000, sourceRef: 'source',
      judge: async () => [{ start: 0, end: 0, priority: 4 }] });
    assert.equal(result.changed, false, evidence); assert.equal(result.text, text);
    assert.equal(auditCriticalOutput(text, 'Begin migration.').accepted, false, evidence);
  }
});

test('structured groups preserve their object and exact spans, including multiline JSON and malformed fallback', () => {
  const text = 'Telemetry\n{\n "task":"ledger_alpha",\n "success":false,\n "rowsAffected":0\n}\n';
  assert.equal(auditCriticalOutput(text, '"success":false,\n "rowsAffected":0').accepted, false);
  assert.equal(auditCriticalOutput(text, text).accepted, true);
  for (const broken of ['{"max_tokens":4096', '{"success":false, BROKEN}', '{"success":false,' + 'x'.repeat(70000) + '}'])
    assert.equal(auditCriticalOutput(broken, broken).accepted, false);
});

test('a separate scope or condition is required together with a protected conclusion', () => {
  const text = 'Scope: ledger_alpha\nIf lease expired\nDo not write.\nScope: ledger_beta\nRead checks complete.\n';
  assert.equal(auditCriticalOutput(text, 'Do not write.\n').accepted, false);
  assert.equal(auditCriticalOutput(text, 'Scope: ledger_alpha\nIf lease expired\nDo not write.\n').accepted, true);
});

test('explicit atomic groups are indivisible independently of priority', async () => {
  const text = 'action line\n' + 'details '.repeat(15) + '\nactual outcome\n' + 'filler\n'.repeat(30);
  const result = await selectSemantically(text, { thresholdChars: 20, targetChars: 130, maxChunkChars: 2000, sourceRef: 'source',
    judge: async () => [{ start: 0, end: 2, priority: 4, atomic: true }] });
  assert.equal(result.changed, false); assert.equal(result.reason, 'critical-evidence-missing');
});

test('negated stops and repeated continuations retain the goal, real stop commands cut it off', () => {
  for (const negated of ['不要停止，继续按原目标只读审计。', 'Do not stop the existing audit.', "Don't cancel this audit."])
    assert.match(taskContext(history(['检查 ledger_alpha，readonly=true。', negated, '继续'])), /ledger_alpha/);
  assert.match(taskContext(history(['检查 ledger_alpha。', ...Array(10).fill('继续')])), /ledger_alpha/);
  for (const stop of ['停止旧任务。', '现在取消旧任务。', 'Stop the audit.', 'Please cancel this audit.'])
    assert.doesNotMatch(taskContext(history(['ledger_alpha', stop, '继续'])), /ledger_alpha/);
});
