import { openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Called only in the SQLite worker. Windows scanners/readers can briefly hold
 * the destination without delete-sharing. Retry replacement, never unlink the
 * previous committed cursor; a persistent failure remains an explicit error.
 */
export function atomicState(file, value, { rename = renameSync, open = openSync, close = closeSync,
  write = writeFileSync, unlink = unlinkSync,
  wait = ms => Atomics.wait(sleeper, 0, 0, ms), delays = [10, 30, 60, 100] } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor, owned = false, primary;
  try {
    descriptor = open(temporary, 'wx', 0o600); owned = true;
    write(descriptor, JSON.stringify(value));
    close(descriptor); descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try { rename(temporary, file); return attempt; }
      catch (error) {
        if (!retryable.has(error.code) || attempt >= delays.length) throw error;
        wait(delays[attempt]);
      }
    }
  } catch (error) { primary = error; throw error; }
  finally {
    let cleanup;
    if (descriptor !== undefined) try { close(descriptor); } catch (error) { cleanup = error; }
    if (owned) try { unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') cleanup ??= error; }
    if (cleanup) {
      if (primary) primary.cleanupError = cleanup;
      else throw cleanup;
    }
  }
}
