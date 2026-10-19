const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['library/tests', 'plugin/tests', 'semantic-pruner/tests', 'bench/tests', 'scripts/tests'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.test.mjs') || name.endsWith('.test.cjs')).sort().map(name => path.join(root, dir, name)));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
