import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openConversation } from '../lib/index.mjs';

function fixture(t, model) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-native-order-')), opened = [];
  const open = () => { const memory = openConversation({ rootDir, conversationId: 'chronology', model }); opened.push(memory); return memory; };
  t.after(() => { for (const memory of opened) memory.close(); assert.equal(dirname(realpathSync(rootDir)), realpathSync(tmpdir())); rmSync(rootDir, { recursive: true, force: true }); });
  return { open, memory: open() };
}
const append = (memory, seq, text, role = 'assistant') => memory.append({ role, text, sourceKey: `dsh:chronology:${seq}`, metadata: { seq, sessionId: 'chronology' } });

test('native background excludes future events even when an earlier source was inserted last; storage pagination stays append ordered', async t => {
  const requests = [], { memory } = fixture(t, async request => { const data = JSON.parse(request.messages[1].content); requests.push(data); return { finish: 'stop', text: JSON.stringify({ records: [{ ref: data.sources[0].ref, kind: 'fact', quote: data.sources[0].text }] }) }; });
  append(memory, 2, 'actual old result'); append(memory, 3, 'Stop old task; inspect new project.', 'user'); append(memory, 4, 'new project confirmed');
  const earlier = append(memory, 1, 'old command'), next = append(memory, 5, 'latest result');
  await memory.indexMessages({ messageIds: [earlier.id, next.id] });
  assert.deepEqual(requests[0].previousBackground.sources, []);
  assert.deepEqual(requests[1].previousBackground.sources.map(row => row.sourceMetadata.seq), [3, 4]);
  assert.deepEqual(memory.store.listMessages({ afterSeq: 2 }).map(row => row.metadata.seq), [4, 1, 5]);
  const a = memory.store.listMessages({ afterSeq: 0, limit: 2 }), b = memory.store.listMessages({ afterSeq: a.at(-1).seq, limit: 2 });
  assert.equal(new Set([...a, ...b].map(row => row.id)).size, 4);
});

test('future-derived backgrounds are repaired by append-only revisions and safely re-extracted without changing raw refs', async t => {
  const { open, memory } = fixture(t, async request => { const data = JSON.parse(request.messages[1].content); return { finish: 'stop', text: JSON.stringify({ records: [{ ref: data.sources[0].ref, kind: 'state', quote: data.sources[0].text }] }) }; });
  const future = append(memory, 3, 'new project future', 'user'), old = append(memory, 1, 'old command');
  const bg = memory.cite({ messageId: future.id, start: 0, end: future.text.length });
  const derived = memory.remember({ kind: 'fact', messageId: old.id, start: 0, end: old.text.length, origin: 'model', key: 'old-classification', scope: { indexingBackgroundRefs: [bg.ref] } });
  memory.close(); const reopened = open();
  assert.deepEqual(reopened.repairedBackgroundMessageIds, [old.id]);
  const repaired = reopened.store.getMemory(derived.ref);
  assert.deepEqual(repaired.scope.indexingBackgroundRefs, []); assert.equal(repaired.scope.backgroundReindexPending, true);
  assert.equal(repaired.origin, 'model'); assert.equal(repaired.pinned, false);
  assert.equal(reopened.read(derived.ref).text, 'old command'); assert.equal(reopened.read(bg.ref).text, 'new project future');
  assert.deepEqual(reopened.store.repairIndexBackgrounds(), [old.id], 'a crash before cursor reset must not lose the pending repair');
  assert.equal(reopened.stats().confirmations, 1, 'repeated repair does not append duplicate audit revisions');
  assert.equal(reopened.store.search('old command').some(row => row.kind === 'fact'), false);
  await reopened.indexMessages({ messageIds: [old.id] });
  const rederived = reopened.store.getMemory(derived.ref);
  assert.equal(rederived.kind, 'state'); assert.equal(rederived.key, null); assert.equal(rederived.scope.backgroundReindexPending, undefined);
  assert.equal(reopened.stats().confirmations, 2); assert.deepEqual(reopened.store.repairIndexBackgrounds(), []);
});

test('foreign event positions cannot become native chronology or previous background', t => {
  const { memory } = fixture(t);
  const generic = memory.append({ role: 'user', text: 'generic', metadata: { seq: 9999, sessionId: 'other-conversation' } });
  const native = append(memory, 2, 'native');
  assert.deepEqual(memory.store.previousMessages(native.id), []);
  assert.equal(memory.store.sourcePosition(generic).domain, 'storage');
  assert.equal(memory.store.sourcePosition(native).position, 2);
});
