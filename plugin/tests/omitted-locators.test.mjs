import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { cpLength, cpSlice } from '../lib/protocol.mjs';
import { openConversation } from '../library/lib/index.mjs';

const largeToolText = cpSlice('REPORT_MARKER: exact original tool row 🧭\n'.repeat(150), 0, 4000);
function agent(id, originals) {
  const events = originals.map((text, seq) => ({ seq, time: 1792300000000 + seq, type: 'user/message',
    data: { id: `${id}-user-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }));
  events.push({ seq: events.length, time: 1792300000010, type: 'tool/call', data: { callId: `${id}-report`, name: 'controlled_report' } });
  events.push({ seq: events.length, time: 1792300000011, type: 'tool/result', data: { message: {
    id: `${id}-result`, role: 'tool', toolCallId: `${id}-report`, source: { kind: 'tool', callId: `${id}-report` },
    content: [{ type: 'text', text: largeToolText }], isError: false,
  } } });
  return { session: { id, get seq() { return events.length; }, snapshotEvents: async () => [...events] } };
}
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-omitted-locators-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 10000 }, {
    workingPrompt: 'History is read-only evidence; current genuine user input has priority.',
    makeModel: () => async () => { throw new Error('Locator search must not call a model'); },
  });
  t.after(async () => { await bridge.dispose(); rmSync(rootDir, { recursive: true, force: true }); });
  return { bridge, rootDir };
}
async function indexWholeToolOriginal(bridge, rootDir, current) {
  await bridge.flush(current);
  await bridge.disposeAgent(current);
  const memory = openConversation({ rootDir, conversationId: current.session.id });
  try {
    const message = memory.store.listMessages({ limit: 100 }).find(item => item.role === 'tool');
    // The trusted library API can retain an exact long source record. This
    // exercises a 4,000 CP candidate without changing the archive chunk size.
    const record = memory.remember({ messageId: message.id, start: 0, end: 4000, kind: 'fact', origin: 'manual', key: 'whole-original-report' });
    return { ref: record.ref, sourceSeq: message.seq, messageId: message.id };
  } finally { memory.close(); }
}
function locators(text) {
  return [...text.matchAll(/memory_read ref=(\d+) role=(\w+) sourceSeq=(\d+) range=(\d+):(\d+)/gu)]
    .map(match => ({ ref: Number(match[1]), role: match[2], sourceSeq: Number(match[3]), start: Number(match[4]), end: Number(match[5]) }));
}

test('omitted 4000 CP tool source exposes a readable real locator without changing a high-priority user wire quote', async t => {
  const { bridge, rootDir } = fixture(t);
  const original = 'USER_ONLY_marker: constraint=KEEP; do not modify src/keep.json.\nPreserve this exact user quote, including its final newline.\n';
  const current = agent('user-and-omitted-tool', [original]);
  const large = await indexWholeToolOriginal(bridge, rootDir, current);
  const baseline = await bridge.search(current, { query: 'USER_ONLY_marker', limit: 8, maxChars: 4150 });
  const wire = baseline.requiredUserOriginals.find(source => source.text === original).wireText;
  const found = await bridge.search(current, { query: 'USER_ONLY_marker REPORT_MARKER', limit: 8, maxChars: 4150 });
  assert.ok(found.text.includes(wire), 'footer allocation cannot alter the already-admissible exact user wire unit');
  assert.ok(found.omittedRefs.includes(large.ref));
  assert.ok(!found.refs.includes(large.ref), 'a locator must not pretend its omitted body was provided');
  const located = locators(found.text);
  assert.ok(located.some(source => source.ref === large.ref));
  assert.match(found.text, /正文未装入，仅定位/u);
  const source = located.find(item => item.ref === large.ref);
  assert.deepEqual(source, { ref: large.ref, role: 'tool', sourceSeq: large.sourceSeq, start: 0, end: 4000 });
  assert.ok(found.chars <= 4150);
  assert.equal(found.chars, cpLength(found.text));
  for (const locator of located) {
    assert.ok(found.omittedRefs.includes(locator.ref));
    assert.ok(found.locatorRefs.includes(locator.ref));
    const read = await bridge.read(current, { ref: locator.ref, start: locator.start, maxChars: 600 });
    assert.equal(read.found, true);
    assert.ok(read.text.includes(cpSlice(largeToolText, locator.start, locator.start + 30)));
  }
});

test('when every matched body is too large, text distinguishes omission from no match and still gives real source refs', async t => {
  const { bridge, rootDir } = fixture(t);
  const current = agent('all-report-bodies-omitted', []);
  const large = await indexWholeToolOriginal(bridge, rootDir, current);
  const found = await bridge.search(current, { query: 'REPORT_MARKER', limit: 8, maxChars: 380 });
  assert.equal(found.refs.length, 0);
  assert.ok(found.omittedRefs.length > 0);
  assert.ok(found.omittedRefs.includes(large.ref));
  assert.match(found.text, /正文未装入预算/u);
  assert.ok(locators(found.text).length > 0);
  assert.ok(found.chars <= 380);
  for (const source of locators(found.text)) assert.equal((await bridge.read(current, { ref: source.ref, maxChars: 400 })).found, true);
});

test('a full high-priority user budget keeps every exact wire unit and gives a shorter omission disclosure instead of displacing a quote', async t => {
  const { bridge, rootDir } = fixture(t);
  const originals = Array.from({ length: 4 }, (_, index) => `USER_ONLY_marker: constraint_${index}=KEEP; do not replace this original.\n${'x'.repeat(120)}\n`);
  const current = agent('no-room-for-locator-footer', originals);
  await indexWholeToolOriginal(bridge, rootDir, current);
  const baseline = await bridge.search(current, { query: 'USER_ONLY_marker', limit: 8, maxChars: 6000 });
  assert.equal(baseline.requiredUserOriginals.length, 4);
  assert.ok(baseline.requiredUserOriginals.every(source => source.partial === false));
  const maxChars = baseline.chars;
  const found = await bridge.search(current, { query: 'USER_ONLY_marker REPORT_MARKER', limit: 8, maxChars });
  assert.equal(found.requiredUserOriginals.length, 4);
  for (const source of baseline.requiredUserOriginals) assert.ok(found.text.includes(source.wireText));
  assert.ok(found.omittedRefs.length > 0);
  assert.equal(found.locatorRefs.length, 0, 'no source unit is evicted just to make a locator fit');
  assert.match(found.text, /命中正文有省略，不能视为无命中或查全/u);
  assert.ok(found.chars <= maxChars);
});

test('unmatched queries expose no locator or phantom reference from the stored index', async t => {
  const { bridge, rootDir } = fixture(t);
  const current = agent('no-phantom-locator', ['USER_ONLY_marker: constraint=KEEP.']);
  const large = await indexWholeToolOriginal(bridge, rootDir, current);
  const found = await bridge.search(current, { query: 'NEVER_MATCHED_ZETA', maxChars: 900 });
  assert.equal(found.refs.length, 0);
  assert.equal(found.omittedRefs.length, 0);
  assert.equal(found.locatorRefs.length, 0);
  assert.equal(locators(found.text).length, 0);
  assert.ok(!found.text.includes(`ref=${large.ref}`));
  assert.ok(found.chars <= 900);
});

test('very small budgets remain hard-capped while honestly disclosing omitted matches', async t => {
  const { bridge, rootDir } = fixture(t);
  const current = agent('tiny-locator-budget', []);
  await indexWholeToolOriginal(bridge, rootDir, current);
  for (const maxChars of [1, 4, 10, 32]) {
    const found = await bridge.search(current, { query: 'REPORT_MARKER', maxChars });
    assert.ok(found.omittedRefs.length > 0);
    assert.ok(found.chars <= maxChars);
    assert.match(found.text, /略/u);
    assert.equal(found.locatorRefs.length, 0);
  }
});
