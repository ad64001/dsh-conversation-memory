import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { atomicState } from '../lib/atomic-state.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-state-test-')), file = join(directory, 'state.json');
  writeFileSync(file, '{"cursor":1}');
  t.after(() => { if (dirname(resolve(directory)) !== resolve(tmpdir())) throw Error('Unsafe cleanup'); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file };
}

test('atomic state replaces a real cursor and leaves no temporary file', t => {
  const { directory, file } = fixture(t);
  atomicState(file, { cursor: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file)), { cursor: 2 });
  assert.deepEqual(readdirSync(directory), ['state.json']);
});

test('a transient Windows replacement lock is retried without removing the committed cursor', t => {
  const { directory, file } = fixture(t), waited = []; let calls = 0;
  const retries = atomicState(file, { cursor: 3 }, { wait: ms => waited.push(ms), rename: (from, to) => {
    calls++;
    if (calls < 3) { assert.equal(JSON.parse(readFileSync(file)).cursor, 1); throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
    renameSync(from, to);
  } });
  assert.equal(calls, 3); assert.deepEqual(waited, [10, 30]);
  assert.equal(retries, 2);
  assert.deepEqual(JSON.parse(readFileSync(file)), { cursor: 3 });
  assert.deepEqual(readdirSync(directory), ['state.json']);
});

test('a persistent lock is bounded, retains the old cursor, and removes its own temporary file', t => {
  const { directory, file } = fixture(t); let calls = 0;
  assert.throws(() => atomicState(file, { cursor: 4 }, { wait() {}, delays: [1, 2], rename() {
    calls++; throw Object.assign(new Error('locked'), { code: 'EPERM' });
  } }), { code: 'EPERM' });
  assert.equal(calls, 3); assert.equal(JSON.parse(readFileSync(file)).cursor, 1);
  assert.deepEqual(readdirSync(directory), ['state.json']);
});

test('nontransient state failures propagate without retrying or deleting the old cursor', t => {
  const { directory, file } = fixture(t); let calls = 0;
  assert.throws(() => atomicState(file, { cursor: 5 }, { wait() { throw Error('must not wait'); }, rename() {
    calls++; throw Object.assign(new Error('invalid path'), { code: 'ENOENT' });
  } }), { code: 'ENOENT' });
  assert.equal(calls, 1); assert.equal(JSON.parse(readFileSync(file)).cursor, 1);
  assert.deepEqual(readdirSync(directory), ['state.json']);
});
