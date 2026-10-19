const { verifySource } = require('./install-core.cjs');
const path = require('node:path');
try { const m = verifySource(path.resolve(__dirname, '..')); console.log(JSON.stringify({ passed: true, version: m.version, files: m.files.length })); }
catch (error) { console.error(error.message); process.exitCode = 1; }
