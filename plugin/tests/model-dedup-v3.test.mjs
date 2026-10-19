import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planMemoryDedup, DEDUP_LIMITS, DEDUP_PROMPT } from '../lib/model-dedup.mjs';
import { partitionDedupSource } from '../lib/dedup-candidates.mjs';

const cp = value => Array.from(value).length;
const sha = value => createHash('sha256').update(value).digest('hex');
const dataOf = request => JSON.parse(request.messages[1].content);
const fixture = overrides => ({ snapshots: [{ id: 'old', text: '[2] source role=assistant sourceSeq=2\n> stale batch_size=64\n' }],
  current: { id: 'current', text: '[9] user-original role=user sourceSeq=9\n> correction: batch_size=128; dry_run=true.\n' },
  required: [{ ref: 9, text: '[9] user-original role=user sourceSeq=9\n> correction: batch_size=128; dry_run=true.\n' }],
  task: 'Continue the same staging recovery.', maxChars: 2048,
  model: async request => response(dataOf(request)), ...overrides });
function response(data, candidateIds = [], requiredRefs = data.required.map(unit => unit.ref)) {
  const selected = new Set(data.sources.filter(source => source.parts.some(part => candidateIds.includes(part.id))).map(source => source.id));
  if (requiredRefs.length) selected.add('current');
  return { finish: 'stop', text: JSON.stringify({ version: 3, requiredRefs,
    decisions: data.sources.map(source => ({ sourceId: source.id, action: selected.has(source.id) ? 'select' : 'retire',
      reason: selected.has(source.id) ? 'selected' : 'duplicate' })), candidateIds }) };
}
const reject = (input, code) => assert.rejects(planMemoryDedup(input), error => error.code === code);

test('user-authorized dedup deadlines share one bounded limit object without changing evidence or output budgets', () => {
  assert.equal(DEDUP_LIMITS.callTimeoutMs, 180000);
  assert.equal(DEDUP_LIMITS.planTimeoutMs, 300000);
  assert.ok(DEDUP_LIMITS.callTimeoutMs < DEDUP_LIMITS.planTimeoutMs, 'the whole-plan deadline leaves time beyond one call but remains finite');
  assert.equal(DEDUP_LIMITS.inputChars, 24000);
  assert.equal(DEDUP_LIMITS.chunkChars, 8192);
  assert.equal(DEDUP_LIMITS.backgroundChars, 1024);
  assert.equal(DEDUP_LIMITS.maxTokens, 16384);
  assert.equal(DEDUP_LIMITS.concurrency, 2);
  assert.equal(DEDUP_LIMITS.validationRetries, 1);
});

test('v3 sends source text once in lossless parts and asks for IDs rather than literal text or offsets', async () => {
  let data, reply;
  const input = fixture({ model: async request => {
    data = dataOf(request); reply = response(data); return reply;
  } });
  const result = await planMemoryDedup(input);
  assert.match(DEDUP_PROMPT, /^DSH_MEMORY_DEDUP_V3/);
  assert.ok(cp(DEDUP_PROMPT) < 2800);
  assert.match(DEDUP_PROMPT, /Do not count characters, locate offsets, copy quotes or fill space/);
  assert.match(DEDUP_PROMPT, /"requiredRefs": an ARRAY exactly confirming protectedRefs/);
  assert.match(DEDUP_PROMPT, /"decisions": an ARRAY with EXACTLY ONE object for EACH sources\[\]\.id/);
  assert.match(DEDUP_PROMPT, /Each object has EXACTLY THREE keys: "sourceId", "action", "reason"/);
  assert.match(DEDUP_PROMPT, /"candidateIds": an ARRAY of at most 32 unique actual eligible part ID STRINGS/);
  for (const source of data.sources) {
    assert.equal(source.text, undefined);
    assert.equal(source.parts.map(part => part.text).join(''), source.id === 'current' ? input.current.text : input.snapshots[0].text);
    for (const part of source.parts) {
      assert.equal(part.chars, cp(part.text)); assert.equal(part.start, undefined); assert.equal(part.sha256, undefined);
    }
  }
  assert.deepEqual(JSON.parse(reply.text).candidateIds, []);
  assert.equal(result.canonicalText, input.current.text);
  assert.equal(result.requestMetadata[0].responseVersion, 3);
  assert.deepEqual(result.requestMetadata[0].candidateIds, []);
  assert.deepEqual(result.sourceSelection[0].requiredRef, 9);
});

test('v3 model-selected candidate IDs map to exact original whitespace and Unicode provenance', async () => {
  const text = '[3] source role=tool sourceSeq=3\n> dependency😀: rebuild_reference_index(); checkpoint_nonce=n-123.\n';
  const result = await planMemoryDedup(fixture({ snapshots: [{ id: 'handoff', text }], model: async request => {
    const data = dataOf(request); return response(data, [data.sources[0].parts[0].id]);
  } }));
  const original = result.sourceSelection.find(selection => selection.sourceId === 'handoff');
  assert.equal(original.quote, text); assert.equal(original.start, 0); assert.equal(original.end, cp(text));
  assert.equal(original.sha256, sha(text));
  const metadata = result.requestMetadata[0], candidate = metadata.candidateUnits.find(unit => unit.id === metadata.candidateIds[0]);
  assert.equal(candidate.sourceId, 'handoff'); assert.equal(candidate.callSourceId, 'old-0:0-' + cp(text));
  assert.equal(candidate.sha256, original.sha256); assert.equal(candidate.end, original.end);
  assert.equal(result.canonicalText, `${fixture().current.text}\n\n${text}`);
});

test('v3 rejects invented, repeated, protected and ineligible candidate IDs without a partial plan', async () => {
  for (const variant of ['invented', 'repeat', 'required']) {
    await reject(fixture({ snapshots: [{ id: 'old', text: 'oversized '.repeat(600) }], model: async request => {
      const data = dataOf(request), old = data.sources[0].parts[0], required = data.sources.at(-1).parts.find(part => part.kind === 'required');
      const ids = variant === 'invented' ? ['unlisted'] : variant === 'repeat' ? [old.id, old.id]
        : variant === 'required' ? [required.id] : [old.id];
      return response(data, ids);
    } }), 'MEMORY_DEDUP_INVALID_SELECTION');
  }
});

test('v3 requires every typed protected ref and one honest decision for every source', async () => {
  for (const refs of [[], ['9'], [9, 9], [999]]) await reject(fixture({ model: async request => response(dataOf(request), [], refs) }), 'MEMORY_DEDUP_INVALID_REQUIRED_REFS');
  for (const mutation of ['unknown', 'missing', 'retired']) await reject(fixture({ model: async request => {
    const data = dataOf(request), output = JSON.parse(response(data).text);
    if (mutation === 'unknown') output.decisions[0].sourceId = 'unknown-source';
    if (mutation === 'missing') output.decisions.pop();
    if (mutation === 'retired') output.decisions[output.decisions.length - 1] = { sourceId: 'current', action: 'retire', reason: 'duplicate' };
    return { finish: 'stop', text: JSON.stringify(output) };
  } }), 'MEMORY_DEDUP_INVALID_PLAN');
});

test('large citation blocks expose full paragraphs with an explicit original-header dependency', async () => {
  const first = '> first condition: do not retry while lease_held=true. ' + 'a'.repeat(750) + '\n> \n';
  const second = '> second condition: only staging_only, nonce=n-123. ' + 'b'.repeat(750) + '\n';
  const old = '[4] source role=tool sourceSeq=40\n' + first + second;
  let captured;
  const result = await planMemoryDedup(fixture({ snapshots: [{ id: 'report', text: old }], model: async request => {
    captured = dataOf(request); const body = captured.sources[0].parts.find(part => part.text.includes('second condition'));
    return response(captured, [...body.contextIds, body.id]);
  } }));
  const parts = captured.sources[0].parts;
  assert.equal(parts.map(part => part.text).join(''), old);
  assert.equal(parts[0].kind, 'context');
  assert.ok(result.canonicalText.includes(parts[0].text)); assert.ok(result.canonicalText.includes(second));
  for (const mode of ['body-only', 'header-only']) await reject(fixture({ snapshots: [{ id: 'report', text: old }], model: async request => {
    const data = dataOf(request), body = data.sources[0].parts.find(part => part.text.includes('second condition'));
    return response(data, mode === 'body-only' ? [body.id] : body.contextIds);
  } }), 'MEMORY_DEDUP_INVALID_SELECTION');
});

test('candidate packaging never cuts oversized paragraphs or fenced code to manufacture a fitting snippet', () => {
  const long = 'Do not change max_tokens=4096 unless the original user condition changes. '.repeat(60);
  const code = '> ```js\n> const entity = "A😀";\n> \n> throw new Error("E_LEASE_HELD");\n> ```\n';
  const text = long + '\n> \n' + code;
  const parts = partitionDedupSource({ text });
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.ok(parts.some(part => part.text.includes(long)));
  assert.ok(parts.some(part => part.text.includes(code)));
  for (const part of parts) assert.equal(Array.from(text).slice(part.start, part.end).join(''), part.text);
});

test('V3 IDs distinguish identical literal paragraphs at separate original ranges without ambiguity', async () => {
  const repeated = 'same exact original\n\n' + 'noise '.repeat(150) + '\n\n' + 'same exact original\n\n';
  const result = await planMemoryDedup(fixture({ snapshots: [{ id: 'repeated', text: repeated }], model: async request => {
    const data = dataOf(request), matches = data.sources[0].parts.filter(part => part.text === 'same exact original\n\n');
    assert.equal(matches.length, 2); return response(data, [matches[1].id]);
  } }));
  const selected = result.sourceSelection.find(selection => selection.sourceId === 'repeated');
  assert.equal(selected.start, cp(repeated) - cp(selected.quote));
});

test('v3 fixed packing keeps required originals and audits model-approved blocks that cannot fit', async () => {
  const old = 'OPTIONAL exact original';
  const base = fixture(), maxChars = cp(base.current.text) + 2 + cp(old);
  const input = fixture({ snapshots: [{ id: 'old', text: old }], maxChars, model: async request => {
    const data = dataOf(request); return response(data, [data.sources[0].parts[0].id]);
  } });
  assert.equal(cp((await planMemoryDedup(input)).canonicalText), maxChars);
  const reduced = await planMemoryDedup({ ...input, maxChars: maxChars - 1 });
  assert.equal(reduced.canonicalText, base.current.text);
  assert.equal(reduced.optionalCoverageIncomplete, true);
  assert.equal(reduced.requestMetadata[0].approvedCandidateIds.length, 1);
  assert.equal(reduced.requestMetadata[0].candidateIds.length, 0);
  assert.deepEqual(reduced.requestMetadata[0].omittedApprovedIds, reduced.requestMetadata[0].approvedCandidateIds);
  assert.equal(reduced.decisions.find(decision => decision.slotId === 'old').action, 'select', 'a pure budget omission is never relabelled a model semantic retirement');
});

test('v3 map and sequential reduce preserve late original dependencies without quote copying', async () => {
  const late = 'LATE_DEPENDENCY: rebuild_reference_index(); checkpoint_nonce=late-123; staging_only.';
  const old = Array.from({ length: 60 }, (_, at) => `noise-${at}: ${'噪😀'.repeat(500)}\n\n`).join('') + '\n\n' + late;
  let maps = 0, reduces = 0, active = 0, peak = 0;
  const result = await planMemoryDedup(fixture({ snapshots: [{ id: 'long-original', text: old }], model: async request => {
    const data = dataOf(request); active++; peak = Math.max(peak, active);
    data.phase === 'map' ? maps++ : reduces++;
    if (data.phase === 'reduce') assert.equal(active, 1);
    await new Promise(resolve => setTimeout(resolve, 1));
    const ids = [];
    for (const source of data.sources) if (source.id !== 'current') for (const part of source.parts) if (part.text.includes(late)) ids.push(...part.contextIds, part.id);
    active--; return response(data, [...new Set(ids)]);
  } }));
  assert.ok(maps > 2); assert.ok(reduces > 0); assert.equal(peak, 2);
  const selected = result.sourceSelection.find(selection => selection.sourceId === 'long-original');
  assert.ok(selected.quote.includes(late));
  assert.equal(Array.from(old).slice(selected.start, selected.end).join(''), selected.quote);
  assert.ok(result.requestMetadata.every(item => item.inputChars <= DEDUP_LIMITS.inputChars && item.responseVersion === 3));
});

test('v3 one validation retry uses identical source parts and fixed safe-code feedback', async () => {
  const requests = [];
  const result = await planMemoryDedup(fixture({ model: async request => {
    requests.push(request); const data = dataOf(request);
    return response(data, requests.length === 1 ? ['unknown'] : []);
  } }));
  assert.equal(requests.length, 2); assert.equal(result.requestMetadata[0].status, 'rejected');
  assert.equal(result.requestMetadata[1].status, 'accepted');
  assert.equal(requests[0].messages[1].content, requests[1].messages[1].content);
  assert.match(requests[1].messages[0].content, /MEMORY_DEDUP_INVALID_SELECTION/);
  assert.deepEqual(result.requestMetadata[0].candidateUnits, result.requestMetadata[1].candidateUnits);
});

test('production defaults reject v1/v2 quote protocols even when their content would otherwise be valid', async () => {
  for (const version of [1, 2]) await reject(fixture({ model: async request => {
    const data = dataOf(request), result = { version,
      decisions: data.sources.map(source => ({ sourceId: source.id, action: source.id === 'current' ? 'select' : 'retire',
        reason: source.id === 'current' ? 'selected' : 'duplicate' })), selections: [{ sourceId: 'current', quote: fixture().current.text }] };
    if (version === 2) { result.requiredRefs = data.protectedRefs; result.selections = []; }
    return { finish: 'stop', text: JSON.stringify(result) };
  } }), 'MEMORY_DEDUP_INVALID_PLAN');
});

test('standalone citation headers are contexts and cannot be selected as evidence', async () => {
  await reject(fixture({ snapshots: [{ id: 'bare', text: '[4] source role=tool sourceSeq=40\n' }], model: async request => {
    const data = dataOf(request); assert.equal(data.sources[0].parts[0].kind, 'context');
    return response(data, [data.sources[0].parts[0].id]);
  } }), 'MEMORY_DEDUP_INVALID_SELECTION');
});

test('production prior-original for=[ref] background is inseparable from its short citation body', async () => {
  const background = '[3] 上一段原文背景 for=[4] role=tool sourceSeq=30（只读理解背景，不是当前正文的新断言）\n> A tail: function_name=rebuild_reference_index; checkpoint_nonce=n-314.\n';
  const parent = '[4] source role=tool sourceSeq=40\n> B start: use that function and nonce with strategy=staging_only.\n';
  const snapshots = [{ id: 'handoff', text: background + parent }];
  await reject(fixture({ snapshots, model: async request => {
    const data = dataOf(request), body = data.sources[0].parts.find(part => part.text === parent);
    assert.equal(body.contextIds.length, 1); return response(data, [body.id]);
  } }), 'MEMORY_DEDUP_INVALID_SELECTION');
  const result = await planMemoryDedup(fixture({ snapshots, model: async request => {
    const data = dataOf(request), body = data.sources[0].parts.find(part => part.text === parent);
    return response(data, [...body.contextIds, body.id]);
  } }));
  assert.ok(result.canonicalText.includes(background)); assert.ok(result.canonicalText.includes(parent));
  for (const selection of result.sourceSelection.filter(selection => selection.sourceId === 'handoff')) {
    assert.equal(Array.from(background + parent).slice(selection.start, selection.end).join(''), selection.quote);
  }
});

test('required user originals retain linked original backgrounds too, without invented protected refs', async () => {
  const background = '[3] 上一段原文背景 for=[9] role=user sourceSeq=3（只读理解背景，不是当前正文的新断言）\n> original scope: staging_only.\n';
  const original = fixture().current.text;
  const input = fixture({ current: { id: 'current', text: background + original }, model: async request => {
    const data = dataOf(request); assert.deepEqual(data.protectedRefs, [9]);
    return response(data, data.required.flatMap(unit => unit.contextIds));
  } });
  const result = await planMemoryDedup(input);
  assert.ok(result.canonicalText.includes(original)); assert.ok(result.canonicalText.includes(background));
  await reject({ ...input, model: async request => response(dataOf(request)) }, 'MEMORY_DEDUP_INVALID_SELECTION');
});

test('context provenance survives separate reduce sources and cannot be discarded from a selected body', async () => {
  const background = '[3] 上一段原文背景 for=[4] role=tool sourceSeq=30（只读理解背景，不是当前正文的新断言）\n> A tail: checkpoint_nonce=n-314.\n';
  const first = '> first condition: do not retry while lease_held=true. ' + 'a'.repeat(750) + '\n> \n';
  const second = '> second condition: rebuild_reference_index(); strategy=staging_only. ' + 'b'.repeat(750) + '\n';
  const report = background + '[4] source role=tool sourceSeq=40\n' + first + second;
  const snapshots = [{ id: 'report', text: report }, ...Array.from({ length: 8 }, (_, at) => ({ id: `noise-${at}`, text: 'noise '.repeat(800) }))];
  let reduceSeen = false;
  const model = violate => async request => {
    const data = dataOf(request), ids = [];
    for (const source of data.sources) if (source.id !== 'current') for (const part of source.parts) if (part.text.includes('second condition')) {
      if (data.phase === 'reduce') { reduceSeen = true; assert.ok(part.contextIds.length >= 2); }
      ids.push(...(violate && data.phase === 'reduce' ? [] : part.contextIds), part.id);
    }
    return response(data, [...new Set(ids)]);
  };
  const result = await planMemoryDedup(fixture({ snapshots, model: model(false) }));
  assert.equal(reduceSeen, true); assert.ok(result.canonicalText.includes(background));
  assert.ok(result.canonicalText.includes('[4] source role=tool sourceSeq=40\n'));
  assert.ok(result.canonicalText.includes(second));
  for (const selection of result.sourceSelection.filter(selection => selection.sourceId === 'report')) {
    assert.equal(Array.from(report).slice(selection.start, selection.end).join(''), selection.quote);
  }
  await reject(fixture({ snapshots, model: model(true) }), 'MEMORY_DEDUP_INVALID_SELECTION');
});

test('short exact protected copies stay visible but cannot be selected from old snapshots', async () => {
  const original = fixture().current.text;
  await reject(fixture({ snapshots: [{ id: 'old-identical', text: original }], model: async request => {
    const data = dataOf(request), old = data.sources[0];
    assert.equal(old.parts.map(part => part.text).join(''), original);
    assert.ok(old.parts.every(part => part.kind === 'protected-copy' && part.selectable === false));
    return response(data, old.parts.map(part => part.id));
  } }), 'MEMORY_DEDUP_INVALID_SELECTION');
});

test('long protected copies cannot be reconstructed through separately approved old header/body candidates', async () => {
  const original = '[9] user-original role=user sourceSeq=9\n> correction: batch_size=128; dry_run=true. ' + '原😀'.repeat(420) + '\n> \n> no production writes; preserve staging_only.\n';
  await reject(fixture({ current: { id: 'current', text: original }, required: [{ ref: 9, text: original }],
    snapshots: [{ id: 'old-identical', text: original }], model: async request => {
      const data = dataOf(request), old = data.sources[0];
      assert.ok(old.parts.length > 1, 'the original really crosses the header/body atom boundary');
      assert.ok(old.parts.every(part => !part.text.includes(original)), 'no individual atom contains the full protected unit');
      assert.equal(old.parts.map(part => part.text).join(''), original);
      assert.ok(old.parts.every(part => part.kind === 'protected-copy' && part.selectable === false));
      return response(data, old.parts.map(part => part.id));
    } }), 'MEMORY_DEDUP_INVALID_SELECTION');
});

test('protected-copy exclusion uses original snapshot ranges before map chunks split an exact unit', async () => {
  const original = '[9] user-original role=user sourceSeq=9\n> correction: batch_size=128; dry_run=true. ' + '原😀'.repeat(420) + '\n';
  const prefix = 'x'.repeat(8000) + '\n', snapshot = prefix + original + '\nTAIL original unrelated\n';
  const protectedStart = cp(prefix), protectedEnd = protectedStart + cp(original);
  const result = await planMemoryDedup(fixture({ current: { id: 'current', text: original }, required: [{ ref: 9, text: original }],
    snapshots: [{ id: 'split-copy', text: snapshot }], model: async request => response(dataOf(request)) }));
  const mapCandidates = result.requestMetadata.filter(item => item.phase === 'map').flatMap(item => item.candidateUnits)
    .filter(unit => unit.sourceId === 'split-copy');
  const overlapping = mapCandidates.filter(unit => unit.start < protectedEnd && unit.end > protectedStart);
  assert.ok(overlapping.length >= 2, 'the test unit straddles the original 8192-code-point boundary');
  assert.ok(overlapping.every(unit => unit.kind === 'protected-copy' && unit.selectable === false));
  assert.equal(result.canonicalText, original);
  for (const metadata of result.requestMetadata.filter(item => item.phase === 'map')) for (const source of metadata.sourceHashes.filter(source => source.sourceId === 'split-copy')) {
    assert.equal(sha(Array.from(snapshot).slice(source.start, source.end).join('')), source.sha256);
  }
});
