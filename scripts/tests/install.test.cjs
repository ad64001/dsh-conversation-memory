const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const core = require('../install-core.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-installer-'));
  t.after(() => { const resolved = path.resolve(root); if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unsafe cleanup path'); fs.rmSync(resolved, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), source = path.join(root, 'source'), profile = path.join(home, 'profiles/desktop/cordis.patch.yml');
  for (const component of core.COMPONENTS) { fs.mkdirSync(path.join(source, component), { recursive: true }); fs.writeFileSync(path.join(source, component, 'code.txt'), 'exact source ' + component); }
  fs.mkdirSync(path.dirname(profile), { recursive: true }); const before = Buffer.from('# user config\r\n[]\r\n'); fs.writeFileSync(profile, before);
  const destinations = core.NAMES.map(n => path.join(home, 'plugins', n));
  return { root, source, home, profile, destinations, before, after: Buffer.from('# managed fixture\n'), basicUrl: 'file:///fixture/basic.js', nativeVersion: '0.2.1-rc.2' };
}
function presets() { return ['standard', 'ptc', 'cordis'].map(id => ({ id: 'preset-' + id, name: '@deepseek-ai/dsh-agent-preset', config: { id, custom: { keep: 'exact', limit: 17 }, plugins: [{ id: 'compaction', group: true, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.71, retainRatio: 0.19, maxTokens: 7777 } }, { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192 } }] }] } })); }
test('only implementation and blind cropper switch change; all custom/native settings survive', () => {
  const before = presets(), hashBefore = core.hash(JSON.stringify(before));
  const { patches, expected } = core.makePatches(before, [path.resolve('memory'), path.resolve('pruner')]);
  assert.equal(core.hash(JSON.stringify(before)), hashBefore);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(patches[i].config.custom, before[i].config.custom);
    assert.deepEqual(patches[i].config.plugins[0].config[0].config, before[i].config.plugins[0].config[0].config);
    assert.equal(patches[i].config.plugins[0].config[1].disabled, true);
  }
  core.verifyComposition(before, [...expected.values(), patches[3].insert[0]], expected);
});
test('unknown compaction engines, missing presets and duplicate entries stop installation', () => {
  const rows = presets(); rows[0].config.plugins[0].config[0].name = 'custom-engine';
  assert.throws(() => core.makePatches(rows, ['a', 'b']), /Custom\/previous/);
  assert.throws(() => core.makePatches(presets().slice(1), ['a', 'b']), /exactly one/);
  assert.throws(() => core.makePatches([...presets(), presets()[0]], ['a', 'b']), /exactly one/);
});
test('later overrides and unrelated row changes fail verification', () => {
  const before = [...presets(), { id: 'other', config: { tokenBudget: 10 } }];
  const { patches, expected } = core.makePatches(before, ['a', 'b']);
  const after = [...expected.values(), before[3], patches[3].insert[0]];
  after[0] = structuredClone(after[0]); after[0].config.custom.keep = 'changed';
  assert.throws(() => core.verifyComposition(before, after, expected), /later patch/);
  after[0] = expected.get('preset-standard'); after[3] = { id: 'other', config: {} };
  assert.throws(() => core.verifyComposition(before, after, expected), /Unrelated/);
});
test('install and rollback restore exact profile bytes and preserve databases', t => {
  const plan = fixture(t), db = path.join(plan.home, 'conversation-memory', 'keep.sqlite');
  fs.mkdirSync(path.dirname(db), { recursive: true }); fs.writeFileSync(db, 'private database fixture');
  const installed = core.install(plan);
  assert.deepEqual(fs.readFileSync(plan.profile), plan.after);
  assert.match(fs.readFileSync(path.join(plan.destinations[1], 'runtime-binding.mjs'), 'utf8'), /file:\/\/\/fixture\/basic.js/);
  assert.equal(core.rollback(installed.backup, plan.home).rolledBack, true);
  assert.deepEqual(fs.readFileSync(plan.profile), plan.before);
  assert.equal(fs.readFileSync(db, 'utf8'), 'private database fixture');
  for (const dest of plan.destinations) assert.equal(fs.existsSync(dest), false);
});
test('rollback refuses later user configuration edits without changing files', t => {
  const plan = fixture(t), result = core.install(plan); fs.appendFileSync(plan.profile, '# later change\n');
  const current = fs.readFileSync(plan.profile);
  assert.throws(() => core.rollback(result.backup, plan.home), /edited since/);
  assert.deepEqual(fs.readFileSync(plan.profile), current);
  assert.equal(fs.existsSync(plan.destinations[0]), true);
});
test('unmanaged destinations and concurrent configuration edits are preserved', t => {
  const plan = fixture(t); fs.mkdirSync(plan.destinations[0], { recursive: true });
  assert.throws(() => core.install(plan), /already exists/); assert.deepEqual(fs.readFileSync(plan.profile), plan.before);
  const second = fixture(t); fs.appendFileSync(second.profile, '# concurrent\n');
  assert.throws(() => core.install(second), /changed concurrently/);
  assert.equal(fs.existsSync(second.destinations[0]), false);
});
test('modified installed code stops automatic rollback', t => {
  const plan = fixture(t), result = core.install(plan); fs.appendFileSync(path.join(plan.destinations[0], 'code.txt'), 'edit');
  assert.throws(() => core.rollback(result.backup, plan.home), /plugin changed/);
  assert.deepEqual(fs.readFileSync(plan.profile), plan.after);
});
test('backup paths outside selected home and tampered receipt paths are rejected', t => {
  const plan = fixture(t), result = core.install(plan);
  assert.throws(() => core.rollback(plan.root, plan.home), /inside/);
  const file = path.join(result.backup, 'receipt.json'), data = JSON.parse(fs.readFileSync(file));
  data.destinations[0] = plan.root; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => core.rollback(result.backup, plan.home), /paths mismatch/);
});
test('missing original patch is restored by removal, not an invented empty file', t => {
  const plan = fixture(t); fs.unlinkSync(plan.profile); plan.before = null;
  const result = core.install(plan); core.rollback(result.backup, plan.home);
  assert.equal(fs.existsSync(plan.profile), false);
});
