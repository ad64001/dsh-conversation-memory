#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const core = require('./install-core.cjs');
function argumentsFor(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--check', '--help'].includes(key)) options[key.slice(2)] = true;
    else if (['--dsh-dir', '--home', '--rollback'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key.slice(2)] = argv[++i];
    else throw Error('Unknown or incomplete option: ' + key);
  }
  return options;
}
function desktopDir(input) {
  const candidates = input ? [input] : [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'DeepSeek Harness')];
  const found = candidates.map(x => path.resolve(x)).find(x => fs.existsSync(path.join(x, 'DeepSeek Harness.exe')) && fs.existsSync(path.join(x, 'resources', 'app.asar')));
  if (!found) throw Error('DSH desktop not found. Pass --dsh-dir "C:\\path\\to\\DeepSeek Harness"');
  return found;
}
function assertDesktopStopped(exe) {
  const command = 'Get-CimInstance Win32_Process -Filter "Name = \'DeepSeek Harness.exe\'" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 30000 }).trim();
  const rows = out ? JSON.parse(out) : [];
  const running = (Array.isArray(rows) ? rows : [rows]).filter(p => Number(p.ProcessId) !== process.pid);
  if (running.length) throw Error('Quit DSH completely before installation/rollback (including its tray icon). --check is read-only and may run while DSH is open.');
}
function buildPlan(options, root, directory) {
  core.verifySource(root);
  const req = createRequire(path.join(directory, 'resources/app.asar/dsh/package.json'));
  const nativeVersion = req('@deepseek-ai/dsh-compaction-basic/package.json').version;
  if (nativeVersion !== '0.2.1-rc.2') throw Error('Only DSH 0.2.1-rc.2 is supported; found ' + nativeVersion);
  const boot = req('@deepseek-ai/dsh-app-boot'), include = req('@deepseek-ai/cordis-plugin-include'), yaml = req('js-yaml');
  const home = path.resolve(options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const dir = path.join(home, 'profiles/desktop'), profile = path.join(dir, 'cordis.patch.yml');
  if (!fs.existsSync(path.join(dir, 'package.json'))) throw Error('Open DSH once to initialize its desktop profile, then close it.');
  const before = fs.existsSync(profile) ? fs.readFileSync(profile) : null;
  if (before?.includes(Buffer.from(core.MARKER))) throw Error('Already managed by this installer; use the recorded rollback first.');
  const context = { home, dir, patchPath: profile, installAnchor: req.resolve('@deepseek-ai/dsh/package.json') };
  const bundles = boot.readBundlePatches('dsh-memory-install', context);
  const user = boot.loadOptionalPatches('dsh-memory-install', profile) || [];
  const homePatches = boot.loadOptionalPatches('dsh-memory-install', path.join(home, 'cordis.patch.yml')) || [];
  const entries = boot.composeEntries([bundles, user, homePatches]);
  const destinations = core.NAMES.map(name => path.join(home, 'plugins', name));
  for (const dest of destinations) if (fs.existsSync(dest)) throw Error('Existing plugin destination; do not overwrite an unmanaged installation: ' + dest);
  const { patches, expected } = core.makePatches(entries, destinations);
  core.verifyComposition(entries, boot.composeEntries([bundles, user, patches, homePatches]), expected);
  const serialized = yaml.dump(patches, { schema: include.entryListSchema, noRefs: true, lineWidth: -1 });
  const reload = yaml.load(serialized, { schema: include.entryListSchema });
  core.verifyComposition(entries, boot.composeEntries([bundles, user, reload, homePatches]), expected);
  // Empty/flow YAML sequences cannot be concatenated with a block sequence.
  // Preserve a block-form original verbatim; otherwise serialize the same parsed
  // user patches plus our additions. The backup always keeps the original bytes.
  const prefix = before && user.length ? before : Buffer.alloc(0);
  let after = Buffer.concat([prefix, Buffer.from('\n' + core.MARKER + ' ' + core.BUILD_VERSION + '\n' + serialized + '# END DSH CONVERSATION MEMORY PUBLIC\n')]);
  try { yaml.load(after.toString('utf8'), { schema: include.entryListSchema }); }
  catch {
    after = Buffer.from(yaml.dump(user, { schema: include.entryListSchema, noRefs: true, lineWidth: -1 }) + '\n' + core.MARKER + ' ' + core.BUILD_VERSION + '\n' + serialized + '# END DSH CONVERSATION MEMORY PUBLIC\n');
    const combined = yaml.load(after.toString('utf8'), { schema: include.entryListSchema });
    core.verifyComposition(entries, boot.composeEntries([bundles, combined, homePatches]), expected);
  }
  return { source: root, home, profile, before, after, destinations, nativeVersion, basicUrl: pathToFileURL(req.resolve('@deepseek-ai/dsh-compaction-basic')).href,
    piAiUrl: pathToFileURL(req.resolve('@deepseek-ai/dsh-llm-pi-ai')).href };
}
function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log('node scripts/install.cjs [--check] [--dsh-dir DIR] [--home DSH_HOME]\nnode scripts/install.cjs --rollback BACKUP_DIR [--dsh-dir DIR] [--home DSH_HOME]\nWindows DSH 0.2.1-rc.2 only. Close DSH before changes.'); return; }
  if (process.platform !== 'win32') throw Error('The desktop installer currently supports Windows only; the standalone library is cross-platform.');
  const directory = desktopDir(options['dsh-dir']), exe = path.join(directory, 'DeepSeek Harness.exe');
  if (!process.versions.electron) {
    const result = spawnSync(exe, [__filename, ...process.argv.slice(2), ...(options['dsh-dir'] ? [] : ['--dsh-dir', directory])], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1; return;
  }
  if (options.rollback) {
    if (options.check) throw Error('--check cannot be combined with --rollback');
    assertDesktopStopped(exe);
    console.log(JSON.stringify(core.rollback(options.rollback, options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')), null, 2)); return;
  }
  const root = path.resolve(__dirname, '..'), plan = buildPlan(options, root, directory);
  if (options.check) { console.log(JSON.stringify({ checked: true, writes: false, sourceVersion: core.BUILD_VERSION, nativeVersion: plan.nativeVersion, profile: plan.profile, changes: ['Replace tool cropper in standard/ptc/cordis', 'Add cache-stable conversation memory and Go session affinity'], existingPresetConfigPreserved: true, thresholdsAndNativeSummaryUnchanged: true }, null, 2)); return; }
  assertDesktopStopped(exe);
  console.log(JSON.stringify(core.install(plan), null, 2));
}
if (require.main === module) try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
module.exports = { argumentsFor, buildPlan };
