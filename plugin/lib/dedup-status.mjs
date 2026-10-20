// Host budget accounting only. This notice never represents source evidence or
// a semantic retirement decision, and is priced inside existing status reserve.
import { createHash } from 'node:crypto';
import { evidenceBody } from './runtime-memory.mjs';
export const DEDUP_BUDGET_NOTICE = 'Approved evidence exceeds the budget; read omitted sources. Coverage is incomplete.';
export const DEDUP_STATUS_RESERVE = 320;

export function canonicalMemoryPacket(instructions, evidence, incomplete = false) {
  if (typeof instructions !== 'string' || typeof evidence !== 'string' || typeof incomplete !== 'boolean') {
    throw new TypeError('Invalid canonical memory packet');
  }
  const packet = evidence ? instructions + '\n' + evidence : instructions;
  return incomplete ? packet + '\n' + DEDUP_BUDGET_NOTICE : packet;
}

/** Only an exact packet already proven by the live commit or restoration may
 * separate its host-generated suffix from source evidence. Unproven legacy or
 * quoted lookalikes remain byte-for-byte input to the model. */
export function snapshotEvidence(owned, instructions, approved) {
  const original = evidenceBody(owned, instructions);
  if (approved?.optionalCoverageIncomplete !== true || typeof approved.evidenceText !== 'string'
    || canonicalMemoryPacket(instructions, approved.evidenceText, true) !== approved.text
    || !approved.variants?.has(owned)
    || !(owned === approved.text || owned.startsWith(approved.text + '\n'))) return { text: original };
  const text = approved.evidenceText;
  if (!original.startsWith(text)) return { text: original };
  const suffix = original.slice(text.length);
  const cp = value => Array.from(value).length;
  const sha = value => createHash('sha256').update(value).digest('hex');
  return { text, transport: { originalChars: cp(original), inputChars: cp(text),
    excludedProgramSuffix: { start: cp(text), end: cp(original), sha256: sha(suffix) },
    approvedCanonicalSha256: sha(approved.text) } };
}
