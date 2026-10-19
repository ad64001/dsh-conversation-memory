import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeFixture, ScratchExecutor, validateProposal, recentBudget, chars } from '../fixture.mjs';

test('long fixtures and exact A/B boundary preserve original pronoun dependence', () => {
  for (const noiseMessages of [100, 1000]) {
    const f = makeFixture({ noiseMessages });
    assert.equal(chars(f.a), 4000); assert.equal(chars(f.b), 4000);
    assert.ok(f.totalChars > 50_000); assert.ok(f.a.endsWith('以接下段返回为准。\n'));
    assert.ok(f.b.startsWith('修改成功，但')); assert.ok(!f.b.includes(f.target));
  }
});

test('scratch executor records actual repeated failure and permits changed-condition recovery', () => {
  const f = makeFixture();
  const executor = new ScratchExecutor({ directory: mkdtempSync(path.join(tmpdir(), 'memory-bench-')), initial: f.initial });
  assert.equal(executor.execute(f.initialFailureAction).code, 'E_LOCK_MISSING');
  assert.equal(executor.execute(f.initialFailureAction).code, 'E_LOCK_MISSING');
  executor.patchState({ lockGeneration: 1 });
  assert.equal(executor.execute({ ...f.initialFailureAction, generation: 1 }).code, 'RECOVERED');
  assert.equal(executor.verifyResult().batch_size, 256);
  executor.patchState({ batchSize: 128 });
  assert.equal(executor.execute({ ...f.initialFailureAction, generation: 1 }).code, 'WRONG_ARGUMENTS');
  assert.equal(executor.execute({ ...f.initialFailureAction, batchSize: 128, generation: 1 }).code, 'RECOVERED');
  assert.equal(executor.verifyResult().batch_size, 128);
});

test('no model-proposed arbitrary path or unknown action executes', () => {
  const f = makeFixture();
  const executor = new ScratchExecutor({ directory: mkdtempSync(path.join(tmpdir(), 'memory-bench-')), initial: f.initial });
  assert.equal(executor.execute({ ...f.initialFailureAction, file: '../outside' }).executed, false);
  assert.equal(executor.execute({ action: 'shell' }).executed, false);
  assert.throws(() => validateProposal('{"action":"shell"}'));
  assert.deepEqual(validateProposal(JSON.stringify(f.initialFailureAction)), f.initialFailureAction);
});

test('baseline recent evidence is whole-message bounded', () => {
  const history = [{ role: 'user', text: 'old'.repeat(500) }, { role: 'user', text: 'newest' }];
  const packed = recentBudget(history, 80);
  assert.ok(chars(packed) <= 80); assert.ok(packed.includes('newest')); assert.ok(!packed.includes('old'));
});
