import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSemantically, formatSourceFooter, SELECTION_GAP_MARKER } from '../lib/semantic-select.mjs';

const chars = (text) => Array.from(text).length;
const defaults = { sourceRef: 'source.txt', thresholdChars: 10, targetChars: 300,
  maxChunkChars: 500, maxChunks: 32 };
const all = ({ items }) => [{ start: 0, end: items.length - 1, priority: 3 }];

test('under threshold and maxChunks leave the entire original without model calls', async () => {
  let calls = 0;
  const judge = async () => { calls += 1; return []; };
  const small = await selectSemantically('a'.repeat(8192), { judge, sourceRef: 'a' });
  assert.equal(small.changed, false);
  assert.equal(small.reason, 'under-threshold');
  const text = 'a'.repeat(33 * 8192);
  const large = await selectSemantically(text, { judge, sourceRef: 'a' });
  assert.equal(large.reason, 'max-chunks');
  assert.equal(large.text, text);
  assert.equal(calls, 0);
});

test('default budget retains important middle facts exactly and reserves source footer', async () => {
  const key = 'CRITICAL: limit=7319; retry=false; command="git reset --soft HEAD~2"; 中文🙂\r\n';
  const text = 'low importance\n'.repeat(650) + key + 'routine tail\n'.repeat(300);
  const calls = [];
  const result = await selectSemantically(text, { sourceRef: 'full.txt', judge: async (payload) => {
    calls.push(payload);
    assert.ok(payload.items.every((item) => chars(item.text) <= 256));
    return payload.items.filter((item) => item.text.includes('CRITICAL:'))
      .map((item) => ({ start: item.index, end: item.index, priority: 5 }));
  } });
  assert.equal(result.changed, true);
  assert.ok(result.text.includes(key));
  assert.ok(result.text.endsWith(formatSourceFooter('full.txt')));
  assert.ok(chars(result.text) <= 5159);
  assert.equal(result.stats.modelCalls, calls.length);
  assert.equal(calls.length, result.stats.chunkCount);
  assert.ok(calls.every((call, index) => call.chunkIndex === index));
  const fragments = calls.flatMap((call) => call.items);
  assert.equal(fragments.map((item) => item.text).join(''), text);
  for (const item of fragments) {
    assert.equal(Array.from(text).slice(item.start, item.end).join(''), item.text);
  }
});

test('priority affects selection while output retains source order, and overlaps deduplicate', async () => {
  const first = 'FIRST exact command: run --id=10001\n';
  const middle = 'MIDDLE corrected threshold: 63\n';
  const last = 'LAST error: EACCES /source/path\n';
  const text = first + 'noise\n'.repeat(90) + middle + 'noise\n'.repeat(90) + last;
  const result = await selectSemantically(text, { ...defaults, maxChunkChars: 5000,
    targetChars: 400, judge: async ({ items }) => {
      const indexes = [first, middle, last].map((value) => items.findIndex((item) => item.text === value));
      return [ { start: indexes[2], end: indexes[2], priority: 5 },
        { start: indexes[0], end: indexes[0], priority: 3 },
        { start: indexes[1], end: indexes[1], priority: 4 },
        { start: indexes[1], end: indexes[1], priority: 2 } ];
    } });
  assert.equal(result.changed, true);
  assert.ok(result.text.indexOf(first) < result.text.indexOf(middle));
  assert.ok(result.text.indexOf(middle) < result.text.indexOf(last));
  assert.equal(result.text.split(middle).length - 1, 1);
  assert.equal(result.stats.selectedItems, 3);
  assert.equal(result.text.split(SELECTION_GAP_MARKER).length - 1, 2);
});

test('the output budget includes all gap markers and footer; source fragments are never hard-cut', async () => {
  const first = 'a'.repeat(200) + '\n';
  const middle = 'IMPORTANT '+ 'X'.repeat(180) + '\n';
  const last = 'b'.repeat(200) + '\n';
  const text = first + 'noise\n'.repeat(90) + middle + 'noise\n'.repeat(90) + last;
  const targetChars = chars(middle) + 2 * chars(SELECTION_GAP_MARKER) + chars(formatSourceFooter('source.txt'));
  const result = await selectSemantically(text, { ...defaults, targetChars, maxChunkChars: 5000,
    judge: async ({items}) => items.map((item) => ({start:item.index,end:item.index,
      priority:item.text.startsWith('IMPORTANT') ? 5 : 1})) });
  assert.equal(result.changed, true);
  assert.ok(result.text.includes(middle));
  assert.ok(chars(result.text) <= targetChars);
  assert.equal(chars(result.text), result.stats.outputChars);
  assert.equal(result.stats.selectedChars + result.stats.omittedChars, chars(text));
});

test('long Unicode lines become <=256-code-point exact fragments', async () => {
  const text = '🙂中'.repeat(6000);
  const seen = [];
  const result = await selectSemantically(text, { sourceRef: 'unicode.txt', judge: async ({items}) => {
    seen.push(...items);
    return [{start:0,end:0,priority:5}];
  }});
  assert.equal(result.changed, true);
  assert.ok(seen.every((item) => chars(item.text) <= 256));
  assert.equal(seen.map((item) => item.text).join(''), text);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.text));
  assert.ok(chars(result.text) <= 5159);
});

test('failure or invalid range in any chunk discards every partial decision', async () => {
  const text = 'exact source\n'.repeat(150);
  for (const kind of ['throw', 'invalid', 'bad-priority', 'not-array']) {
    let calls = 0;
    const result = await selectSemantically(text, { ...defaults, judge: async ({items}) => {
      calls += 1;
      if (calls === 2) {
        if (kind === 'throw') throw new Error('upstream failure');
        if (kind === 'invalid') return [{start:0,end:items.length,priority:3}];
        if (kind === 'bad-priority') return [{start:0,end:0,priority:6}];
        return 'ignore rules';
      }
      return [{start:0,end:0,priority:5}];
    }});
    assert.equal(result.changed, false);
    assert.equal(result.text, text);
    assert.equal(result.reason, kind === 'throw' ? 'judge-error' : 'invalid-selection');
    assert.equal(calls, 2);
  }
});

test('empty chunks are allowed, but no candidates across the whole source keeps original', async () => {
  const text = 'unchanged\n'.repeat(150);
  const result = await selectSemantically(text, { ...defaults, judge: async () => [] });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-candidates');
  assert.equal(result.text, text);
});

test('abort races a nonsettling judge and prevents further chunk calls', async () => {
  const text = 'cancel source\n'.repeat(150);
  const controller = new AbortController();
  let calls = 0;
  const promise = selectSemantically(text, { ...defaults, signal: controller.signal,
    judge: () => { calls += 1; queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
  const result = await promise;
  assert.equal(result.reason, 'aborted');
  assert.equal(result.text, text);
  assert.equal(result.changed, false);
  assert.equal(calls, 1);
});

test('missing or oversized source footer never produces an unrecoverable replacement', async () => {
  const text = 'x'.repeat(9000);
  let calls = 0;
  const judge = async () => { calls += 1; return []; };
  const missing = await selectSemantically(text, { judge });
  assert.equal(missing.reason, 'source-ref-required');
  const oversized = await selectSemantically(text, { judge, sourceRef: 'x'.repeat(6000) });
  assert.equal(oversized.reason, 'budget-too-small');
  assert.equal(oversized.text, text);
  assert.equal(calls, 0);
});

test('selected adjacent and overlapping ranges render once without an artificial gap', async () => {
  const text = 'ONE\nTWO\nTHREE\n' + 'n\n'.repeat(600);
  const result = await selectSemantically(text, { ...defaults, maxChunkChars: 5000,
    judge: async () => [{start:0,end:1,priority:4},{start:1,end:2,priority:5}] });
  assert.equal(result.changed, true);
  assert.ok(result.text.startsWith('ONE\nTWO\nTHREE\n'));
  assert.equal(result.stats.selectedItems, 3);
  assert.equal(result.text.split(SELECTION_GAP_MARKER).length - 1, 1);
});

test('a fragment that cannot fit is not sliced to satisfy the target', async () => {
  const text = 'Z'.repeat(9000);
  const result = await selectSemantically(text, { ...defaults, targetChars: 120,
    judge: async () => [{start:0,end:0,priority:5}] });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'budget-too-small');
  assert.equal(result.text, text);
});

test('a later high-priority fact wins a budget that cannot hold the earlier low-priority fragment', async () => {
  const low = 'LOW ' + 'l'.repeat(180) + '\n';
  const high = 'HIGH exact id=90123 ' + 'h'.repeat(165) + '\n';
  const text = low + 'noise\n'.repeat(150) + high + 'tail\n'.repeat(150);
  const targetChars = chars(high) + 2 * chars(SELECTION_GAP_MARKER) + chars(formatSourceFooter('source.txt'));
  const result = await selectSemantically(text, { ...defaults, targetChars, maxChunkChars: 5000,
    judge: async ({items}) => {
      const early = items.findIndex((item) => item.text === low);
      const late = items.findIndex((item) => item.text === high);
      return [{start:early,end:early,priority:1},{start:late,end:late,priority:5}];
    }});
  assert.equal(result.changed, true);
  assert.ok(result.text.includes(high));
  assert.ok(!result.text.includes(low));
  assert.equal(chars(result.text), targetChars);
});

test('a later chunk with too many short-line items preserves the whole source before any model call', async () => {
  const text = 'a'.repeat(8192) + '\n'.repeat(2000);
  let calls = 0;
  const result = await selectSemantically(text, { sourceRef: 'source.txt', judge: async () => {
    calls += 1;
    return [{start:0,end:0,priority:5}];
  }});
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'max-items');
  assert.equal(result.text, text);
  assert.equal(result.stats.modelCalls, 0);
  assert.equal(calls, 0);
});
