'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { isDeepStrictEqual } = require('node:util');
const COMPONENTS = ['plugin', 'semantic-pruner'];
const NAMES = ['dsh-conversation-memory', 'dsh-semantic-tool-pruner'];
const MARKER = '# BEGIN DSH CONVERSATION MEMORY PUBLIC';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function files(root) {
  const result = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isSymbolicLink()) throw Error('Symlink in source: ' + file);
    if (item.isDirectory()) result.push(...files(file).map(x => item.name + '/' + x));
    else if (item.isFile()) result.push(item.name);
    else throw Error('Unsupported file: ' + file);
  }
  return result.sort();
}
function contained(root, relative) {
  const target = path.resolve(root, relative), rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Path outside intended root');
  return target;
}
function verifySource(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE_MANIFEST.json')));
  if (manifest.version !== '0.4.2' || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid source manifest');
  const seen = new Set();
  for (const row of manifest.files) {
    if (seen.has(row.path)) throw Error('Duplicate manifest path'); seen.add(row.path);
    const file = contained(root, row.path);
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('Source symlink');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error('Source hash mismatch: ' + row.path);
  }
  for (const component of COMPONENTS) for (const relative of files(path.join(root, component))) {
    if (!seen.has(component + '/' + relative)) throw Error('Unlisted plugin source: ' + relative);
  }
  return manifest;
}
function walkPlugins(rows) {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? walkPlugins(row.config) : [])]);
}
function makePatches(entries, destinations) {
  const patches = [], expected = new Map();
  for (const id of ['preset-standard', 'preset-ptc', 'preset-cordis']) {
    const matches = entries.filter(row => row.id === id);
    if (matches.length !== 1) throw Error('Expected exactly one ' + id);
    const row = matches[0];
    if (row.name !== '@deepseek-ai/dsh-agent-preset' || !Array.isArray(row.config?.plugins)) throw Error('Unsupported preset: ' + id);
    const config = structuredClone(row.config), rows = walkPlugins(config.plugins);
    const basics = rows.filter(x => x.id === 'compaction-basic'), croppers = rows.filter(x => x.id === 'tool-result-pruner');
    if (basics.length !== 1 || croppers.length !== 1 || basics[0].name !== '@deepseek-ai/dsh-compaction-basic' || croppers[0].name !== '@deepseek-ai/dsh-compaction-tool-result-pruner') throw Error('Custom/previous compaction backend in ' + id + '; review manually');
    basics[0].name = pathToFileURL(path.join(destinations[1], 'lib/index.mjs')).href;
    croppers[0].disabled = true;
    patches.push({ id, name: row.name, config }); expected.set(id, { ...structuredClone(row), config });
  }
  if (entries.some(row => row.id === 'conversation-reference-memory' || row.name === 'dsh-conversation-memory')) throw Error('Existing memory plugin; restore previous installation first');
  patches.push({ insert: [{ id: 'conversation-reference-memory', name: pathToFileURL(path.join(destinations[0], 'lib/index.mjs')).href, config: {} }] });
  return { patches, expected };
}
function verifyComposition(before, after, expected) {
  for (const [id, value] of expected) {
    const found = after.filter(row => row.id === id);
    if (found.length !== 1 || !isDeepStrictEqual(found[0], value)) throw Error('A later patch overrides installation: ' + id);
  }
  for (const row of before) if (!expected.has(row.id)) {
    const found = after.filter(x => x.id === row.id);
    if (found.length !== 1 || !isDeepStrictEqual(row, found[0])) throw Error('Unrelated configuration changed: ' + row.id);
  }
  const memory = after.filter(row => row.id === 'conversation-reference-memory');
  if (memory.length !== 1 || after.length !== before.length + 1) throw Error('Memory entry admission mismatch');
}
function atomic(file, bytes) {
  const temp = file + '.memory-' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
function treeHash(root) { return hash(JSON.stringify(files(root).map(relative => [relative, hash(fs.readFileSync(path.join(root, relative)))]))); }
function assertPlainAncestors(target) {
  for (let at = path.resolve(target); ; at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw Error('Linked target directory is unsupported: ' + at);
    if (path.dirname(at) === at) break;
  }
}
function install(plan) {
  for (const dest of plan.destinations) { assertPlainAncestors(path.dirname(dest)); if (fs.existsSync(dest)) throw Error('Plugin destination already exists: ' + dest); }
  assertPlainAncestors(plan.profile);
  fs.mkdirSync(path.dirname(plan.profile), { recursive: true });
  const lock = plan.profile + '.memory-install.lock';
  const fd = fs.openSync(lock, 'wx', 0o600); fs.closeSync(fd);
  let backup;
  try {
    if (!sameProfile(plan.profile, plan.before)) throw Error('Profile changed concurrently');
    backup = path.join(plan.home, 'backups', 'dsh-memory-public-' + crypto.randomUUID());
    fs.mkdirSync(backup, { recursive: true });
    if (plan.before !== null) fs.writeFileSync(path.join(backup, 'cordis.patch.yml.before'), plan.before, { flag: 'wx', mode: 0o600 });
    const receipt = { version: 1, packageVersion: '0.4.2', at: new Date().toISOString(), home: plan.home, profile: plan.profile, beforeExists: plan.before !== null, beforeSha256: plan.before === null ? null : hash(plan.before), afterSha256: hash(plan.after), destinations: plan.destinations, trees: [], status: 'prepared', nativeVersion: plan.nativeVersion };
    atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
    for (let i = 0; i < COMPONENTS.length; i++) {
      fs.mkdirSync(path.dirname(plan.destinations[i]), { recursive: true });
      const stage = plan.destinations[i] + '.stage-' + crypto.randomUUID();
      fs.cpSync(path.join(plan.source, COMPONENTS[i]), stage, { recursive: true, errorOnExist: true, force: false });
      if (i === 1) fs.writeFileSync(path.join(stage, 'runtime-binding.mjs'), '// Generated for this DSH installation.\nexport const compactionBasicUrl = ' + JSON.stringify(plan.basicUrl) + ';\n', { flag: 'wx' });
      fs.renameSync(stage, plan.destinations[i]);
      receipt.trees.push(treeHash(plan.destinations[i]));
      atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
    }
    if (!sameProfile(plan.profile, plan.before)) throw Error('Profile changed concurrently; activation not applied');
    atomic(plan.profile, plan.after);
    receipt.status = 'installed'; atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
    return { installed: true, backup, receipt: path.join(backup, 'receipt.json'), restartRequired: true };
  } catch (error) {
    throw Error(error.message + (backup ? '\nRecovery backup: ' + backup : ''));
  } finally { fs.unlinkSync(lock); }
}
function sameProfile(file, before) { return before === null ? !fs.existsSync(file) : fs.existsSync(file) && fs.readFileSync(file).equals(before); }
function rollback(backup, home) {
  backup = path.resolve(backup); home = path.resolve(home);
  const rel = path.relative(path.join(home, 'backups'), backup);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Backup must be inside the selected DSH home/backups');
  assertPlainAncestors(backup);
  const receiptFile = path.join(backup, 'receipt.json'), receipt = JSON.parse(fs.readFileSync(receiptFile));
  if (receipt.version !== 1 || path.resolve(receipt.home) !== home || !['installed', 'prepared'].includes(receipt.status)) throw Error('Unsupported receipt');
  const expectedProfile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  if (path.resolve(receipt.profile) !== expectedProfile || !isDeepStrictEqual(receipt.destinations, NAMES.map(name => path.join(home, 'plugins', name)))) throw Error('Receipt paths mismatch');
  assertPlainAncestors(expectedProfile);
  const lock = expectedProfile + '.memory-install.lock'; const fd = fs.openSync(lock, 'wx', 0o600); fs.closeSync(fd);
  try {
    const current = fs.existsSync(expectedProfile) ? hash(fs.readFileSync(expectedProfile)) : null;
    if (![receipt.afterSha256, receipt.beforeSha256].includes(current)) throw Error('Profile edited since installation; automatic rollback stopped');
    const before = receipt.beforeExists ? fs.readFileSync(path.join(backup, 'cordis.patch.yml.before')) : null;
    if ((before === null ? null : hash(before)) !== receipt.beforeSha256) throw Error('Backup hash mismatch');
    for (let i = 0; i < receipt.destinations.length; i++) if (fs.existsSync(receipt.destinations[i])) {
      assertPlainAncestors(receipt.destinations[i]);
      if (!receipt.trees[i] || treeHash(receipt.destinations[i]) !== receipt.trees[i]) throw Error('Installed plugin changed; automatic rollback stopped');
    }
    if (current === receipt.afterSha256) {
      if (before !== null) atomic(expectedProfile, before); else fs.unlinkSync(expectedProfile);
    }
    for (let i = 0; i < receipt.destinations.length; i++) if (fs.existsSync(receipt.destinations[i])) fs.renameSync(receipt.destinations[i], path.join(backup, NAMES[i] + '.removed'));
    receipt.status = 'rolled-back'; receipt.rolledBackAt = new Date().toISOString(); atomic(receiptFile, JSON.stringify(receipt, null, 2));
    return { rolledBack: true, backup, memoryDatabasesPreserved: true, restartRequired: true };
  } finally { fs.unlinkSync(lock); }
}
module.exports = { COMPONENTS, NAMES, MARKER, hash, files, verifySource, makePatches, verifyComposition, install, rollback };
