import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../lib/sqlite-store.mjs';

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
function setup(t, conversationId = 'synthetic-conversation') {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'));
  const stores = [];
  const open = (id = conversationId) => {
    const store = new ConversationStore({ rootDir, conversationId: id });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    const resolved = fs.realpathSync(rootDir);
    const intendedParent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), intendedParent);
    assert.ok(path.basename(resolved).startsWith('dsh-memory-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { rootDir, open, store: open() };
}
const add = (store, text, sourceKey = undefined) => store.append({ role: 'user', text, sourceKey });
const remember = (store, message, options = {}) => store.addMemory({
  kind: 'fact', messageId: message.id, start: 0, end: Array.from(message.text).length, ...options,
});

test('additive tool provenance is idempotent, append-only and cannot promote a source role', t => {
  const { store } = setup(t);
  const action = store.append({ role: 'assistant', text: 'actual arguments', metadata: { seq: 4 } });
  const outcome = store.append({ role: 'tool', text: 'Done', metadata: { seq: 5 } });
  const first = { messageId: action.id, callId: 'same-call', callEventSeq: 4, eventSeq: 4, kind: 'tool-call', toolName: 'terminal' };
  store.linkToolEvent(first); assert.deepEqual({ ...store.linkToolEvent(first) }, first);
  store.linkToolEvent({ ...first, messageId: outcome.id, eventSeq: 5, kind: 'tool-result' });
  assert.equal(store.relatedToolEvents(action.id)[0].messageId, outcome.id);
  assert.throws(() => store.linkToolEvent({ ...first, toolName: 'other' }), /conflict/);
  assert.throws(() => store.linkToolEvent({ ...first, messageId: outcome.id, eventSeq: 5 }), /Invalid tool provenance/);
  const db = new DatabaseSync(store.dbPath);
  try { assert.throws(() => db.exec('DELETE FROM tool_events'), /append-only/); } finally { db.close(); }
  assert.equal(store.getMessage(outcome.id).text, 'Done');
});

test('physical directories use SHA256 and isolate arbitrary conversation identifiers', t => {
  const { rootDir, store, open } = setup(t, '../../other:会话😀');
  assert.equal(path.basename(store.directory), digest('../../other:会话😀'));
  assert.equal(path.dirname(store.directory), path.resolve(rootDir));
  const other = open('different-conversation');
  add(store, 'secret only in conversation A', 'same-source-key');
  add(other, 'different conversation B', 'same-source-key');
  assert.equal(other.search('secret').length, 0);
  assert.equal(store.search('different').length, 0);
  assert.notEqual(store.dbPath, other.dbPath);
});

test('message append is ordered, immutable and sourceKey replay is idempotent', t => {
  const { store } = setup(t);
  const first = store.append({ id: 'm1', sourceKey: 'event-1', role: 'tool', text: 'exact value=7', metadata: { seq: 9 } });
  const repeated = store.append({ sourceKey: 'event-1', role: 'tool', text: 'exact value=7', metadata: { ignored: true } });
  assert.deepEqual(repeated, first);
  assert.throws(() => store.append({ sourceKey: 'event-1', role: 'tool', text: 'exact value=8' }), /sourceKey conflict/);
  assert.throws(() => store.append({ sourceKey: 'event-1', role: 'user', text: 'exact value=7' }), /sourceKey conflict/);
  const second = add(store, 'second');
  assert.ok(second.seq > first.seq);
  assert.deepEqual(store.listMessages().map(row => row.id), [first.id, second.id]);
  assert.deepEqual(store.listMessages({ afterSeq: first.seq }).map(row => row.id), [second.id]);
  assert.deepEqual(store.recentMessages({ limit: 1 }).map(row => row.id), [second.id]);
  assert.equal(store.stats().messages, 2);
});

test('failed message transaction creates neither a partial message nor index rows', t => {
  const { store } = setup(t);
  store.append({ id: 'fixed-id', sourceKey: 'a', role: 'user', text: 'original' });
  const before = store.stats();
  assert.throws(() => store.append({ id: 'fixed-id', sourceKey: 'b', role: 'user', text: 'never indexed' }));
  assert.equal(store.stats().messages, before.messages);
  assert.equal(store.stats().chunks, before.chunks);
  assert.equal(store.search('never indexed').length, 0);
});

test('chunks and citations use Unicode code points and preserve supplementary characters', t => {
  const { store } = setup(t);
  const message = add(store, 'A'.repeat(2047) + '😀Z');
  assert.equal(store.stats().chunks, 2);
  const citation = store.cite({ messageId: message.id, start: 2047, end: 2048 });
  assert.equal(citation.text, '😀');
  assert.equal(citation.hash, digest('😀'));
  assert.equal(store.getMessage(message.id).text, message.text);
  assert.throws(() => add(store, 'invalid\uD800'), /well-formed/);
});

test('citation numbers are stable across repeated cite and reopen, with exact evidence hashes', t => {
  const h = setup(t);
  const message = add(h.store, 'prefix exact-command --value=42 suffix');
  const first = h.store.cite({ messageId: message.id, start: 7, end: 31 });
  assert.equal(h.store.cite({ messageId: message.id, start: 7, end: 31 }).ref, first.ref);
  h.store.close();
  const reopened = h.open();
  assert.deepEqual(reopened.readCitation(first.ref), first);
  const next = reopened.cite({ messageId: message.id, start: 0, end: 6 });
  assert.ok(next.ref > first.ref);
  assert.equal(reopened.readCitation(99999), null);
});

test('invalid evidence spans never leave orphan citation rows', t => {
  const { store } = setup(t);
  const message = add(store, '😀abc');
  for (const [start, end] of [[-1, 2], [0, 0], [2, 1], [0, 5], [0.5, 2]]) {
    assert.throws(() => store.cite({ messageId: message.id, start, end }), /span/);
  }
  assert.throws(() => store.cite({ messageId: 'absent', start: 0, end: 1 }), /Unknown source/);
  assert.equal(store.stats().citations, 0);
});

test('memory entries are exact source extracts and conflicting attributes cannot overwrite them', t => {
  const { store } = setup(t);
  const message = add(store, 'run command --size=8192 then verify');
  const input = { kind: 'pitfall', key: 'command-limit', origin: 'manual', pinned: true, scope: { b: 2, a: 1 } };
  const memory = remember(store, message, input);
  assert.equal(memory.text, message.text);
  assert.equal(memory.quote, message.text);
  assert.equal(memory.citation.ref, memory.ref);
  assert.equal(memory.sourceSeq, message.seq);
  assert.equal(remember(store, message, { ...input, scope: { a: 1, b: 2 } }).ref, memory.ref);
  assert.throws(() => remember(store, message, { ...input, kind: 'fact' }), /Memory span conflict/);
  assert.equal(store.stats().memories, 1);
  assert.equal(store.pinnedMemories()[0].ref, memory.ref);
});

test('model memories cannot be pinned; trusted manual and user origins can be pinned', t => {
  const { store } = setup(t);
  const modelSource = add(store, 'model evidence');
  assert.throws(() => remember(store, modelSource, { origin: 'model', pinned: true }), /cannot be pinned/);
  assert.equal(store.stats().citations, 0);
  const model = remember(store, modelSource, { origin: 'model' });
  const user = remember(store, add(store, 'user constraint'), { origin: 'user', pinned: true });
  assert.equal(model.pinned, false);
  assert.deepEqual(store.pinnedMemories().map(row => row.ref), [user.ref]);
});

test('confirmation adds an audit revision without changing source, citation or original model record', t => {
  const { store } = setup(t);
  const message = add(store, 'Use action guard after SQLITE_BUSY.');
  const originalInput = { kind: 'fact', origin: 'model' };
  const memory = remember(store, message, originalInput);
  const originalCitation = store.readCitation(memory.ref);
  const confirmed = store.confirm(memory.ref, { kind: 'failure', key: 'sqlite-write', scope: { action: 'write', resource: 'memory' } });
  assert.equal(confirmed.ref, memory.ref);
  assert.equal(confirmed.origin, 'manual');
  assert.equal(confirmed.pinned, true);
  assert.equal(confirmed.kind, 'failure');
  assert.deepEqual(confirmed.scope, { action: 'write', resource: 'memory' });
  assert.deepEqual(store.readCitation(memory.ref), originalCitation);
  assert.equal(remember(store, message, originalInput).origin, 'manual', 'stale model replay cannot downgrade confirmation');
  store.confirm(memory.ref, { kind: 'failure', key: 'sqlite-write', scope: { resource: 'memory', action: 'write' } });
  assert.equal(store.stats().confirmations, 1);
  assert.equal(store.search('SQLITE_BUSY', { kinds: ['failure'] })[0].ref, memory.ref);
  const inspect = new DatabaseSync(store.dbPath, { readOnly: true });
  const initial = inspect.prepare('SELECT origin,pinned FROM memories WHERE ref=?').get(memory.ref);
  const audit = inspect.prepare('SELECT beforeJson,afterJson FROM memory_revisions WHERE ref=?').get(memory.ref);
  inspect.close();
  assert.deepEqual({ ...initial }, { origin: 'model', pinned: 0 });
  assert.equal(JSON.parse(audit.beforeJson).origin, 'model');
  assert.equal(JSON.parse(audit.afterJson).origin, 'manual');
  assert.equal(store.confirm(memory.ref, { pinned: false }).pinned, false);
  assert.equal(store.stats().confirmations, 2);
});

test('source chronology prevents stale asynchronous extraction from superseding a newer correction', t => {
  const { store } = setup(t);
  const olderSource = add(store, 'old plan: max=9000');
  const newerSource = add(store, 'corrected plan: max=5159');
  const newer = remember(store, newerSource, { key: 'max' });
  const lateOldExtraction = remember(store, olderSource, { key: 'max' });
  assert.ok(lateOldExtraction.ref > newer.ref);
  assert.throws(() => store.supersede(newer.ref, lateOldExtraction.ref), /strictly later/);
  assert.equal(store.stats().relations, 0);
  const relation = store.supersede(lateOldExtraction.ref, newer.ref);
  assert.equal(relation.type, 'supersede');
  assert.equal(store.getMemory(lateOldExtraction.ref).active, false);
  assert.equal(store.getMemory(newer.ref).active, true);
  assert.deepEqual(store.listMemories().map(row => row.ref), [newer.ref]);
  assert.equal(store.listMemories({ includeInactive: true }).length, 2);
  assert.equal(store.search('old plan', { kinds: ['fact'] }).length, 0);
  assert.equal(store.search('old plan', { kinds: ['fact'], includeInactive: true })[0].ref, lateOldExtraction.ref);
});

test('supersede rejects stale branches and inactive replacements while exact replay is idempotent', t => {
  const { store } = setup(t);
  const a = remember(store, add(store, 'plan A'));
  const c = remember(store, add(store, 'intermediate plan C'));
  const b = remember(store, add(store, 'latest plan B'));
  const first = store.supersede(a.ref, b.ref);
  assert.equal(store.supersede(a.ref, b.ref).id, first.id);
  assert.throws(() => store.supersede(a.ref, c.ref), /active old and new/);
  assert.throws(() => store.supersede(c.ref), /newRef/);
  assert.throws(() => store.supersede(c.ref, null), /newRef/);
  store.retract(b.ref);
  assert.throws(() => store.supersede(c.ref, b.ref), /active old and new/);
  assert.equal(store.getMemory(c.ref).active, true);
  assert.equal(store.stats().relations, 2);
});

test('inactive memory cannot be resurrected by default raw-source search', t => {
  const { store } = setup(t);
  const oldMessage = store.append({ role: 'user', text: 'obsolete constraint: require mode=legacy', metadata: { turn: 1, authority: 'user' } });
  const old = remember(store, oldMessage, { kind: 'constraint' });
  const newer = remember(store, add(store, 'current constraint: require mode=modern'), { kind: 'constraint' });
  store.supersede(old.ref, newer.ref);
  assert.deepEqual(store.search('mode=legacy'), []);
  assert.deepEqual(store.search('mode=legacy', { kinds: ['source'] }), []);
  assert.equal(store.readCitation(old.ref).text, oldMessage.text);
  const history = store.search('mode=legacy', { includeInactive: true });
  assert.ok(history.length > 0);
  assert.ok(history.every(item => item.active === false));
  const raw = history.find(item => item.kind === 'source');
  assert.ok(raw.relatedInactiveMemoryRefs.includes(old.ref));
  assert.equal(raw.relations[0].type, 'supersede');
  assert.equal(raw.sourceRole, 'user');
  assert.equal(raw.sourceSeq, oldMessage.seq);
  assert.deepEqual(raw.sourceMetadata, { authority: 'user', turn: 1 });
  assert.equal(store.getMemory(old.ref).sourceRole, 'user');
});

test('resolved or retracted excerpts also suppress overlapping raw context by default', t => {
  const { store } = setup(t);
  const resolved = remember(store, add(store, 'finished task needs no further action'), { kind: 'task' });
  const retracted = remember(store, add(store, 'wrong advice must not recur'), { kind: 'failure' });
  store.resolve(resolved.ref);
  store.retract(retracted.ref);
  assert.deepEqual(store.search('finished task'), []);
  assert.deepEqual(store.search('wrong advice'), []);
  const raw = store.search('wrong advice', { kinds: ['source'], includeInactive: true });
  assert.equal(raw[0].active, false);
  assert.equal(raw[0].relations[0].type, 'retract');
});

test('inactive source candidates do not consume the active search result limit', t => {
  const { store } = setup(t);
  const activeSource = add(store, 'shared term current useful context');
  const stale = remember(store, add(store, 'shared term obsolete context'));
  store.retract(stale.ref);
  const found = store.search('shared term', { kinds: ['source'], limit: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].messageId, activeSource.id);
  assert.equal(found[0].active, true);
});

test('explicit sourceEvidence marks whole-source overlap and preserves historical citation reads', t => {
  const { store } = setup(t);
  const message = store.append({ role: 'user', text: 'prefix obsolete requirement suffix', metadata: { turn: 3 } });
  const memory = store.addMemory({ kind: 'constraint', messageId: message.id, start: 7, end: 27 });
  const whole = store.cite({ messageId: message.id, start: 0, end: Array.from(message.text).length });
  assert.equal(store.sourceEvidence(whole.ref).active, true);
  store.retract(memory.ref);
  const historical = store.sourceEvidence(whole.ref);
  assert.equal(historical.text, message.text);
  assert.equal(historical.active, false);
  assert.equal(historical.sourceRole, 'user');
  assert.equal(historical.sourceSeq, message.seq);
  assert.deepEqual(historical.sourceMetadata, { turn: 3 });
  assert.deepEqual(historical.relatedMemoryRefs, [memory.ref]);
  assert.deepEqual(historical.relatedInactiveMemoryRefs, [memory.ref]);
  assert.equal(historical.relations[0].type, 'retract');
  assert.equal(store.sourceEvidence(whole.ref, { includeInactive: false }), null);
  assert.equal(store.readCitation(whole.ref).text, message.text);
  assert.equal(store.sourceEvidence(999999), null);
});

test('same-message source offsets can supersede only in the forward direction', t => {
  const { store } = setup(t);
  const message = add(store, 'old; new;');
  const old = store.addMemory({ kind: 'decision', messageId: message.id, start: 0, end: 3 });
  const later = store.addMemory({ kind: 'decision', messageId: message.id, start: 5, end: 8 });
  assert.throws(() => store.supersede(later.ref, old.ref), /strictly later/);
  store.supersede(old.ref, later.ref);
  assert.equal(store.getMemory(old.ref).active, false);
});

test('retraction and resolution are append-only, idempotent and leave evidence readable', t => {
  const { store } = setup(t);
  const failure = remember(store, add(store, 'failure to avoid'), { kind: 'failure' });
  const task = remember(store, add(store, 'task to finish'), { kind: 'task' });
  store.retract(failure.ref); store.retract(failure.ref);
  store.resolve(task.ref); store.resolve(task.ref);
  assert.equal(store.stats().relations, 2);
  assert.equal(store.listMemories().length, 0);
  assert.equal(store.readCitation(failure.ref).text, 'failure to avoid');
  assert.equal(store.getMemory(task.ref).active, false);
  assert.equal(store.confirm(task.ref).active, false, 'confirmation must not reactivate a resolved task');
});

test('CJK bigrams, short literal queries, exact error codes and Windows paths are searchable', t => {
  const { store } = setup(t);
  const text = '必须检查上下文压缩规则。错误码 CONTEXT_WINDOW_EXCEEDED，路径 F:\\Project\\组件\\demo.ts';
  const message = add(store, text);
  const memory = remember(store, message, { kind: 'failure', scope: { action: 'compact' } });
  for (const query of ['压缩', '上下文压缩', '压', 'CONTEXT_WINDOW_EXCEEDED', 'F:\\Project\\组件\\demo.ts']) {
    const results = store.search(query, { kinds: ['failure'], limit: 3 });
    assert.ok(results.some(item => item.ref === memory.ref), query);
    assert.equal(store.readCitation(results[0].ref).text, results[0].text);
  }
  assert.deepEqual(store.search('does_not_exist_42801'), []);
  assert.deepEqual(store.search('压缩', { kinds: [] }), []);
  assert.deepEqual(store.search(''), []);
});

test('literal queries do not execute SQL or FTS syntax supplied by the caller', t => {
  const { store } = setup(t);
  add(store, 'normal source');
  assert.deepEqual(store.search("' OR 1=1 --"), []);
  assert.deepEqual(store.search('title:nonexistent OR *'), []);
});

test('literal recall crosses hard chunk boundaries and yields a stable source citation', t => {
  const { store } = setup(t);
  const message = add(store, 'x'.repeat(2045) + 'UNIQUE_BOUNDARY_VALUE' + 'y'.repeat(2500));
  const results = store.search('UNIQUE_BOUNDARY_VALUE', { kinds: ['source'], limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'source');
  assert.ok(results[0].text.includes('UNIQUE_BOUNDARY_VALUE'));
  assert.ok(Array.from(results[0].text).length <= 2048);
  assert.equal(results[0].messageId, message.id);
  assert.equal(store.search('UNIQUE_BOUNDARY_VALUE', { kinds: ['source'], limit: 1 })[0].ref, results[0].ref);
});

test('search limits and kind filters apply to stored exact evidence', t => {
  const { store } = setup(t);
  for (let i = 0; i < 12; i += 1) remember(store, add(store, `shared query item ${i}`), { kind: i % 2 ? 'task' : 'fact' });
  const found = store.search('shared query', { kinds: ['task'], limit: 3 });
  assert.equal(found.length, 3);
  assert.ok(found.every(item => item.kind === 'task'));
  assert.ok(found.every(item => item.active && typeof item.ref === 'number' && Number.isFinite(item.score)));
});

test('indexes, confirmed attributes and citation numbers survive closing and reopening', t => {
  const h = setup(t);
  const memory = remember(h.store, add(h.store, '持久化检索 SQLITE_BUSY'), { origin: 'model' });
  h.store.confirm(memory.ref, { kind: 'failure', key: 'busy', scope: { action: 'write' } });
  h.store.close();
  const reopened = h.open();
  assert.equal(reopened.search('持久化', { kinds: ['failure'] })[0].ref, memory.ref);
  assert.equal(reopened.getMemory(memory.ref).pinned, true);
  assert.equal(reopened.stats().confirmations, 1);
});

test('direct UPDATE/DELETE cannot mutate source, citation or audit tables', t => {
  const { store } = setup(t);
  const memory = remember(store, add(store, 'immutable evidence'));
  store.confirm(memory.ref);
  const db = new DatabaseSync(store.dbPath);
  try {
    for (const table of ['messages', 'chunks', 'citations', 'memories', 'memory_revisions', 'meta']) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
    }
    assert.throws(() => db.prepare('UPDATE messages SET text=?').run('tampered'), /append-only/);
  } finally { db.close(); }
});

test('hash verification detects externally damaged original evidence', t => {
  const { store } = setup(t);
  const message = add(store, 'original verified text');
  const citation = store.cite({ messageId: message.id, start: 0, end: 8 });
  const db = new DatabaseSync(store.dbPath);
  db.exec('DROP TRIGGER immutable_messages_update');
  db.prepare('UPDATE messages SET text=? WHERE id=?').run('modified verified text', message.id);
  db.close();
  assert.throws(() => store.readCitation(citation.ref), /hash mismatch/);
});

test('identity and schema metadata prevent opening a foreign conversation database', t => {
  const h = setup(t, 'A');
  add(h.store, 'A only');
  h.store.close();
  const wrongDirectory = path.join(h.rootDir, digest('B'));
  fs.mkdirSync(wrongDirectory);
  fs.copyFileSync(h.store.dbPath, path.join(wrongDirectory, 'memory.sqlite'));
  assert.throws(() => new ConversationStore({ rootDir: h.rootDir, conversationId: 'B' }), /identity mismatch/);
  const db = new DatabaseSync(h.store.dbPath);
  db.exec('DROP TRIGGER immutable_meta_update');
  db.prepare('UPDATE meta SET value=? WHERE key=?').run('999', 'schemaVersion');
  db.close();
  assert.throws(() => h.open(), /schema version/);
});

test('process exit during an uncommitted append cannot expose half a record', t => {
  const h = setup(t);
  add(h.store, 'committed baseline');
  h.store.close();
  const code = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO messages(id,sourceKey,role,text,hash,createdAt,metadata) VALUES (?,?,?,?,?,?,?)')
    .run('half','half','user','not committed','invalid','test','{}');process.exit(23);`;
  const child = spawnSync(process.execPath, ['-e', code, h.store.dbPath], {
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(child.status, 23, child.stderr);
  const reopened = h.open();
  assert.equal(reopened.getMessage('half'), null);
  assert.equal(reopened.listMessages().length, 1);
});

test('close is idempotent and later operations fail clearly', t => {
  const { store } = setup(t);
  store.close(); store.close();
  assert.throws(() => store.stats(), /closed/);
  assert.throws(() => store.search('anything'), /closed/);
});
