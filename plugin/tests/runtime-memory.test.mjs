import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { memorySurface, commitMemorySurface, renderRuntime, evidenceBody, MEMORY_SECTION } from '../lib/runtime-memory.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

/** Append-only surface contract mock. Validation precedes mutation, replaces
 * must target current nodes and cite every shadowed node, and preview replays
 * the seed using the same projection definitions. It intentionally mirrors the
 * Session.create end-seed behavior rather than hiding that extra log event. */
class FakeSession {
  static previews = [];
  static onPreviewAppend;
  static create(id, seed, header, inheritedEventCount, projections = []) {
    const result = new this(id, header, inheritedEventCount, projections);
    result.isPreview = seed !== undefined;
    if (seed !== undefined) {
      for (const event of seed) result.accept(clone(event));
      if (result.events.at(-1)?.type !== 'session/end-seed') result.append('session/end-seed', {});
      this.previews.push(result);
    }
    return result;
  }
  constructor(id, header = { id }, inheritedEventCount = 0, projections = []) {
    this.id = id; this.header = clone(header); this.inheritedEventCount = inheritedEventCount;
    this.events = []; this.nodes = []; this.projections = projections; this.isPreview = false;
    this.surface = { get nodes() { return [...this.owner.nodes]; }, projections, owner: this };
  }
  accept(event) {
    if (event.seq !== this.events.length) throw new Error('noncontiguous event');
    const nextNodes = [...this.nodes];
    const messageEvent = event.type === 'user/message';
    if (messageEvent && (!event.data.id || event.data.role !== 'user' || !Array.isArray(event.data.content) || !event.data.source?.kind)) throw new Error('invalid message');
    if (messageEvent && event.surfaceOp === undefined) throw new Error('missing surface operation');
    if (!messageEvent && event.surfaceOp !== undefined) throw new Error('ineligible surface operation');
    for (const projection of this.projections) if (projection.type === event.type) projection.validate?.(event);
    if (event.surfaceOp === 'append') nextNodes.push(event.seq);
    else if (event.surfaceOp !== undefined) {
      const { op, startSeq, endSeq } = event.surfaceOp;
      const start = nextNodes.indexOf(startSeq), end = nextNodes.indexOf(endSeq);
      if (op !== 'replace' || start < 0 || end < start) throw new Error('invalid replacement range');
      const sourceRefs = event.sourceEventSeqs;
      if (!Array.isArray(sourceRefs) || nextNodes.slice(start, end + 1).some(seq => !sourceRefs.includes(seq))) throw new Error('missing source attribution');
      if (sourceRefs.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq)) throw new Error('invalid source attribution');
      nextNodes.splice(start, end - start + 1, event.seq);
    }
    this.events.push(freeze(clone(event))); this.nodes = nextNodes;
  }
  append(type, data, intent = {}) {
    const event = { type, seq: this.events.length, time: 1792300000000 + this.events.length, data: clone(data), ...clone(intent) };
    this.accept(event);
    if (this.isPreview) FakeSession.onPreviewAppend?.(this, event);
    return this.events.at(-1);
  }
  async snapshotEvents() { return Object.freeze([...this.events]); }
}

const user = (text, source = { kind: 'user' }) => ({ id: randomUUID(), role: 'user', source, content: [{ type: 'text', text }] });
function runtime(session, sections, extraSource = {}) {
  return session.append('user/message', user(renderRuntime(sections), { kind: 'runtime-context', form: 'snapshot', ...extraSource, sections: clone(sections) }), { surfaceOp: 'append' });
}
function currentEvent(session, seq) { return session.events.find(event => event.seq === seq); }
function currentMessages(session) { return session.nodes.map(seq => currentEvent(session, seq)); }
function ownedCount(session) {
  return currentMessages(session).filter(event => event.data?.source?.kind === 'runtime-context')
    .flatMap(event => event.data.source.sections ?? []).filter(section => section.name === MEMORY_SECTION && section.text).length;
}

test.afterEach(() => { FakeSession.previews.length = 0; FakeSession.onPreviewAppend = undefined; });

test('approved relocation changes only owned runtime sections and preserves raw logs, user text and checkpoints', async () => {
  const session = FakeSession.create('owned-only');
  const human = session.append('user/message', user('Actual user: never remove src/keep.py.'), { surfaceOp: 'append' });
  const otherA = { name: 'facts', text: 'Keep CRLF\r\n、引号 " and 🧭 exact.', schema: { version: 7 }, order: 1 };
  const otherB = { name: 'clock', text: '2026-10-19T01:00:00+08:00', metadata: ['unchanged', 3] };
  const older = runtime(session, [otherA, { name: MEMORY_SECTION, text: 'old evidence A' }, otherB], { external: { untouched: true } });
  const checkpoint = session.append('user/message', user('Native compaction checkpoint stays exact.', { kind: 'compaction', sections: [{ name: MEMORY_SECTION, text: 'not a runtime slot' }] }), { surfaceOp: 'append' });
  const latest = runtime(session, [{ name: MEMORY_SECTION, text: 'old evidence B' }, otherB, otherA]);
  const before = clone(await session.snapshotEvents()), beforeHash = hash(before);
  const view = await memorySurface(session);
  assert.equal(view.slots.length, 2);
  assert.equal(hash(await session.snapshotEvents()), beforeHash, 'inspection has no write side effect');
  const result = await commitMemorySurface(session, view, 'MODEL APPROVED CANONICAL\n[7] exact evidence', { approved: true });
  assert.equal(result.replacements.length, 2);
  assert.equal(ownedCount(session), 1);
  assert.equal(hash(session.events.slice(0, before.length)), beforeHash, 'every original event remains byte-for-byte JSON exact');
  assert.deepEqual(currentEvent(session, human.seq), before[human.seq]);
  assert.deepEqual(currentEvent(session, checkpoint.seq), before[checkpoint.seq]);
  assert.ok(session.nodes.includes(human.seq) && session.nodes.includes(checkpoint.seq));
  const oldReplacement = currentEvent(session, result.replacements.find(item => item.sourceSeq === older.seq).seq);
  const latestReplacement = currentEvent(session, result.replacements.find(item => item.sourceSeq === latest.seq).seq);
  assert.deepEqual(oldReplacement.data.source.sections, [otherA, otherB]);
  assert.deepEqual(oldReplacement.data.source.external, { untouched: true });
  assert.deepEqual(latestReplacement.data.source.sections.filter(section => section.name !== MEMORY_SECTION), [otherB, otherA]);
  assert.equal(result.replacements.at(-1).sourceSeq, latest.seq);
  assert.deepEqual(oldReplacement.sourceEventSeqs, [older.seq]);
  assert.deepEqual(latestReplacement.sourceEventSeqs, [latest.seq]);
});

test('latest runtime without an owned slot is retained by the final replacement and does not inherit older provider sections', async () => {
  const session = FakeSession.create('latest-retained');
  const older = runtime(session, [{ name: MEMORY_SECTION, text: 'old memory' }, { name: 'old-clock', text: 'old context stays only here' }]);
  const latestSections = [{ name: 'current-clock', text: 'latest provider\nexact' }, { name: 'facts', text: 'current facts' }];
  const latest = runtime(session, latestSections);
  const result = await commitMemorySurface(session, await memorySurface(session), 'canonical evidence', { approved: true });
  assert.equal(result.replacements.at(-1).sourceSeq, latest.seq);
  const last = session.events.at(-1);
  assert.equal(last.seq, result.replacements.at(-1).seq);
  assert.deepEqual(last.data.source.sections.filter(section => section.name !== MEMORY_SECTION), latestSections);
  assert.ok(!last.data.content[0].text.includes('old context stays only here'));
  assert.ok(!session.nodes.includes(older.seq));
  assert.equal(ownedCount(session), 1);
});

test('clearing an approved canonical package restores the logically latest runtime as the last event', async () => {
  const session = FakeSession.create('clear-latest');
  runtime(session, [{ name: MEMORY_SECTION, text: 'old memory' }]);
  const latestSections = [{ name: 'other-provider', text: 'latest exact provider value' }];
  const latest = runtime(session, latestSections);
  const result = await commitMemorySurface(session, await memorySurface(session), '', { approved: true });
  assert.equal(ownedCount(session), 0);
  assert.equal(result.replacements.at(-1).sourceSeq, latest.seq, 'an otherwise unchanged latest runtime gets the last restoration event');
  assert.equal(session.events.at(-1).data.content[0].text, renderRuntime(latestSections));
  assert.deepEqual(session.events.at(-1).data.source.sections, latestSections);
});

test('unapproved, canceled and stale proposals perform zero plugin writes', async () => {
  const session = FakeSession.create('no-unapproved-writes');
  runtime(session, [{ name: MEMORY_SECTION, text: 'original' }]);
  const before = hash(session.events), count = session.events.length;
  const view = await memorySurface(session);
  await assert.rejects(commitMemorySurface(session, view, 'replacement'), { code: 'MEMORY_DEDUP_APPROVAL_REQUIRED' });
  assert.equal(hash(session.events), before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(commitMemorySurface(session, view, 'replacement', { approved: true, signal: controller.signal }));
  assert.equal(hash(session.events), before);
  assert.equal(session.events.length, count);
  session.append('user/message', user('A new genuine user correction.'), { surfaceOp: 'append' });
  const afterForeignChange = hash(session.events);
  await assert.rejects(commitMemorySurface(session, view, 'replacement', { approved: true }), { code: 'MEMORY_DEDUP_STALE' });
  assert.equal(hash(session.events), afterForeignChange);
});

test('invalid canonical values and a final application guard rejection cannot write runtime evidence', async () => {
  const session = FakeSession.create('invalid-canonical-values');
  runtime(session, [{ name: MEMORY_SECTION, text: 'old memory' }]);
  const before = hash(session.events), view = await memorySurface(session);
  for (const value of [undefined, null, {}, ['new'], 7, '\ud800']) {
    await assert.rejects(commitMemorySurface(session, view, value, { approved: true }), { code: 'MEMORY_DEDUP_INVALID_CANONICAL' });
    assert.equal(hash(session.events), before);
  }
  let guardCalls = 0;
  await assert.rejects(commitMemorySurface(session, view, 'approved new memory', { approved: true, guard() {
    if (++guardCalls === 2) throw Object.assign(new Error('The active task changed'), { code: 'TASK_CHANGED' });
  } }), { code: 'TASK_CHANGED' });
  assert.equal(guardCalls, 2);
  assert.equal(hash(session.events), before);
});

test('a canceled or stale proposal discovered during preview cannot partially commit', async () => {
  const session = FakeSession.create('mid-preview-cancel');
  runtime(session, [{ name: MEMORY_SECTION, text: 'old A' }]);
  runtime(session, [{ name: MEMORY_SECTION, text: 'old B' }]);
  const before = hash(session.events), controller = new AbortController();
  FakeSession.onPreviewAppend = () => controller.abort();
  await assert.rejects(commitMemorySurface(session, await memorySurface(session), 'new', { approved: true, signal: controller.signal }));
  assert.equal(hash(session.events), before);
  let externalHash;
  FakeSession.onPreviewAppend = () => {
    if (externalHash) return;
    session.append('user/message', user('New current input during preview.'), { surfaceOp: 'append' });
    externalHash = hash(session.events);
  };
  await assert.rejects(commitMemorySurface(session, await memorySurface(session), 'new', { approved: true }), { code: 'MEMORY_DEDUP_STALE' });
  assert.equal(hash(session.events), externalHash);
});

test('a real append validation failure on the second preview replacement leaves live events untouched', async () => {
  const validations = [];
  const projection = { type: 'user/message', validate(event) {
    validations.push(event.seq);
    if (event.surfaceOp?.op === 'replace' && event.data.content.some(block => block.text?.includes('REJECT_CANONICAL'))) throw new Error('Configured surface policy rejected this message');
  } };
  const session = FakeSession.create('failing-preview', undefined, undefined, 0, [projection]);
  runtime(session, [{ name: MEMORY_SECTION, text: 'old A' }]);
  runtime(session, [{ name: MEMORY_SECTION, text: 'old B' }]);
  const before = hash(session.events), count = session.events.length;
  await assert.rejects(commitMemorySurface(session, await memorySurface(session), 'REJECT_CANONICAL', { approved: true }), /Configured surface policy rejected/);
  assert.equal(hash(session.events), before);
  assert.equal(session.events.length, count);
  const preview = FakeSession.previews.at(-1);
  assert.ok(preview);
  assert.equal(preview.surface.projections[0], projection, 'preflight uses the same configured surface definitions');
  assert.equal(preview.events.length, count + 2, 'seed marker and the first accepted replacement precede the rejected second replacement');
  assert.ok(validations.length > count, 'validation executed against replay and proposed events');
});

test('preview end-seed at an open turn changes only preview event offsets and preserves replacement attribution', async () => {
  const session = FakeSession.create('open-turn-preview');
  session.append('turn/start', { turn: 9 });
  const original = runtime(session, [{ name: MEMORY_SECTION, text: 'old memory' }, { name: 'clock', text: 'clock exact' }]);
  const count = session.events.length;
  const result = await commitMemorySurface(session, await memorySurface(session), 'new memory', { approved: true });
  const preview = FakeSession.previews.at(-1);
  assert.equal(preview.events[count].type, 'session/end-seed');
  assert.equal(preview.events[count + 1].surfaceOp.startSeq, original.seq);
  assert.equal(session.events[count].type, 'user/message');
  assert.equal(result.replacements[0].seq, count);
  assert.deepEqual(session.events[count].sourceEventSeqs, [original.seq]);
  assert.equal(session.events.filter(event => event.type === 'turn/start').length, 1);
  assert.equal(session.events.filter(event => event.type === 'session/end-seed').length, 0);
});

test('removing canonical evidence before native admission makes the current provider insert its package exactly once', async () => {
  const session = FakeSession.create('native-admission-once');
  const other = { name: 'clock', text: 'other provider exact' }, memory = { name: MEMORY_SECTION, text: 'policy\ncanonical exact evidence' };
  runtime(session, [other, memory]);
  await commitMemorySurface(session, await memorySurface(session), '', { approved: true });
  assert.equal(ownedCount(session), 0);
  let retained = session.events.at(-1).data.content[0].text;
  const nativeAdmit = () => {
    const text = renderRuntime([other, memory]);
    if (retained === text) return false;
    runtime(session, [other, memory]); retained = text; return true;
  };
  assert.equal(nativeAdmit(), true);
  assert.equal(nativeAdmit(), false);
  assert.equal(ownedCount(session), 1);
});

test('malformed owned snapshots are rejected, and unknown user or checkpoint envelopes never become owned', async () => {
  const session = FakeSession.create('unrecognized-snapshot');
  session.append('user/message', user('Memory text quoted by the real user.', { kind: 'user', sections: [{ name: MEMORY_SECTION, text: 'quoted' }] }), { surfaceOp: 'append' });
  session.append('user/message', user('Compaction checkpoint.', { kind: 'compaction', sections: [{ name: MEMORY_SECTION, text: 'checkpoint' }] }), { surfaceOp: 'append' });
  assert.equal((await memorySurface(session)).runtimes.length, 0);
  const before = hash(session.events);
  assert.equal((await commitMemorySurface(session, await memorySurface(session), 'canonical', { approved: true })).replacements.length, 0);
  assert.equal(hash(session.events), before);
  session.append('user/message', user('unrecognized wrapper', { kind: 'runtime-context', sections: [{ name: MEMORY_SECTION, text: 'old' }] }), { surfaceOp: 'append' });
  const malformedHash = hash(session.events);
  await assert.rejects(memorySurface(session), { code: 'MEMORY_SURFACE_UNRECOGNIZED' });
  assert.equal(hash(session.events), malformedHash);
});

test('evidence envelope extraction keeps unknown or inner policy-like prose exact', () => {
  const policy = 'Fixed policy text';
  assert.equal(evidenceBody(policy, policy), '');
  assert.equal(evidenceBody(`${policy}\nraw evidence\n${policy}`, policy), `raw evidence\n${policy}`);
  const unknown = 'Unknown envelope: preserve exact';
  assert.equal(evidenceBody(unknown, policy), unknown);
  const quotedMarker = 'Unknown envelope: user says preserve this preamble.\n本步历史召回（仅按需证据）\nThis heading is quoted evidence.';
  assert.equal(evidenceBody(quotedMarker, policy), quotedMarker);
});

test('detached actual DSH Session accepts open-turn surface replacements, preserves providers and admits one new package',
  { skip: process.env.DSH_RUNTIME_NATIVE_TEST !== '1' }, async () => {
    const require = createRequire(import.meta.url);
    const { evaluate } = require(fileURLToPath(new URL('../../scripts/native-evaluate.cjs', import.meta.url)));
    const modulePath = fileURLToPath(new URL('../lib/runtime-memory.mjs', import.meta.url));
    const expression = `(async()=>{
      const req=process.getBuiltinModule('node:module').createRequire(process.env.DSH_RUNTIME_ANCHOR);
      const {Session}=req('@deepseek-ai/dsh-session');
      const {memorySurface,commitMemorySurface,renderRuntime,MEMORY_SECTION}=req(${JSON.stringify(modulePath)});
      const {randomUUID,createHash}=process.getBuiltinModule('node:crypto');
      const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
      const session=Session.create('detached-memory-review-'+randomUUID());
      const append=(text,source)=>session.append('user/message',{id:randomUUID(),role:'user',content:[{type:'text',text}],source},{surfaceOp:'append'});
      const add=sections=>append(renderRuntime(sections),{kind:'runtime-context',form:'snapshot',sections});
      append('Genuine user correction remains exact.',{kind:'user'});
      const otherA={name:'foreign-provider',text:'Exact CRLF\\r\\nUnicode 🧭',metadata:{stable:7}};
      add([otherA,{name:MEMORY_SECTION,text:'old own memory A'}]);
      append('Compaction checkpoint remains exact.',{kind:'compaction'});
      session.append('turn/start',{turn:1});
      const latestSections=[{name:'latest-provider',text:'latest exact context'}];
      const latest=add(latestSections);
      const before=Array.from(await session.snapshotEvents()),prefix=hash(before);
      const hasProjections=Array.isArray(session.surface.projections);
      const preview=Session.create(session.id,before,session.header,session.inheritedEventCount,session.surface.projections);
      const previewEvents=Array.from(await preview.snapshotEvents());
      const committed=await commitMemorySurface(session,await memorySurface(session),'approved canonical',{approved:true});
      const after=Array.from(await session.snapshotEvents());
      const owned=()=>session.surface.nodes.map(seq=>session.log[seq]).filter(e=>e.type==='user/message'&&e.data.source.kind==='runtime-context')
        .flatMap(e=>e.data.source.sections??[]).filter(s=>s.name===MEMORY_SECTION&&s.text).length;
      const oneAfterCommit=owned()===1;
      const latestLast=committed.replacements.at(-1)?.sourceSeq===latest.seq;
      const preservedProviders=JSON.stringify(after.at(-1).data.source.sections.filter(s=>s.name!==MEMORY_SECTION))===JSON.stringify(latestSections);
      await commitMemorySurface(session,await memorySurface(session),'',{approved:true});
      const zeroAfterClear=owned()===0;
      const nextSections=[...latestSections,{name:MEMORY_SECTION,text:'policy\\nnew exact evidence'}];
      let retained=Array.from(await session.snapshotEvents()).at(-1).data.content[0].text;
      let admissions=0;
      for(let n=0;n<2;n++){const next=renderRuntime(nextSections);if(retained!==next){add(nextSections);retained=next;admissions++;}}
      return {hasProjections,previewSeedMarker:previewEvents[before.length]?.type,
        originalPrefixUnchanged:hash(after.slice(0,before.length))===prefix,
        liveAddedNoSeed:after.slice(before.length).every(e=>e.type!=='session/end-seed'),
        attribution:committed.replacements.every(r=>after[r.seq].sourceEventSeqs.length===1&&after[r.seq].sourceEventSeqs[0]===r.sourceSeq),
        latestLast,preservedProviders,oneAfterCommit,zeroAfterClear,admissions,ownedAfterAdmission:owned()};
    })()`;
    const result = await evaluate(expression);
    assert.deepEqual(result, { hasProjections: true, previewSeedMarker: 'session/end-seed', originalPrefixUnchanged: true,
      liveAddedNoSeed: true, attribution: true, latestLast: true, preservedProviders: true, oneAfterCommit: true,
      zeroAfterClear: true, admissions: 1, ownedAfterAdmission: 1 });
  });
