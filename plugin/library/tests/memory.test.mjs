import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationMemory, BudgetExceededError } from '../lib/index.mjs';

function fixture(t, model) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'conversation-facade-'));
  const memory = new ConversationMemory({ rootDir, conversationId: 'conversation-A', model });
  t.after(() => { memory.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { memory, rootDir };
}
const response = data => ({ text: JSON.stringify(data), finish: 'stop' });
const fullRef = (memory, message) => memory.cite({ messageId: message.id, start: 0, end: Array.from(message.text).length }).ref;

test('exact Unicode evidence, stable references after reopen, immutable conversation binding', t => {
  const { memory, rootDir } = fixture(t);
  const message = memory.append({ role: 'user', text: '🧭回滚标识=RT-551；只读检查。', sourceKey: 'source-1' });
  const ref = memory.cite({ messageId: message.id, start: 1, end: 15 }).ref;
  assert.equal(memory.read(ref).text, Array.from(message.text).slice(1, 15).join(''));
  assert.throws(() => { memory.conversationId = 'conversation-B'; }, TypeError);
  memory.close();
  const reopened = new ConversationMemory({ rootDir, conversationId: 'conversation-A' });
  assert.equal(reopened.read(ref).messageId, message.id);
  assert.equal(reopened.cite({ messageId: message.id, start: 1, end: 15 }).ref, ref);
  reopened.close();
});

test('organizer can index only unique exact quotes and cannot pin them', async t => {
  const { memory } = fixture(t, async request => {
    assert.equal(request.purpose, 'memory-index');
    const { sources } = JSON.parse(request.messages[1].content);
    return response({ records: [{ ref: sources[0].ref, kind: 'constraint', quote: '只读检查，不运行迁移。', key: '迁移' }] });
  });
  const source = memory.append({ role: 'user', text: '🧭当前约束：只读检查，不运行迁移。下一步先检查版本。' });
  const indexed = await memory.indexMessages({ messageIds: [source.id] });
  assert.equal(indexed.added.length, 1);
  assert.equal(indexed.pending.length, 0);
  const record = memory.store.getMemory(indexed.added[0]);
  assert.equal(record.text, '只读检查，不运行迁移。');
  assert.equal(record.origin, 'model');
  assert.equal(record.pinned, false);
  assert.equal(record.start, 6);
  const confirmed = memory.confirm(record.ref);
  assert.equal(confirmed.origin, 'manual');
  assert.equal(confirmed.pinned, true);
  const replay = await memory.indexMessages({ messageIds: [source.id] });
  assert.deepEqual(replay.existing, [record.ref]);
  assert.equal(memory.store.getMemory(record.ref).origin, 'manual');
});

for (const [name, invalid] of [
  ['hallucinated quote', ref => ({ records: [{ ref, kind: 'fact', quote: '此句并不存在。' }] })],
  ['unknown ref', ref => ({ records: [{ ref: ref + 1000, kind: 'fact', quote: '唯一事实。' }] })],
  ['nonunique quote', ref => ({ records: [{ ref, kind: 'fact', quote: '重复' }] })],
  ['injected authority field', ref => ({ records: [{ ref, kind: 'constraint', quote: '唯一事实。', pinned: true }] })],
  ['invalid kind', ref => ({ records: [{ ref, kind: 'permission', quote: '唯一事实。' }] })],
  ['invalid second record rolls back proposal batch', ref => ({ records: [
    { ref, kind: 'fact', quote: '唯一事实。' }, { ref, kind: 'fact', quote: '虚构内容' },
  ] })],
]) test(`reject ${name}; raw evidence remains retrievable`, async t => {
  const { memory } = fixture(t, async request => invalidResponse(request));
  function invalidResponse(request) { return response(invalid(JSON.parse(request.messages[1].content).sources[0].ref)); }
  const source = memory.append({ role: 'tool', text: '唯一事实。重复；重复。' });
  const result = await memory.indexMessages({ messageIds: [source.id] });
  assert.equal(result.rejected.length, 1);
  assert.equal(result.pending.length, 1);
  assert.equal(memory.stats().memories, 0);
  assert.equal(memory.read(result.sourceRefs[0]).text, source.text);
});

test('partial model output is rejected; bounded indexing exposes pending spans', async t => {
  const { memory } = fixture(t, async () => ({ text: '{"records":[]}', finish: 'max-tokens' }));
  const source = memory.append({ role: 'assistant', text: 'x'.repeat(1100) });
  const first = await memory.indexMessages({ messageIds: [source.id], maxCalls: 1, maxChunkChars: 512 });
  assert.equal(first.calls, 1);
  assert.equal(first.pending.length, 3);
  memory.model = async () => response({ records: [] });
  const second = await memory.indexMessages({ messageIds: [source.id], maxCalls: 2, maxChunkChars: 512 });
  assert.equal(second.calls, 2);
  assert.deepEqual(second.pending, [{ messageId: source.id, start: 1024, end: 1100 }]);
  const third = await memory.indexMessages({ messageIds: [source.id], startOffsets: { [source.id]: 1024 }, maxChunkChars: 512 });
  assert.equal(third.calls, 1);
  assert.equal(third.pending.length, 0);
});

test('invalid rerank refs fall back; empty valid selection omits unrelated candidates', async t => {
  const { memory } = fixture(t, async () => response({ refs: [999999] }));
  memory.append({ role: 'tool', text: 'rollback_ticket=OLD-123；演练失败。' });
  const result = await memory.recall({ query: 'rollback_ticket' });
  assert.equal(result.status, 'local-fallback');
  assert.ok(result.records.length);
  assert.equal(result.records[0].sourceRole, 'tool');
  memory.model = async () => response({ refs: [] });
  assert.equal((await memory.recall({ query: 'rollback_ticket' })).records.length, 0);
});

test('pins cannot be silently lost under a small working context budget', async t => {
  const { memory } = fixture(t);
  const source = memory.append({ role: 'user', text: '只读诊断，暂不执行变更。' });
  const ref = fullRef(memory, source);
  memory.remember({ ref, kind: 'constraint', origin: 'user', pinned: true });
  await assert.rejects(memory.buildContext({ currentTask: '检查', pinRefs: [ref], maxChars: 25 }), BudgetExceededError);
  const context = await memory.buildContext({ currentTask: '检查', pinRefs: [ref], maxChars: 2000 });
  assert.ok(context.text.includes(`[${ref}]`));
  assert.ok(context.text.includes(source.text));
  assert.ok(context.chars <= 2000);
  assert.equal(context.citations[0].sourceRole, 'user');
});

test('explicit correction retires old record and survives re-indexing of old evidence', async t => {
  const { memory } = fixture(t);
  const old = memory.append({ role: 'user', text: '预算为100。' });
  const oldRef = fullRef(memory, old);
  memory.remember({ ref: oldRef, kind: 'constraint', origin: 'user', pinned: true });
  const corrected = memory.append({ role: 'user', text: '纠正：预算改为60。' });
  const newRef = fullRef(memory, corrected);
  memory.remember({ ref: newRef, kind: 'correction', origin: 'user', pinned: true });
  memory.supersede(oldRef, newRef);
  const context = await memory.buildContext({ query: '预算', currentTask: '核对预算', useModel: false });
  assert.ok(context.usedRefs.includes(newRef));
  assert.ok(!context.usedRefs.includes(oldRef));
  assert.equal(memory.read(oldRef).text, old.text);
  assert.throws(() => memory.supersede(newRef, oldRef));
});

test('failure applicability is scoped and resolved failures do not block future reviews', t => {
  const { memory } = fixture(t);
  const source = memory.append({ role: 'tool', text: '迁移在schema=2和driver=1时失败，返回E-49；根因未确认。' });
  const ref = fullRef(memory, source);
  memory.recordFailure({ ref, actionKey: 'migrate', scope: { schema: 2, driver: 1 } });
  assert.equal(memory.checkAction({ actionKey: 'migrate', scope: { driver: 1, schema: 2 } }).reviewRequired, true);
  const changed = memory.checkAction({ actionKey: 'migrate', scope: { schema: 3, driver: 1 } });
  assert.equal(changed.reviewRequired, false);
  assert.equal(changed.otherConditions.length, 1);
  memory.resolve(ref);
  assert.equal(memory.checkAction({ actionKey: 'migrate', scope: { schema: 2, driver: 1 } }).reviewRequired, false);
  const unknown = memory.append({ role: 'tool', text: '迁移曾失败，条件尚未记录。' });
  memory.recordFailure({ ref: fullRef(memory, unknown), actionKey: 'migrate' });
  const needsReview = memory.checkAction({ actionKey: 'migrate', scope: { schema: 2, driver: 1 } });
  assert.equal(needsReview.reviewRequired, true);
  assert.equal(needsReview.unknownConditions.length, 1);
});

test('citation validator detects unknown/unread refs and does not claim entailment', t => {
  const { memory } = fixture(t);
  const source = memory.append({ role: 'assistant', text: '助手曾声称成功，尚待外部核验。' });
  const ref = fullRef(memory, source);
  assert.equal(memory.checkCitations(`已经成功[${ref}]`).valid, false);
  const known = memory.checkCitations(`之前的助手声称成功[${ref}]`, { allowedRefs: [ref] });
  assert.equal(known.valid, true);
  assert.equal(known.semanticEntailmentChecked, false);
  assert.deepEqual(memory.checkCitations('[999999]', { allowedRefs: [999999] }).unknown, [999999]);
});

test('citation expansion returns surrounding conditions and a navigable bounded source span', t => {
  const { memory } = fixture(t);
  const source = memory.append({ role: 'tool', text: '条件：仅适用于driver=1。' + '背景。'.repeat(200) + '失败码E42。' + '后续尚未验证。'.repeat(100) });
  const chars = Array.from(source.text);
  const start = Array.from(source.text.slice(0, source.text.indexOf('失败码'))).length;
  const ref = memory.cite({ messageId: source.id, start, end: start + 7 }).ref;
  const first = memory.readSource(ref, { start: 0, maxChars: 300 });
  assert.equal(first.requestedRef, ref);
  assert.equal(first.text, chars.slice(0, 300).join(''));
  assert.equal(first.nextStart, 300);
  assert.equal(first.hasMore, true);
  assert.ok(first.text.includes('driver=1'));
  const next = memory.readSource(ref, { start: first.nextStart, maxChars: 8192 });
  assert.equal(next.text, chars.slice(300).join(''));
  assert.equal(next.hasMore, false);
  assert.equal(next.nextStart, null);
  assert.equal(memory.read(next.ref).text, next.text);
  assert.equal(memory.readSource(999999), null);
  const tiny = memory.readSource(ref, { maxChars: 10 });
  assert.ok(tiny.start <= start && tiny.end > start);
  assert.ok(Array.from(tiny.text).length <= 10);
});

test('a specific historical lookup returns middle evidence without replaying full history', async t => {
  const { memory } = fixture(t);
  for (let i = 0; i < 120; i++) memory.append({ role: 'tool', text: `无关运行日志${i}：` + '重复状态正常。'.repeat(40) });
  const source = memory.append({ role: 'user', text: '生产恢复必须使用rollback_ticket=R9-Z52，不能使用演练票据。' });
  for (let i = 120; i < 240; i++) memory.append({ role: 'tool', text: `无关运行日志${i}：` + '重复状态正常。'.repeat(40) });
  const context = await memory.buildContext({ query: 'rollback_ticket', currentTask: '查生产恢复票据', maxChars: 1800, useModel: false });
  assert.ok(context.text.includes('R9-Z52'));
  assert.ok(context.chars <= 1800);
  assert.equal(context.citations.length, 1);
  assert.equal(context.citations[0].messageId, source.id);
  assert.equal(memory.stats().messages, 241);
});
