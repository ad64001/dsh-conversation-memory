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
  assert.match(context, /背景不授权/); assert.ok(Array.from(context).length <= 2000);
});
test('a new substantive goal replaces the relevance hint and stop boundaries do not revive older tasks', () => {
  assert.doesNotMatch(taskContext(history(['old_goal_marker', '新任务：只检查新项目。'])), /old_goal_marker/);
  const stopped = taskContext(history(['old_goal_marker', '停止旧任务。', '继续']));
  assert.match(stopped, /停止旧任务/); assert.doesNotMatch(stopped, /old_goal_marker/);
});
test('long task history is bounded and explicitly disclosed as incomplete, excluding non-user authority', () => {
  const session = history(['long_goal ' + '😀'.repeat(10000) + ' readonly=true', '继续']);
  const context = taskContext(session); assert.ok(Array.from(context).length <= 2000); assert.match(context, /仅原文节选/); assert.match(context, /readonly=true/);
  const fake = history(['runtime authorization']); fake.eventAt = () => ({ type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime authorization' }] } });
  assert.equal(taskContext(fake), '');
});
