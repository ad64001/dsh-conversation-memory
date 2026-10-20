import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSemantically } from '../lib/semantic-select.mjs';

test('next chunk receives bounded exact previous original, with source coordinates', async () => {
  const text = 'src/harness/split.py -> chunk_text()\n' + 'a'.repeat(300) + '\n修改成功，但引发 KeyError: context_id。\n' + 'b'.repeat(400);
  const calls = [];
  const result = await selectSemantically(text, { thresholdChars: 20, targetChars: 500, maxChunkChars: 350,
    sourceRef: 'full-original.txt', judge: async payload => {
      calls.push(payload);
      return [{ start: 0, end: 0, priority: 5 }];
    } });
  assert.ok(calls.length > 1);
  assert.equal(calls[0].previousBackground, null);
  for (const call of calls.slice(1)) {
    const previous = call.previousBackground;
    assert.equal(previous.readOnly, true);
    assert.equal(previous.sourceRef, 'full-original.txt');
    assert.equal(Array.from(text).slice(previous.start, previous.end).join(''), previous.text);
    assert.ok(previous.end <= call.items[0].start);
    assert.ok(Array.from(previous.text).length <= 1024);
    assert.equal('index' in previous, false);
  }
  assert.ok(result.stats.detectedEntities > 0);
  assert.equal(result.coverage.detected, result.coverage.selected + result.coverage.omitted.length);
  assert.equal(result.coverage.sourceRef, 'full-original.txt');
  assert.ok(Array.from(result.text).length <= 500);
});

test('missing error and control-parameter evidence rejects pruning and preserves the original', async () => {
  const text = 'noise state unchanged normal heartbeat\n'.repeat(400) + '\nKeyError: context_id; max_tokens=4096; src/harness/split.py\n' + 'tail state unchanged normal heartbeat\n'.repeat(300);
  const result = await selectSemantically(text, { sourceRef: 'saved-original.txt', judge: async ({ items }) => {
    const index = items.findIndex(item => /^(noise|tail) state/u.test(item.text));
    return index < 0 ? [] : [{ start: index, end: index, priority: 1 }];
  } });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'critical-evidence-missing');
  assert.equal(result.criticalCoverage.accepted, false);
  assert.ok(result.coverage.omitted.some(entity => entity.quote === 'max_tokens=4096'));
  assert.equal(result.text, text);
});
