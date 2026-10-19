const fs = require('node:fs'), path = require('node:path');
const { hash } = require('./install-core.cjs');
const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'dist', 'SOURCE_MANIFEST.json']);
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).filter(x => !ignored.has(x.name)).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(x => {
  const file = path.join(dir, x.name); if (x.isSymbolicLink()) throw Error('Source symlink: ' + file);
  return x.isDirectory() ? walk(file) : [{ path: path.relative(root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) }];
}); }
const result = { version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, algorithm: 'sha256', files: walk(root) };
fs.writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ files: result.files.length }));
