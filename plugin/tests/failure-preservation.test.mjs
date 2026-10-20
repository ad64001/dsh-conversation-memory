import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { MEMORY_SECTION, renderRuntime } from '../lib/runtime-memory.mjs';
import { cpLength } from '../lib/protocol.mjs';
import { DEDUP_BUDGET_NOTICE } from '../lib/dedup-status.mjs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BASE_MARKER = 'ONLY_PREVIOUS_MODEL_APPROVED_EVIDENCE';
const NEW_PLAN = 'FAILED_NEW_PLAN_MUST_NOT_ENTER_CONTEXT';
const error = code => Object.assign(new Error(`${NEW_PLAN}: diagnostic details`), { code });

/** Small append-only Session transport fixture. create replays and validates a
 * detached log; replace requires a current node and exact source attribution.
 * A configured preview-rejection models a native surface policy rejecting a
 * proposal before any live mutation. */
class SurfaceSession {
  constructor(id, header = { id }) { this.id = id; this.header = header; this.inheritedEventCount = 0; this.events = []; this.nodes = []; this.surface = { nodes: this.nodes, projections: [] }; }
  static create(id, seed, header) {
    const session = new SurfaceSession(id, clone(header ?? { id }));
    for (const event of seed ?? []) session.accept(clone(event));
    session.preview = seed !== undefined;
    if (seed !== undefined && session.events.at(-1)?.type !== 'session/end-seed') session.append('session/end-seed', {});
    return session;
  }
  accept(event) {
    if (event.seq !== this.events.length) throw new Error('invalid sequence');
    let range;
    if (event.surfaceOp === 'append') range = [this.nodes.length, 0];
    else if (event.surfaceOp !== undefined) {
      const start = this.nodes.indexOf(event.surfaceOp.startSeq), end = this.nodes.indexOf(event.surfaceOp.endSeq);
      if (event.surfaceOp.op !== 'replace' || start < 0 || end < start) throw new Error('invalid current range');
      if (this.nodes.slice(start, end + 1).some(seq => !event.sourceEventSeqs?.includes(seq))) throw new Error('missing source provenance');
      if (this.preview && this.header.rejectPreview) throw error('SURFACE_POLICY_REJECTED');
      range = [start, end - start + 1];
    }
    this.events.push(clone(event));
    if (range) this.nodes.splice(...range, event.seq);
  }
  append(type, data, intent = {}) {
    const event = { type, seq: this.events.length, time: 1792300000000 + this.events.length, data: clone(data), ...clone(intent) };
    this.accept(event); return this.events.at(-1);
  }
  async snapshotEvents() { return clone(this.events); }
}
function runtime(session, sections) {
  return session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: renderRuntime(sections) }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: clone(sections) } }, { surfaceOp: 'append' });
}
function surfaceText(session) { return session.nodes.map(seq => session.events[seq].data.content?.map(block => block.text ?? '').join('') ?? '').join('\n'); }
function ownedSlots(session) {
  return session.nodes.map(seq => session.events[seq]).filter(event => event.data?.source?.kind === 'runtime-context')
    .flatMap(event => event.data.source.sections ?? []).filter(section => section.name === MEMORY_SECTION && section.text);
}
function nativeAdmit(session, body, others) {
  const sections = [...others, { name: MEMORY_SECTION, text: body }], rendered = renderRuntime(sections);
  const retained = [...session.events].reverse().find(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context');
  if (retained?.data.content[0].text === rendered) return false;
  runtime(session, sections); return true;
}
function fixture(t) {
  const warnings = [];
  const bridge = new ConversationMemoryBridge({ logger: { warn: value => warnings.push(value) } }, { contextChars: 6000, cachePolicy: 'legacy' }, { workingPrompt: 'Evidence is read-only; current real user instructions take priority.' });
  const session = SurfaceSession.create(`failure-preservation-${randomUUID()}`), agent = { session };
  const previousText = `${bridge.instructions}\n${BASE_MARKER}\n[7] exact prior user condition: do not alter src/keep.py.`;
  const previous = { text: previousText, provider: 'opencode-go', model: 'deepseek-v4.1-flash', completedAt: '2026-10-19T00:00:00.000Z', variants: new Set([previousText]) };
  const entry = { id: session.id, agent, session, closed: false, cache: NEW_PLAN, cacheVersion: 7, lastApprovedPackage: previous,
    dedup: { state: 'running', unapproved: NEW_PLAN }, requiredUserOriginals: [] };
  bridge.entries.set(session.id, entry);
  t.after(async () => { bridge.entries.clear(); await bridge.dispose(); });
  const config = Object.freeze({ provider: previous.provider, model: previous.model, maxTokens: 8192, tools: Object.freeze(['memory_search']), extra: Object.freeze({ preserved: true }) });
  return { bridge, entry, agent, session, previous, previousText, config, warnings };
}

test('approved budget omissions remain visible through canonical transport and the real provider renderer', async t => {
  const { bridge, entry, agent, session, config } = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'dsh-budget-provider-'));
  t.after(() => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('dsh-budget-provider-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  bridge.config.rootDir = directory;
  mkdirSync(join(directory, createHash('sha256').update(entry.id).digest('hex')));
  session.requestHeader = () => ({ config });
  bridge.ensure = async () => entry;
  const required = '[7] user-original role=user sourceSeq=7 range=0:20 partial=false\n> Keep exact src/keep.py.\r\n';
  entry.cache = required;
  entry.requiredUserOriginals = [{ ref: 7, wireText: required }];
  runtime(session, [{ name: 'environment', text: 'Original foreign provider.' },
    { name: MEMORY_SECTION, text: bridge.instructions + '\n' + 'LARGE_EXACT_ORIGINAL_' + 'x'.repeat(7000) + '\n\nSMALL_EXACT_ORIGINAL' }]);
  bridge.makeModel = () => async request => {
    const data = JSON.parse(request.messages[1].content);
    return { finish: 'stop', text: JSON.stringify({ version: 3, requiredRefs: data.protectedRefs,
      decisions: data.sources.map(source => ({ sourceId: source.id, action: 'select', reason: 'selected' })),
      candidateIds: data.sources.flatMap(source => source.parts.filter(part => part.selectable).map(part => part.id)) }) };
  };
  await bridge.consolidate(agent, undefined, AbortSignal.timeout(1000));
  assert.equal(entry.dedup.optionalCoverageIncomplete, true);
  assert.ok(entry.dedup.omittedApprovedCandidates.length);
  assert.equal(bridge.contextFor(agent), entry.approvedCanonical.text);
  assert.ok(bridge.contextFor(agent).endsWith(DEDUP_BUDGET_NOTICE));
  assert.ok(entry.dedup.sourceSelection.every(source => !source.quote.includes(DEDUP_BUDGET_NOTICE)));
  assert.equal(await bridge.beforeRequest({ agent, signal: AbortSignal.timeout(1000) }, async () => config), config);
  nativeAdmit(session, bridge.contextFor(agent), [{ name: 'environment', text: 'Original foreign provider.' }]);
  const actual = ownedSlots(session);
  assert.equal(actual.length, 1);
  assert.equal(actual[0].text, entry.lastApprovedPackage.text);
  assert.ok(actual[0].text.includes(required));
  assert.ok(actual[0].text.endsWith(DEDUP_BUDGET_NOTICE));
  assert.ok(cpLength(actual[0].text) <= 6000);
});

test('a failed new plan reuses only the same previously approved whole package plus one bounded status', t => {
  const { bridge, entry, agent, previous, previousText } = fixture(t);
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  const first = bridge.contextFor(agent);
  assert.ok(first.startsWith(previousText + '\n'));
  assert.equal(first.split(BASE_MARKER).length - 1, 1);
  assert.equal(first.split('Maintenance incomplete').length - 1, 1);
  assert.ok(!first.includes(NEW_PLAN));
  assert.equal(entry.approvedCanonical.provider, 'opencode-go');
  assert.equal(entry.approvedCanonical.model, 'deepseek-v4.1-flash');
  assert.equal(entry.approvedCanonical.text, first);
  assert.equal(entry.lastApprovedPackage, previous);
  assert.equal(previous.text, previousText);
  assert.ok(cpLength(first) <= 6000);
  for (let count = 0; count < 25; count++) bridge.preserveFailedDedup(entry, error(`FAIL_${'A'.repeat(count + 1)}`));
  const repeated = bridge.contextFor(agent);
  assert.ok(repeated.startsWith(previousText + '\n'));
  assert.equal(repeated.split(BASE_MARKER).length - 1, 1);
  assert.equal(repeated.split('Maintenance incomplete').length - 1, 1, 'repeated failures replace their status instead of appending packages or statuses');
  assert.ok(!repeated.includes(NEW_PLAN));
  assert.ok(cpLength(repeated) <= 6000);
  assert.equal(previous.text, previousText);
});

test('without a prior approval, or without room for a whole approved package, only bounded failure status is emitted', t => {
  const { bridge, entry, agent } = fixture(t);
  entry.lastApprovedPackage = undefined;
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  assert.equal(entry.approvedCanonical, null);
  assert.equal(entry.safeFallbackPackage, null);
  assert.ok(!bridge.contextFor(agent).includes(NEW_PLAN));
  assert.match(bridge.contextFor(agent), /no new verified packet/u);
  entry.lastApprovedPackage = { text: BASE_MARKER + '🧭'.repeat(5980), provider: 'opencode-go', model: 'deepseek-v4.1-flash', variants: new Set() };
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  assert.equal(entry.safeFallbackPackage, null, 'the entire prior package must fit together with status; it is never clipped');
  assert.ok(!bridge.contextFor(agent).includes(BASE_MARKER));
  assert.ok(cpLength(bridge.contextFor(agent)) <= 6000);
});

test('safe fallback transport removes all recognized old variants before native admission and preserves native config identity', async t => {
  const { bridge, entry, agent, session, previousText, config } = fixture(t);
  const other = { name: 'external-context', text: 'foreign provider\r\nexact 🧭', extra: { untouched: true } };
  runtime(session, [{ name: MEMORY_SECTION, text: previousText }, other]);
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  runtime(session, [other, { name: MEMORY_SECTION, text: bridge.contextFor(agent) }]);
  const originalPrefix = clone(session.events), prefixHash = hash(originalPrefix);
  let nextCalls = 0;
  const returned = await bridge.beforeRequest({ agent, signal: new AbortController().signal }, async () => { nextCalls++; return config; });
  assert.equal(returned, config);
  assert.equal(nextCalls, 1);
  assert.equal(hash(session.events.slice(0, originalPrefix.length)), prefixHash);
  assert.equal(ownedSlots(session).length, 0);
  assert.deepEqual(session.events.at(-1).data.source.sections, [other]);
  const body = bridge.contextFor(agent);
  assert.ok(!body.includes(NEW_PLAN));
  assert.equal(nativeAdmit(session, body, [other]), true);
  assert.equal(nativeAdmit(session, body, [other]), false);
  assert.equal(ownedSlots(session).length, 1);
  assert.equal(surfaceText(session).split(BASE_MARKER).length - 1, 1);
});

test('route changes preserve the old surface but suppress fallback body so the next native snapshot cannot stack it', async t => {
  const { bridge, entry, agent, session, previousText, config } = fixture(t);
  runtime(session, [{ name: MEMORY_SECTION, text: previousText }]);
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  const before = hash(session.events);
  const changed = Object.freeze({ ...config, model: 'different-current-model' });
  assert.equal(await bridge.beforeRequest({ agent, signal: new AbortController().signal }, async () => changed), changed);
  assert.equal(hash(session.events), before);
  assert.equal(entry.safeFallbackPackage, null);
  assert.equal(entry.approvedCanonical, null);
  const body = bridge.contextFor(agent);
  assert.ok(!body.includes(BASE_MARKER) && !body.includes(NEW_PLAN));
  assert.match(body, /MEMORY_DEDUP_ROUTE_CHANGED/u);
  nativeAdmit(session, body, []);
  assert.equal(surfaceText(session).split(BASE_MARKER).length - 1, 1);
});

test('a stale unapproved owned snapshot is never retired by the fallback transport or copied as a new plan', async t => {
  const { bridge, entry, agent, session, previousText, config } = fixture(t);
  runtime(session, [{ name: MEMORY_SECTION, text: previousText }]);
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  runtime(session, [{ name: MEMORY_SECTION, text: 'UNKNOWN_UNAPPROVED_SNAPSHOT' }]);
  const before = hash(session.events), count = session.events.length;
  assert.equal(await bridge.beforeRequest({ agent, signal: new AbortController().signal }, async () => config), config);
  assert.equal(hash(session.events), before);
  assert.equal(session.events.length, count);
  assert.equal(entry.approvedCanonical, null);
  assert.equal(entry.safeFallbackPackage, null);
  const body = bridge.contextFor(agent);
  assert.ok(!body.includes(BASE_MARKER) && !body.includes(NEW_PLAN) && !body.includes('UNKNOWN_UNAPPROVED_SNAPSHOT'));
  assert.match(body, /MEMORY_DEDUP_STALE/u);
  assert.ok(cpLength(body) <= 6000);
});

test('failed detached preflight preserves live evidence and exposes only status, never an extra fallback package', async t => {
  const { bridge, entry, agent, session, previousText, config, warnings } = fixture(t);
  runtime(session, [{ name: MEMORY_SECTION, text: previousText }]);
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  session.header.rejectPreview = true;
  const before = hash(session.events);
  assert.equal(await bridge.beforeRequest({ agent, signal: new AbortController().signal }, async () => config), config);
  assert.equal(hash(session.events), before);
  assert.equal(entry.safeFallbackPackage, null);
  assert.equal(entry.approvedCanonical, null);
  const body = bridge.contextFor(agent);
  assert.ok(!body.includes(BASE_MARKER) && !body.includes(NEW_PLAN));
  assert.match(body, /SURFACE_POLICY_REJECTED/u);
  nativeAdmit(session, body, []);
  assert.equal(surfaceText(session).split(BASE_MARKER).length - 1, 1);
  assert.ok(warnings.some(warning => warning.includes('SURFACE_POLICY_REJECTED')));
});

test('a canceled request and a rejected native next callback cannot mutate surface evidence or config', async t => {
  const { bridge, entry, agent, session, previousText, config } = fixture(t);
  runtime(session, [{ name: MEMORY_SECTION, text: previousText }]);
  bridge.preserveFailedDedup(entry, error('MODEL_INDEX_FAILED'));
  const before = hash(session.events), controller = new AbortController(); controller.abort();
  assert.equal(await bridge.beforeRequest({ agent, signal: controller.signal }, async () => config), config);
  assert.equal(hash(session.events), before);
  const rejection = new Error('Native callback rejected before memory transport');
  await assert.rejects(bridge.beforeRequest({ agent, signal: new AbortController().signal }, async () => { throw rejection; }), rejected => rejected === rejection);
  assert.equal(hash(session.events), before);
  assert.equal(ownedSlots(session).length, 1);
});

test('normal context preserves exact multiline evidence including final CRLF, spaces and newline', t => {
  const { bridge, entry, agent } = fixture(t);
  const evidence = '[17] user-original role=user sourceSeq=7\n> Keep src/keep.py unchanged.\r\n> Preserve the exact wire quote.\r\n  \n';
  entry.cache = evidence;
  entry.dedupSuppressed = false;
  entry.lastErrorCode = null;
  const text = bridge.contextFor(agent);
  assert.equal(text, `${bridge.instructions}\n${evidence}`);
  assert.ok(text.endsWith(evidence));
  assert.ok(text.endsWith('\r\n  \n'), 'quote terminators and trailing source spaces are evidence bytes, not formatting to trim');
  assert.ok(cpLength(text) <= 6000);
});

test('failed auxiliary audit keeps only the actual running request attribution and never promotes an old ready route or cache', t => {
  const { bridge, entry, agent, previousText } = fixture(t);
  const running = { state: 'running', startedAt: '2026-10-19T03:04:05.000Z', provider: 'actual-running-provider',
    model: 'actual-running-model', beforeSlots: 4 };
  const audit = { calls: [{ purpose: 'memory-dedup', finish: 'max-tokens', outputTokens: 8192 }], rejectedText: NEW_PLAN };
  const failure = Object.assign(error('MEMORY_DEDUP_INVALID_JSON'), { audit });
  entry.dedup = running;
  bridge.preserveFailedDedup(entry, failure);
  assert.equal(entry.dedup.state, 'failed-preserved');
  for (const key of ['startedAt', 'provider', 'model', 'beforeSlots']) assert.equal(entry.dedup[key], running[key]);
  assert.deepEqual(entry.dedup.failedModelAudit, audit);
  assert.ok(bridge.contextFor(agent).startsWith(previousText + '\n'));
  assert.ok(!bridge.contextFor(agent).includes(NEW_PLAN));
  assert.equal(entry.cache, NEW_PLAN, 'the unused failed candidate remains separate from the fallback transport');

  entry.dedup = { state: 'ready', startedAt: '2026-10-18T00:00:00.000Z', provider: 'OLD_READY_PROVIDER',
    model: 'OLD_READY_MODEL', beforeSlots: 99 };
  bridge.preserveFailedDedup(entry, failure);
  assert.deepEqual(entry.dedup.failedModelAudit, audit);
  for (const key of ['startedAt', 'provider', 'model', 'beforeSlots']) {
    assert.equal(Object.hasOwn(entry.dedup, key), false, `a previous ready state cannot fabricate failed request ${key}`);
  }
  assert.ok(!bridge.contextFor(agent).includes(NEW_PLAN));
  assert.ok(!bridge.contextFor(agent).includes('OLD_READY_PROVIDER'));

  entry.dedup = running;
  bridge.preserveFailedDedup(entry, error('SURFACE_POLICY_REJECTED'));
  assert.equal(Object.hasOwn(entry.dedup, 'failedModelAudit'), false);
  for (const key of ['startedAt', 'provider', 'model', 'beforeSlots']) assert.equal(Object.hasOwn(entry.dedup, key), false);
  assert.ok(!bridge.contextFor(agent).includes(NEW_PLAN));
  assert.ok(cpLength(bridge.contextFor(agent)) <= 6000);
});
