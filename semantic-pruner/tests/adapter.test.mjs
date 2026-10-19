import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticPrunerEngine, pressureQualifies } from '../lib/index.mjs';

const cpLength = text => Array.from(text).length;
const LONG_TEXT = 'routine line\n'.repeat(700) + 'critical=TESTONLY-123\n';
const REF = { locator: 'spill:test-only', retrievalHint: 'read via fake spill store', bytes: 9000 };

class FakeBase {
  constructor(ctx, input = {}) {
    this.ctx = ctx;
    ctx.basicInput = input;
    this.config = { thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16,
      maxTokens: 1000, modelPolicies: [], ...input };
  }
  async compactIfNeeded(agent, trigger, signal) {
    this.ctx.superCalls.push({ agent, trigger, signal, nodes: [...agent.session.surface.nodes] });
    if (this.ctx.superError) throw this.ctx.superError;
    return this.ctx.superResult;
  }
}

function makeSession(content = [{ type: 'text', text: LONG_TEXT }]) {
  const original = { role: 'tool', source: { kind: 'tool', callId: 'call-test' },
    id: 'original-message', toolCallId: 'call-test', isError: false, content };
  const events = new Map([
    [0, { seq: 0, type: 'session', data: {} }],
    [1, { seq: 1, type: 'user/message', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the recovery task.' }],
    } }],
    [2, { seq: 2, type: 'tool/call', data: { callId: 'call-test', name: 'read-audit' } }],
    [3, { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      turn: 7, step: 9, extraField: { preserved: true }, message: original,
    } }],
  ]);
  const session = {
    id: 'synthetic-adapter-session', seq: 4,
    header: { config: { provider: 'current-provider', model: 'current-model',
      reasoningEffort: 'max', maxTokens: 1000 } },
    surface: { nodes: [1, 3], replaceGeneration: 0 }, events, appended: [],
    requestHeader() { return this.header; },
    eventAt(seq) { return events.get(seq); },
    deriveEventMessage(event) { return event.data.message; },
    append(type, data, options = {}) {
      if (this.failAppendType === type) throw this.appendError;
      const event = { seq: this.seq++, type, data, ...options };
      events.set(event.seq, event);
      this.appended.push(event);
      if (options.surfaceOp?.op === 'replace') {
        const first = this.surface.nodes.indexOf(options.surfaceOp.startSeq);
        const last = this.surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(first >= 0 && last >= first, 'replacement must cite live surface nodes');
        this.surface.nodes.splice(first, last - first + 1, event.seq);
        this.surface.replaceGeneration += 1;
      }
      return event;
    },
  };
  return session;
}

function harness({ select, content, config = {}, totalTokens = 8000, useRealSelect = false } = {}) {
  const session = makeSession(content);
  const agent = { session, options: { provider: 'stale-agent-provider', model: 'stale-agent-model' } };
  const ctx = {
    totalTokens, superCalls: [], superResult: { unchangedBaseResult: true },
    resolved: [], spilled: [], streamed: [], estimates: [], warnings: [],
    logger: { warn(message) { ctx.warnings.push(message); } },
    llm: {
      async resolveModelInfo(...args) {
        ctx.resolved.push(args);
        if (ctx.resolveError) throw ctx.resolveError;
        return ctx.info;
      },
      async *stream(request) {
        ctx.streamed.push(request);
        for (const chunk of ctx.streamChunks ?? [
          { type: 'text-delta', index: 0, text: '[{"start":0,"end":0,"priority":5}]' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]) yield chunk;
      },
    },
    info: { context: { contextWindow: 10000 }, defaultMaxTokens: 1000,
      reasoning: { efforts: [{ id: 'low' }, { id: 'max' }] } },
    tokenMeter: {
      measure() { return { totalTokens: ctx.totalTokens }; },
      estimateMessage(message) { ctx.estimates.push(message); return 2222; },
    },
    spillStore: {
      async saveText(input) {
        ctx.spilled.push(input);
        if (ctx.spillError) throw ctx.spillError;
        return REF;
      },
    },
    get(name) { return this[name]; },
  };
  const selections = [];
  const selectImpl = select ?? (async (text, options) => {
    selections.push({ text, options });
    return { changed: true, text: 'critical=TESTONLY-123\n[Full original: spill:test-only]',
      reason: 'selected', stats: { inputChars: cpLength(text), outputChars: 54 } };
  });
  const Engine = useRealSelect ? createSemanticPrunerEngine(FakeBase)
    : createSemanticPrunerEngine(FakeBase, { select: selectImpl });
  const engine = new Engine(ctx, config);
  return { ctx, session, agent, engine, selections };
}

function assertOneSuper(h, trigger, signal) {
  assert.equal(h.ctx.superCalls.length, 1);
  assert.equal(h.ctx.superCalls[0].agent, h.agent);
  assert.equal(h.ctx.superCalls[0].trigger, trigger);
  assert.equal(h.ctx.superCalls[0].signal, signal);
}

test('factory imports offline and strips only semantic settings before the original base', () => {
  const h = harness({ config: { headroomTokens: 1234, semantic: { targetChars: 5000 } } });
  assert.deepEqual(h.ctx.basicInput, { headroomTokens: 1234 });
  assert.equal(h.engine.semanticConfig.targetChars, 5000);
  assert.throws(() => harness({ config: { semantic: { unknown: 1 } } }), /Unknown semantic setting/);
});

test('pressure gate matches output reservation, exact target policy and retained-tail validity', () => {
  const config = { thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, modelPolicies: [] };
  const target = { provider: 'p', model: 'm', maxTokens: 1000 };
  const info = { context: { contextWindow: 10000 }, defaultMaxTokens: 5000 };
  assert.equal(pressureQualifies(config, target, info, 7999), false);
  assert.equal(pressureQualifies(config, target, info, 8000), true);
  assert.equal(pressureQualifies(config, { ...target, maxTokens: 3000 }, info, 5999), false);
  assert.equal(pressureQualifies(config, { ...target, maxTokens: 3000 }, info, 6000), true);
  assert.equal(pressureQualifies(config, { provider: 'p', model: 'm' }, info, 4000), true);
  const overridden = { ...config, retainTokens: 9000,
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5, retainRatio: 0.1 }] };
  assert.equal(pressureQualifies(overridden, target, info, 5000), true);
  assert.equal(pressureQualifies({ ...config, retainTokens: 8000 }, target, info, 9000), false);
  assert.equal(pressureQualifies(config, target, {}, 9000), false);
});

test('below pressure threshold leaves the result untouched and calls the original base once', async () => {
  const h = harness({ totalTokens: 7999 });
  const signal = new AbortController().signal;
  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', signal);
  assert.equal(result, h.ctx.superResult);
  assertOneSuper(h, 'pressure', signal);
  assert.equal(h.ctx.spilled.length, 0);
  assert.equal(h.selections.length, 0);
  assert.equal(h.session.appended.length, 0);
});

test('successful prepass preserves metadata, spill source and durable replacement contract', async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const before = h.session.eventAt(3);
  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', signal);
  assert.equal(result, h.ctx.superResult);
  assertOneSuper(h, 'pressure', signal);
  assert.equal(h.ctx.spilled.length, 1);
  assert.equal(h.ctx.spilled[0].content, LONG_TEXT);
  assert.equal(h.ctx.spilled[0].source.toolName, 'read-audit');
  assert.equal(h.ctx.spilled[0].owner.sessionId, h.session.id);
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0].options.targetChars, 5159);
  assert.ok(h.selections[0].options.sourceRef.includes(REF.locator));
  assert.deepEqual(h.session.appended.map(event => event.type), ['compaction/prune', 'tool/result']);
  const [price, replacement] = h.session.appended;
  assert.deepEqual(price.data, { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 2222 });
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 });
  assert.deepEqual(replacement.sourceEventSeqs, [3]);
  assert.equal(replacement.data.turn, before.data.turn);
  assert.equal(replacement.data.step, before.data.step);
  assert.equal(replacement.data.extraField, before.data.extraField);
  assert.deepEqual({ ...replacement.data.message, content: before.data.message.content }, before.data.message);
  assert.equal(before.data.message.content[0].text, LONG_TEXT);
  assert.ok(!h.session.surface.nodes.includes(3));
  assert.equal(h.ctx.superCalls[0].nodes.at(-1), replacement.seq);
});

test('current durable route drives model capability lookup and the actual selection request', async () => {
  const h = harness({ select: async (_text, options) => {
    const ranges = await options.judge({ items: [{ index: 0, text: 'source', start: 0, end: 6 }],
      chunkIndex: 0, chunkCount: 1, targetChars: 5159, signal: options.signal });
    assert.deepEqual(ranges, [{ start: 0, end: 0, priority: 5 }]);
    return { changed: false, reason: 'test-route-only' };
  } });
  await h.engine.compactIfNeeded(h.agent, 'pressure');
  assert.equal(h.ctx.resolved[0][0], 'current-provider');
  assert.equal(h.ctx.resolved[0][1], 'current-model');
  assert.equal(h.ctx.streamed.length, 1);
  const request = h.ctx.streamed[0];
  assert.equal(request.provider, 'current-provider');
  assert.equal(request.model, 'current-model');
  assert.equal(request.purpose, 'compaction');
  assert.equal(request.maxTokens, 8192);
  assert.deepEqual(request.tools, []);
  assert.equal(request.reasoningEffort, 'low');
  assert.equal(request.sessionId, h.session.id);
  assert.ok(JSON.parse(request.messages[1].content[0].text).taskContext.includes('recovery'));
  assertOneSuper(h, 'pressure');
});

test('context-overflow bypasses only the pressure threshold and still delegates downstream', async () => {
  const h = harness({ totalTokens: 0 });
  await h.engine.compactIfNeeded(h.agent, 'context-overflow');
  assert.equal(h.selections.length, 1);
  assertOneSuper(h, 'context-overflow');
});

test('missing route, missing spill service, old cropper and under-threshold text skip selection', async () => {
  for (const change of [
    h => { h.session.header = undefined; },
    h => { h.ctx.spillStore = undefined; },
    h => { h.ctx.toolResultPruner = {}; },
    h => { h.session.eventAt(3).data.message.content = [{ type: 'text', text: 'small' }]; },
  ]) {
    const h = harness();
    change(h);
    await h.engine.compactIfNeeded(h.agent, 'pressure');
    assert.equal(h.selections.length, 0);
    assert.equal(h.session.appended.length, 0);
    assertOneSuper(h, 'pressure');
  }
});

test('active durable compaction defers unchanged to the original base', async () => {
  const h = harness();
  h.session.append('compaction/start', { compactionId: 'already-active', turn: 7 });
  h.session.appended.length = 0;
  await h.engine.compactIfNeeded(h.agent, 'pressure');
  assert.equal(h.ctx.resolved.length, 0);
  assert.equal(h.ctx.spilled.length, 0);
  assert.equal(h.session.appended.length, 0);
  assertOneSuper(h, 'pressure');
});

test('model lookup, spill or selection failure never substitutes a fixed crop', async () => {
  const secretError = new Error('private transport details must not enter warnings');
  const variants = [
    harness({ select: async () => { throw secretError; } }),
    harness(), harness(),
  ];
  variants[1].ctx.resolveError = secretError;
  variants[2].ctx.spillError = secretError;
  for (const h of variants) {
    await h.engine.compactIfNeeded(h.agent, 'pressure');
    assert.equal(h.session.appended.length, 0);
    assert.equal(h.session.eventAt(3).data.message.content[0].text, LONG_TEXT);
    assertOneSuper(h, 'pressure');
    assert.ok(h.ctx.warnings.every(message => !message.includes('private transport')));
  }
});

test('invalid or over-budget selection leaves the original surface intact', async () => {
  for (const selected of [
    { changed: false, reason: 'no-candidates' },
    { changed: true, text: '' },
    { changed: true, text: 'x'.repeat(5160) },
    { changed: true, text: 123 },
  ]) {
    const h = harness({ select: async () => selected });
    await h.engine.compactIfNeeded(h.agent, 'pressure');
    assert.equal(h.session.appended.length, 0);
    assertOneSuper(h, 'pressure');
  }
});

test('surface replacement or a changed candidate during async selection rejects stale results', async () => {
  for (const mutate of [
    h => { h.session.surface.replaceGeneration += 1; },
    h => { h.session.surface.nodes = [1]; },
    h => { h.session.eventAt(3).data.message = { ...h.session.eventAt(3).data.message, id: 'new-message' }; },
    h => { h.session.append('compaction/start', { compactionId: 'late-lock' }); },
  ]) {
    let h;
    h = harness({ select: async () => {
      mutate(h);
      return { changed: true, text: 'stale selected text' };
    } });
    await h.engine.compactIfNeeded(h.agent, 'pressure');
    assert.equal(h.session.appended.filter(event => event.type === 'compaction/prune').length, 0);
    assert.equal(h.session.appended.filter(event => event.type === 'tool/result').length, 0);
    assertOneSuper(h, 'pressure');
  }
});

test('turn cancellation before or during selection prevents replacement and downstream work', async () => {
  for (const preAborted of [true, false]) {
    const controller = new AbortController();
    const reason = new Error('test cancellation');
    const h = harness({ select: async () => {
      controller.abort(reason);
      return { changed: true, text: 'must not commit' };
    } });
    if (preAborted) controller.abort(reason);
    await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure', controller.signal), error => error === reason);
    assert.equal(h.session.appended.length, 0);
    assert.equal(h.ctx.superCalls.length, 0);
  }
});

test('rich content keeps order for one text block and skips ambiguous interleaved multi-text', async () => {
  const image = { type: 'image', url: 'synthetic:image', mimeType: 'image/png' };
  const one = harness({ content: [image, { type: 'text', text: LONG_TEXT }] });
  await one.engine.compactIfNeeded(one.agent, 'pressure');
  const replacement = one.session.appended.find(event => event.type === 'tool/result');
  assert.equal(replacement.data.message.content[0], image);
  const multi = harness({ content: [{ type: 'text', text: LONG_TEXT }, image, { type: 'text', text: 'tail' }] });
  await multi.engine.compactIfNeeded(multi.agent, 'pressure');
  assert.equal(multi.selections.length, 0);
  assert.equal(multi.session.appended.length, 0);
});

test('durable commit failure propagates and cannot silently continue with a shadow-price-only event', async () => {
  const h = harness();
  const failure = new Error('synthetic storage failure');
  h.session.failAppendType = 'tool/result';
  h.session.appendError = failure;
  await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure'), error => error === failure);
  assert.equal(h.ctx.superCalls.length, 0);
  assert.deepEqual(h.session.appended.map(event => event.type), ['compaction/prune']);
  assert.ok(h.session.surface.nodes.includes(3));
});

test('downstream errors remain the original base error without retries', async () => {
  const h = harness({ totalTokens: 0 });
  const failure = new Error('base failure');
  h.ctx.superError = failure;
  await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure'), error => error === failure);
  assertOneSuper(h, 'pressure');
});

test('real core/select/adapter pipeline uses bounded fake model calls and lands one replacement', async () => {
  const h = harness({ useRealSelect: true });
  await h.engine.compactIfNeeded(h.agent, 'pressure');
  assert.equal(h.ctx.streamed.length, 2);
  for (const request of h.ctx.streamed) {
    const payload = JSON.parse(request.messages[1].content[0].text);
    assert.ok(cpLength(payload.items.map(item => item.text).join('')) <= 8192);
    assert.equal(request.provider, 'current-provider');
    assert.equal(request.model, 'current-model');
  }
  const replacement = h.session.appended.find(event => event.type === 'tool/result');
  assert.ok(replacement);
  const output = replacement.data.message.content[0].text;
  assert.ok(cpLength(output) <= 5159);
  assert.ok(output.includes('Full original: spill:test-only'));
  assertOneSuper(h, 'pressure');
});

test('actual model parser fails closed for truncation, tool calls, rich blocks or non-JSON text', async () => {
  for (const streamChunks of [
    [{ type: 'text-delta', index: 0, text: '[]' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
    [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'block-start', index: 1, blockType: 'image' },
      { type: 'block-end', index: 1, block: { type: 'image', url: 'synthetic:image' } },
      { type: 'text-delta', index: 0, text: '[{"start":0,"end":0,"priority":5}]' },
      { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', index: 0, text: 'not JSON' }, { type: 'finish', reason: { kind: 'stop' } }],
  ]) {
    const h = harness({ useRealSelect: true });
    h.ctx.streamChunks = streamChunks;
    await h.engine.compactIfNeeded(h.agent, 'pressure');
    assert.equal(h.ctx.streamed.length, 1);
    assert.equal(h.session.appended.length, 0);
    assert.equal(h.session.eventAt(3).data.message.content[0].text, LONG_TEXT);
    assertOneSuper(h, 'pressure');
  }
});
