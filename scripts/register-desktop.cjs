'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const core = require('./install-core.cjs');
const { assertRuntimeVersion, assertDesktopStopped } = require('./install.cjs');
const names = core.NAMES;
const allowedFiles = ['profiles/desktop/package.json', 'profiles/desktop/pnpm-lock.yaml', 'profiles/desktop/cordis.patch.yml', ...names.map(name => `plugins/${name}/cordis.patch.yml`)];
const relativeLink = name => `profiles/desktop/node_modules/${name}`;
function contained(home, relative) {
  const target = path.resolve(home, relative), rel = path.relative(home, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Path outside selected DSH home');
  return target;
}
function plain(file) {
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw Error('Linked configuration path: ' + at);
    if (path.dirname(at) === at) break;
  }
}
function atomic(file, bytes) {
  const temp = file + '.registration-' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
  core.renameWithRetry(temp, file);
}
function bytes(file) { return fs.existsSync(file) ? fs.readFileSync(file) : null; }
function hash(value) { return value === null ? null : core.hash(value); }
function treeHash(directory) { return core.hash(JSON.stringify(core.files(directory).map(relative => [relative, core.hash(fs.readFileSync(path.join(directory, relative)))]))); }
function backupInside(home, backup) {
  const relative = path.relative(path.join(home, 'backups'), path.resolve(backup));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Backup outside selected DSH home/backups');
  plain(backup);
}
function buildRegistrationPlan({ home, backup, directory, source = path.resolve(__dirname, '..') }) {
  home = path.resolve(home); backup = path.resolve(backup); backupInside(home, backup); core.verifySource(source);
  const installed = JSON.parse(fs.readFileSync(path.join(backup, 'receipt.json')));
  const profile = path.join(home, 'profiles/desktop/cordis.patch.yml');
  if (installed.version !== 1 || installed.status !== 'installed' || path.resolve(installed.home) !== home || path.resolve(installed.profile) !== profile || !isDeepStrictEqual(installed.destinations, names.map(name => path.join(home, 'plugins', name)))) throw Error('Unsupported original installation receipt');
  if (hash(bytes(profile)) !== installed.afterSha256 || installed.destinations.some((dir, i) => treeHash(dir) !== installed.trees[i])) throw Error('Original managed installation changed; registration stopped');
  const original = installed.beforeExists ? fs.readFileSync(path.join(backup, 'cordis.patch.yml.before')) : null;
  if (hash(original) !== installed.beforeSha256) throw Error('Original profile backup hash mismatch');
  const req = createRequire(path.join(directory, 'resources/app.asar/dsh/package.json'));
  assertRuntimeVersion(req('@deepseek-ai/dsh-compaction-basic/package.json').version);
  const boot = req('@deepseek-ai/dsh-app-boot'), include = req('@deepseek-ai/cordis-plugin-include'), yaml = req('js-yaml');
  const schema = include.entryListSchema, parse = value => yaml.load(value.toString('utf8'), { schema }) || [];
  const current = bytes(profile), markerAt = current.indexOf(Buffer.from(core.MARKER));
  if (markerAt < 0) throw Error('Original managed block missing');
  const managed = parse(current.subarray(markerAt));
  const pruning = managed.filter(row => ['preset-standard', 'preset-ptc', 'preset-cordis'].includes(row.id));
  const memory = managed.filter(row => row.insert?.some(item => item.id === 'conversation-reference-memory'));
  if (managed.length !== 4 || pruning.length !== 3 || memory.length !== 1) throw Error('Unexpected managed patch shape');
  const context = { home, dir: path.dirname(profile), patchPath: profile, installAnchor: req.resolve('@deepseek-ai/dsh/package.json') };
  const bundles = boot.readBundlePatches('memory-registration-check', context);
  const homeRows = boot.loadOptionalPatches('memory-registration-check', path.join(home, 'cordis.patch.yml')) || [];
  const userRows = original === null ? [] : parse(original);
  const before = boot.composeEntries([bundles, parse(current), homeRows]);
  const after = boot.composeEntries([bundles, pruning, memory, userRows, homeRows]);
  if (!isDeepStrictEqual(before, after)) throw Error('Bundle ordering changes effective configuration; registration stopped');
  const manifestFile = path.join(home, 'profiles/desktop/package.json'), manifestBefore = bytes(manifestFile), manifest = JSON.parse(manifestBefore);
  for (const name of names) if (Object.hasOwn(manifest.dependencies || {}, name) || manifest.dsh?.profile?.bundles?.includes(name) || fs.existsSync(contained(home, relativeLink(name)))) throw Error('Existing package registration: ' + name);
  const updated = structuredClone(manifest);
  updated.dependencies ??= {};
  for (const name of names) updated.dependencies[name] = 'link:../../plugins/' + name;
  updated.dsh ??= {}; updated.dsh.profile ??= {}; updated.dsh.profile.bundles ??= [];
  updated.dsh.profile.bundles.push(names[1], names[0]);
  const changes = [
    { relative: 'plugins/' + names[1] + '/cordis.patch.yml', after: Buffer.from(yaml.dump(pruning, { schema, noRefs: true, lineWidth: -1 })) },
    { relative: 'plugins/' + names[0] + '/cordis.patch.yml', after: Buffer.from(yaml.dump(memory, { schema, noRefs: true, lineWidth: -1 })) },
    { relative: 'profiles/desktop/cordis.patch.yml', after: original ?? Buffer.from('[]\n') },
    { relative: 'profiles/desktop/package.json', after: Buffer.from(JSON.stringify(updated, null, 2) + '\n') },
  ];
  const lockFile = path.join(home, 'profiles/desktop/pnpm-lock.yaml');
  if (fs.existsSync(lockFile)) {
    const lockBefore = fs.readFileSync(lockFile, 'utf8'), parsed = yaml.load(lockBefore), expected = structuredClone(parsed);
    const anchor = /^  \.:\r?\n    dependencies:\r?\n/m;
    if (!anchor.test(lockBefore) || !expected?.importers?.['.']?.dependencies) throw Error('Unsupported pnpm importer format');
    const newline = lockBefore.includes('\r\n') ? '\r\n' : '\n';
    const addition = names.map(name => `      ${name}:${newline}        specifier: link:../../plugins/${name}${newline}        version: link:../../plugins/${name}${newline}`).join('');
    for (const name of names) {
      if (Object.hasOwn(expected.importers['.'].dependencies, name)) throw Error('Existing lockfile entry: ' + name);
      expected.importers['.'].dependencies[name] = { specifier: 'link:../../plugins/' + name, version: 'link:../../plugins/' + name };
    }
    const lockAfter = lockBefore.replace(anchor, match => match + addition);
    if (!isDeepStrictEqual(yaml.load(lockAfter), expected)) throw Error('Unrelated lockfile change');
    changes.splice(changes.length - 1, 0, { relative: 'profiles/desktop/pnpm-lock.yaml', after: Buffer.from(lockAfter) });
  }
  for (const change of changes) { const target = contained(home, change.relative); plain(target); change.before = bytes(target); }
  return { home, changes, links: names.map(name => ({ relative: relativeLink(name), target: 'plugins/' + name })), originalBackup: backup };
}
function register(plan) {
  const lock = path.join(plan.home, 'profiles/desktop/cordis.patch.yml.memory-install.lock');
  fs.closeSync(fs.openSync(lock, 'wx', 0o600));
  let backup;
  try {
    for (const change of plan.changes) if (hash(bytes(contained(plan.home, change.relative))) !== hash(change.before)) throw Error('Configuration changed concurrently');
    for (const link of plan.links) if (fs.existsSync(contained(plan.home, link.relative))) throw Error('Package link appeared concurrently');
    backup = path.join(plan.home, 'backups', 'dsh-memory-registration-' + crypto.randomUUID()); fs.mkdirSync(backup, { recursive: true });
    const receipt = { version: 1, kind: 'dsh-memory-desktop-registration', home: plan.home, originalBackup: plan.originalBackup, status: 'prepared', at: new Date().toISOString(), files: plan.changes.map((change, i) => ({ relative: change.relative, before: i + '.before', beforeHash: hash(change.before), afterHash: hash(change.after) })), links: plan.links };
    for (let i = 0; i < plan.changes.length; i++) if (plan.changes[i].before !== null) fs.writeFileSync(path.join(backup, i + '.before'), plan.changes[i].before, { flag: 'wx', mode: 0o600 });
    atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
    for (const link of plan.links) { const target = contained(plan.home, link.target), location = contained(plan.home, link.relative); plain(path.dirname(location)); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.symlinkSync(target, location, process.platform === 'win32' ? 'junction' : 'dir'); }
    for (const change of plan.changes) atomic(contained(plan.home, change.relative), change.after);
    receipt.status = 'registered'; atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
    return { registered: true, packages: names, backup, originalBackup: plan.originalBackup, restartRequired: true };
  } catch (error) { throw Error(error.message + (backup ? '\nRegistration recovery backup: ' + backup : '')); }
  finally { fs.unlinkSync(lock); }
}
function rollbackRegistration(backup, home) {
  home = path.resolve(home); backup = path.resolve(backup); backupInside(home, backup);
  const receiptFile = path.join(backup, 'receipt.json'), receipt = JSON.parse(fs.readFileSync(receiptFile));
  if (receipt.version !== 1 || receipt.kind !== 'dsh-memory-desktop-registration' || path.resolve(receipt.home) !== home || !['prepared', 'registered'].includes(receipt.status)) throw Error('Unsupported registration receipt');
  if (!Array.isArray(receipt.files) || receipt.files.some((row, i) => !allowedFiles.includes(row.relative) || row.before !== i + '.before') || new Set(receipt.files.map(row => row.relative)).size !== receipt.files.length || !isDeepStrictEqual(receipt.links, names.map(name => ({ relative: relativeLink(name), target: 'plugins/' + name })))) throw Error('Registration receipt paths mismatch');
  const lock = path.join(home, 'profiles/desktop/cordis.patch.yml.memory-install.lock'); fs.closeSync(fs.openSync(lock, 'wx', 0o600));
  try {
    const originals = receipt.files.map(row => {
      const target = contained(home, row.relative); plain(target);
      const before = row.beforeHash === null ? null : fs.readFileSync(path.join(backup, row.before));
      if (hash(before) !== row.beforeHash || ![row.beforeHash, row.afterHash].includes(hash(bytes(target)))) throw Error('Registration files edited; automatic rollback stopped');
      return { target, before };
    });
    for (const link of receipt.links) { const location = contained(home, link.relative), target = contained(home, link.target); if (fs.existsSync(location) && (!fs.lstatSync(location).isSymbolicLink() || fs.realpathSync(location) !== fs.realpathSync(target))) throw Error('Registered link changed; rollback stopped'); }
    for (const { target, before } of originals) { if (before === null) { if (fs.existsSync(target)) fs.unlinkSync(target); } else atomic(target, before); }
    for (const link of receipt.links) { const location = contained(home, link.relative); if (fs.existsSync(location)) fs.unlinkSync(location); }
    receipt.status = 'rolled-back'; atomic(receiptFile, JSON.stringify(receipt, null, 2));
    return { rolledBack: true, originalBackup: receipt.originalBackup, restartRequired: true };
  } finally { fs.unlinkSync(lock); }
}
function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i]; if (key === '--check') options.check = true; else if (['--backup', '--rollback', '--home', '--dsh-dir'].includes(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[key.slice(2)] = process.argv[++i]; else throw Error('Unknown or incomplete option: ' + key); }
  const directory = path.resolve(options['dsh-dir'] || path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness')), exe = path.join(directory, 'DeepSeek Harness.exe');
  if (!process.versions.electron) { const result = spawnSync(exe, [__filename, ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit' }); if (result.error) throw result.error; process.exitCode = result.status ?? 1; return; }
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  if (options.rollback) { if (options.check) throw Error('--rollback cannot combine with --check'); assertDesktopStopped(exe); console.log(JSON.stringify(rollbackRegistration(options.rollback, home), null, 2)); return; }
  if (!options.backup) throw Error('Pass --backup with the original memory installation backup');
  const plan = buildRegistrationPlan({ home, backup: options.backup, directory });
  if (options.check) { console.log(JSON.stringify({ checked: true, writes: false, packages: names, effectiveConfigurationPreserved: true }, null, 2)); return; }
  assertDesktopStopped(exe); console.log(JSON.stringify(register(plan), null, 2));
}
if (require.main === module) try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
module.exports = { buildRegistrationPlan, register, rollbackRegistration };
