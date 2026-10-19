'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const executable = process.env.DSH_EXE;
const anchor = process.env.DSH_RUNTIME_ANCHOR || (executable && path.join(path.dirname(executable), 'resources/app.asar/dsh/package.json'));
async function evaluate(expression) {
  if (!executable || !anchor) throw Error('Set DSH_EXE to the DSH desktop executable to run native tests.');
  const script = `Promise.resolve(${expression}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;})`;
  const result = await execute(executable, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_RUNTIME_ANCHOR: anchor }, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}
module.exports = { evaluate };
