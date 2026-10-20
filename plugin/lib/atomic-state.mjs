import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Called only in the SQLite worker. Windows scanners/readers can briefly hold
 * the destination without delete-sharing. Retry replacement, never unlink the
 * previous committed cursor; a persistent failure remains an explicit error.
 */
export function atomicState(file, value, { rename = renameSync,
  wait = ms => Atomics.wait(sleeper, 0, 0, ms), delays = [10, 30, 60, 100] } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { rename(temporary, file); return attempt; }
      catch (error) {
        if (!retryable.has(error.code) || attempt >= delays.length) throw error;
        wait(delays[attempt]);
      }
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
