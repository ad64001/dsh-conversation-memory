import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const script = fileURLToPath(new URL('../fragment_model/dsh_recall.py', import.meta.url));
export async function readFragments(store, query, signal) {
  const rows = store.fragmentRows(query.scope);
  if (!rows.length) return query.browse ? {status:'inventory', options:[], total:0, nextOffset:null}
    : {status:'no_match', reason:query.confirm ? 'invalid_choice' : 'blocked'};
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  let runtime;
  try { runtime = JSON.parse(await readFile(join(home, 'fragment-model/runtime.json'), 'utf8')); }
  catch { throw fail('FRAGMENT_RUNTIME_UNAVAILABLE'); }
  const session = createHash('sha256').update(store.conversationId).digest('hex');
  const snapshot = JSON.stringify(rows);
  const input = JSON.stringify({ session, rows, query });
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  bounded.throwIfAborted();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(runtime.python, ['-B','-X','utf8',script], { windowsHide:true, stdio:['pipe','pipe','pipe'],
      env:{...process.env, DSH_FRAGMENT_ASSETS:runtime.assets}, signal:bounded });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { child.kill(); reject(fail('FRAGMENT_OUTPUT_LIMIT')); }
    });
    child.stderr.resume();
    child.on('error', () => reject(fail(bounded.aborted ? 'FRAGMENT_CANCELLED' : 'FRAGMENT_RUNTIME_UNAVAILABLE')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code !== 0) { reject(fail('FRAGMENT_INFERENCE_FAILED')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(fail('FRAGMENT_INFERENCE_FAILED')); }
    });
    child.stdin.end(input);
  });
  bounded.throwIfAborted();
  if (JSON.stringify(store.fragmentRows(query.scope)) !== snapshot) throw fail('STALE_FRAGMENT_QUERY');
  if (result.status === 'grounded') {
    for (const item of result.observations) {
      const evidence = store.sourceEvidence(Number(item.source), {includeInactive:false});
      if (!evidence || !evidence.text.includes(item.cue)) throw fail('STALE_FRAGMENT_QUERY');
      item.ref = evidence.ref;
      item.role = evidence.sourceRole;
      delete item.source;
    }
    const evidence = store.sourceEvidence(Number(result.source), {includeInactive:false});
    if (!evidence || !evidence.text.includes(result.cue)) throw fail('STALE_FRAGMENT_QUERY');
    result.ref = evidence.ref;
    result.sourceRole = evidence.sourceRole;
    result.sourceQuote = result.cue;
    delete result.source;
  }
  return result;
}
