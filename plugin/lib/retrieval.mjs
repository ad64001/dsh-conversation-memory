import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

const coded = code => Object.assign(new Error(code), { code });
const chars = text => Array.from(text).length;

/** A client wait budget, not a real-time guarantee or a SQLite interrupt. */
export function retrievalScope(signal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason ?? coded('ABORTED'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(coded('SEARCH_TIMEOUT')), timeoutMs);
  return { signal: controller.signal, deadlineAt,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
}

export function waitForRetrieval(value, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? coded('ABORTED'));
    if (signal.aborted) { Promise.resolve(value).catch(() => {}); cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export function incompleteNotice(maxChars) {
  return ['Archive or search incomplete. Original session records remain available. Coverage is incomplete; check memory_status and retry.\n',
    'Search incomplete; not no-memory or full coverage.\n', 'Incomplete\n', '?'].find(text => chars(text) <= maxChars) ?? '';
}

export function incompleteSearch(maxChars, progress = {}) {
  const text = incompleteNotice(maxChars);
  return { text, chars: chars(text), refs: [], providedSources: [], omittedRefs: [], locatorRefs: [],
    candidateCount: 0, requiredUserOriginals: [], omittedUserOriginalRefs: [], missingMatchingUserMessages: 0,
    userOriginalCoverageIncomplete: true, searchIncomplete: true, retrievalStatus: 'deadline-incomplete', queryCount: 0, progress };
}

/** Backend seam: lookup(query, {signal}) returns canonical source records.
 * ES adapters must hydrate and validate refs from the same SQLite conversation
 * before returning records. Search hits/highlights are never trusted originals.
 * No backend may change authorization, source roles or source validity.
 */
export async function collectQueries({ queries, lookup, signal, deadlineAt, now = Date.now, onProgress, checkpoint,
  yieldControl = () => yieldImmediate() }) {
  const plan = [...new Set(queries)].slice(0, 9);
  const started = performance.now(), candidates = checkpoint?.candidates ?? new Map();
  let queryCount = checkpoint?.queryCount ?? 0, incomplete = false;
  const resumedQueryCount = queryCount, queryMs = checkpoint?.queryMs ?? [];
  for (const query of plan.slice(queryCount)) {
    signal?.throwIfAborted();
    if (now() >= deadlineAt) { incomplete = true; break; }
    const estimatedMs = queryMs.length ? queryMs.reduce((sum, ms) => sum + ms, 0) / queryMs.length : 0;
    if (queryCount > resumedQueryCount && deadlineAt - now() < estimatedMs) { incomplete = true; break; }
    const queryStarted = performance.now();
    const found = await lookup(query, { signal });
    queryMs.push(performance.now() - queryStarted);
    queryCount++;
    const seen = new Set();
    for (const record of found.records) {
      if (!Number.isSafeInteger(record.ref) || record.ref < 1 || seen.has(record.ref)) continue;
      seen.add(record.ref);
      const previous = candidates.get(record.ref);
      if (previous) previous.hits += queryCount === 1 ? 3 : 1;
      else candidates.set(record.ref, { record, hits: queryCount === 1 ? 3 : 1 });
    }
    if (checkpoint) Object.assign(checkpoint, { candidates, queryCount, queryMs });
    if (onProgress) await onProgress({ candidates, queryCount, plannedQueryCount: plan.length, resumedQueryCount, queryMs, incomplete: queryCount < plan.length,
      elapsedMs: performance.now() - started });
    if (queryCount === plan.length) break;
    await yieldControl();
    signal?.throwIfAborted();
    if (now() >= deadlineAt) { incomplete = true; break; }
  }
  return { candidates, queryCount, plannedQueryCount: plan.length, resumedQueryCount, queryMs, incomplete: incomplete && queryCount < plan.length,
    elapsedMs: performance.now() - started };
}

export class RetrievalMetrics {
  constructor(capacity = 256) { this.capacity = capacity; this.samples = []; this.calls = 0; this.incomplete = 0; this.errors = 0; }
  record(sample) {
    this.calls++; if (sample.incomplete) this.incomplete++; if (sample.error) this.errors++;
    this.samples.push({ elapsedMs: sample.elapsedMs, archiveMs: sample.archiveMs ?? null,
      workerMs: sample.workerMs ?? null, queryCount: sample.queryCount ?? null, stages: sample.stages ?? null });
    if (this.samples.length > this.capacity) this.samples.shift();
  }
  snapshot() {
    const sorted = this.samples.map(x => x.elapsedMs).sort((a, b) => a - b);
    const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
    return { calls: this.calls, incomplete: this.incomplete, errors: this.errors, windowSamples: sorted.length,
      windowCapacity: this.capacity, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
      maxMs: sorted.at(-1) ?? null, last: this.samples.at(-1) ?? null };
  }
}
