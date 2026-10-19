import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEntities, entityCoverage } from '../lib/entities.mjs';

test('detector retains exact identifiers, paths, error details and thresholds with Unicode offsets', () => {
  const text = "🧭 src/harness/split.py -> chunk_text(); `context_id` max_tokens=4096; KeyError: 'context_id'; E_LOCK_MISSING\n尝试关闭校验后仍失败，driver=2。";
  const entities = detectEntities(text);
  for (const needle of ['src/harness/split.py', 'chunk_text()', 'context_id', 'max_tokens=4096', 'KeyError', 'E_LOCK_MISSING']) {
    assert.ok(entities.some(entity => entity.quote === needle), needle);
  }
  assert.ok(entities.some(entity => entity.categories.includes('failure_evidence') && entity.quote.includes('尝试关闭校验后仍失败')));
  for (const entity of entities) assert.equal(Array.from(text).slice(entity.start, entity.end).join(''), entity.quote);
  const moved = detectEntities(text, { baseOffset: 512 });
  assert.equal(moved[0].start, entities[0].start + 512);
});

test('entity overlapping a segment keeps the complete original span instead of clipping its name', () => {
  const text = 'a'.repeat(250) + ' src/harness/very_long_file_name.py ';
  const entities = detectEntities(text, { start: 256, end: 270 });
  const path = entities.find(entity => entity.categories.includes('path'));
  assert.equal(path.quote, 'src/harness/very_long_file_name.py');
  assert.ok(path.start < 256 && path.end > 270);
});

test('coverage is positional and merges adjacent selected original spans', () => {
  const entities = [{ start: 10, end: 30, quote: 'same identifier' }];
  assert.equal(entityCoverage(entities, [{ start: 10, end: 20 }, { start: 20, end: 30 }])[0].selected, true);
  assert.equal(entityCoverage(entities, [{ start: 10, end: 20 }, { start: 21, end: 30 }])[0].selected, false);
  assert.equal(entityCoverage(entities, [{ start: 40, end: 60 }])[0].selected, false);
});

test('malformed spans are rejected and detection does not invent semantic failure claims', () => {
  assert.throws(() => detectEntities('abc', { start: 3, end: 2 }));
  assert.throws(() => detectEntities('abc', { baseOffset: -1 }));
  const result = detectEntities('曾失败，但新版本尚未验证。');
  assert.equal(result[0].quote, '曾失败，但新版本尚未验证。');
  assert.deepEqual(Object.keys(result[0]).sort(), ['start', 'end', 'quote', 'categories'].sort());
});

test('configuration evidence keeps fractional thresholds, full versions and named values', () => {
  const text = 'threshold=.8 driver=2.4.1 model=deepseek-v4.1-flash "max_tokens":4096 E-49';
  const quotes = detectEntities(text).map(entity => entity.quote);
  for (const exact of ['threshold=.8', 'driver=2.4.1', 'model=deepseek-v4.1-flash', '"max_tokens":4096', 'E-49']) assert.ok(quotes.includes(exact), exact);
});
