import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { memorySurface } from './runtime-memory.mjs';
import { canonicalMemoryPacket } from './dedup-status.mjs';

export const APPROVAL_READ_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, records: 2048 });
const cp = text => Array.from(text).length;
const sha = text => createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashPattern = /^[a-f0-9]{64}$/u;
const sameStamp = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
const wholeStatus = /^(?:整理未完成（[A-Z_]{1,50}）。以下仍是上次模型批准的历史包，可能过时；新原文在库内，请 memory_status 或回读核对，下步重试。|Maintenance incomplete \([A-Z_]{1,50}\)\. The previous model-approved packet follows and may be stale\. New originals remain in the store; check memory_status or read sources, then retry\.)$/u;
const shortStatus = /^本会话记忆整理未完成（[A-Z_]{1,50}）：原文仍在会话库，当前没有已验证的新记忆包，不能声称查全。可用 memory_status 检查并按引用回读；下步重试。$/u;
const singleLine = (pattern, text) => !/[\r\n\u2028\u2029]/u.test(text) && pattern.test(text);

/** No content inference: only the program's exact, single-line status format
 * may accompany an already proven complete canonical. Markers alone prove no
 * model approval, and arbitrary suffixes are never treated as transport data. */
function transportVariant(text, canonical) {
  return text === canonical || singleLine(shortStatus, text)
    || text.startsWith(canonical + '\n') && singleLine(wholeStatus, text.slice(canonical.length + 1));
}

async function readAudit(file) {
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(APPROVAL_READ_LIMITS.bytes)) return null;
    // One additional byte detects growth without an unbounded readFile race.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await stat(file, { bigint: true });
    if (bytes !== Number(before.size) || !sameStamp(before, after) || !sameStamp(after, named)) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    if (!text.endsWith('\n')) return null;
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > APPROVAL_READ_LIMITS.records || lines.some(line => !line.trim())) return null;
    const records = lines.map(line => JSON.parse(line));
    if (records.some(record => !object(record))) return null;
    return { records, stamp: after };
  } finally { await handle.close(); }
}

/** Verify ONE existing approval against exact immutable native events and the
 * current owned surface. This does not reconstruct the old model's complete
 * current input, re-evaluate relevance, or claim coverage of new required text. */
export async function verifyApprovedRecord({ record, sessionId, route, instructions, maxChars, events, view }) {
  try {
    if (!object(record) || record.sessionId !== sessionId || record.state !== 'ready' || record.modelDecides !== true
      || record.provider !== route.provider || record.model !== route.model
      || typeof record.completedAt !== 'string' || record.completedAt.length > 64 || !Number.isFinite(Date.parse(record.completedAt))
      || !Number.isSafeInteger(record.calls) || record.calls < 1 || record.calls > 128
      || !Array.isArray(record.requestMetadata) || record.requestMetadata.length !== record.calls
      || !record.requestMetadata.some(item => object(item) && item.status === 'accepted' && item.finish === 'stop'
        && typeof item.responseHash === 'string' && hashPattern.test(item.responseHash))
      || !Array.isArray(record.sourceSelection) || record.sourceSelection.length > 128
      || !Array.isArray(record.replacements) || !record.replacements.length || record.replacements.length > 257
      || !Array.isArray(events) || !Array.isArray(view?.slots) || !view.slots.length) return null;
    if (events.some((event, index) => !object(event) || event.seq !== index)) return null;
    if (record.requestMetadata.some(item => !object(item) || item.status === 'accepted'
      && (item.finish !== 'stop' || typeof item.responseHash !== 'string' || !hashPattern.test(item.responseHash)))) return null;
    const quotes = [];
    let bodyChars = 0;
    for (const source of record.sourceSelection) {
      if (!object(source) || typeof source.sourceId !== 'string' || !source.sourceId || source.sourceId.length > 256
        || !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 0 || source.end <= source.start
        || typeof source.quote !== 'string' || source.quote.length > maxChars * 2 || !source.quote.isWellFormed() || cp(source.quote) !== source.end - source.start
        || typeof source.sha256 !== 'string' || !hashPattern.test(source.sha256) || sha(source.quote) !== source.sha256) return null;
      bodyChars += source.end - source.start + (quotes.length ? 2 : 0);
      if (cp(instructions) + 1 + bodyChars > maxChars) return null;
      quotes.push(source.quote);
    }
    const expectedOmissions = record.requestMetadata.flatMap(item => item.status === 'accepted'
      ? (item.omittedApprovedIds ?? []).map(id => ({ call: item.call, id })) : []);
    const omissions = record.omittedApprovedCandidates ?? [];
    if ((record.optionalCoverageIncomplete !== undefined && typeof record.optionalCoverageIncomplete !== 'boolean')
      || !Array.isArray(omissions) || omissions.length > 4096
      || omissions.some(item => !object(item) || !Number.isSafeInteger(item.call) || item.call < 0
        || typeof item.id !== 'string' || !item.id || item.id.length > 256)
      || JSON.stringify(omissions) !== JSON.stringify(expectedOmissions)
      || (record.optionalCoverageIncomplete === true) !== (omissions.length > 0)) return null;
    const body = quotes.join('\n\n');
    const canonical = canonicalMemoryPacket(instructions, body, record.optionalCoverageIncomplete === true);
    if (!Number.isSafeInteger(record.canonicalChars) || record.canonicalChars !== cp(canonical) || cp(canonical) > maxChars) return null;
    const bySeq = new Map(events.map(event => [event.seq, event]));
    const proofSeqs = new Set();
    for (const replacement of record.replacements) {
      if (!object(replacement) || !Number.isSafeInteger(replacement.seq) || !Number.isSafeInteger(replacement.sourceSeq)
        || replacement.sourceSeq < 0 || replacement.seq <= replacement.sourceSeq) return null;
      const event = bySeq.get(replacement.seq), original = bySeq.get(replacement.sourceSeq);
      if (event?.type !== 'user/message' || original?.type !== 'user/message'
        || event.surfaceOp?.op !== 'replace' || event.surfaceOp.startSeq !== replacement.sourceSeq || event.surfaceOp.endSeq !== replacement.sourceSeq
        || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== replacement.sourceSeq) return null;
      proofSeqs.add(replacement.seq); proofSeqs.add(replacement.sourceSeq);
    }
    // Use the same recognizer as production; do not approve a quoted marker or
    // malformed snapshot merely because its text resembles a canonical packet.
    const historical = await memorySurface({ snapshotEvents: async () => events, surface: { nodes: [...proofSeqs] } });
    if (historical.runtimes.length !== proofSeqs.size) return null;
    const approvalSeqs = record.replacements.map(item => item.seq)
      .filter(seq => historical.slots.some(slot => slot.seq === seq && slot.owned === canonical));
    if (!approvalSeqs.length) return null;
    const visible = view.slots.map(slot => slot.owned);
    if (visible.some(text => typeof text !== 'string' || cp(text) > maxChars || !transportVariant(text, canonical))) return null;
    if (!visible.some(text => text === canonical || text.startsWith(canonical + '\n') && singleLine(wholeStatus, text.slice(canonical.length + 1)))) return null;
    const approvalEventSeq = approvalSeqs.at(-1);
    return { text: canonical, provider: record.provider, model: record.model, completedAt: record.completedAt,
      evidenceText: body, optionalCoverageIncomplete: record.optionalCoverageIncomplete === true,
      variants: new Set([canonical, ...visible]), proof: { sessionId, provider: record.provider, model: record.model, completedAt: record.completedAt,
        approvalSeqs, approvalEventSeq, approvalEventSha256: sha(JSON.stringify(bySeq.get(approvalEventSeq))), canonicalSha256: sha(canonical),
        policySha256: sha(instructions), auditRecordSha256: sha(JSON.stringify(record)), sourceSelectionSha256: sha(JSON.stringify(record.sourceSelection)),
        currentOwnedSha256s: visible.map(sha), currentOwnedSources: view.slots.map(slot => ({ seq: slot.seq, sha256: sha(slot.owned) })), viewFingerprint: view.fingerprint,
        restoredWholePackageOnly: true, oldInputFingerprintRestored: false, newRequiredCoverageClaimed: false } };
  } catch { return null; }
}

/** Read-only bounded rehydration of transport provenance. Unknown, malformed,
 * changed, oversized or divergent state fails closed. No surface is edited. */
export async function restoreApprovedPackage({ sessionId, route, instructions, maxChars, rootDir, session, view }) {
  try {
    if (typeof sessionId !== 'string' || !sessionId || session?.id !== sessionId
      || !object(route) || typeof route.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model
      || typeof instructions !== 'string' || !instructions || !instructions.isWellFormed()
      || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8192 || typeof rootDir !== 'string' || !rootDir) return null;
    if (instructions.length > maxChars * 2 || cp(instructions) > maxChars) return null;
    const initial = await memorySurface(session);
    if (view && view.fingerprint !== initial.fingerprint) return null;
    const file = join(rootDir, sha(sessionId), 'dedup-audit.jsonl');
    const audit = await readAudit(file);
    if (!audit || audit.records.some(record => record.sessionId !== sessionId)) return null;
    // Never fall through a bad/latest approval to an earlier, different plan.
    const record = [...audit.records].reverse().find(item => item.state === 'ready');
    if (!record) return null;
    const restored = await verifyApprovedRecord({ record, sessionId, route, instructions, maxChars, events: initial.events, view: initial });
    if (!restored || (await memorySurface(session)).fingerprint !== initial.fingerprint
      || !sameStamp(audit.stamp, await stat(file, { bigint: true }))) return null;
    return restored;
  } catch { return null; }
}
