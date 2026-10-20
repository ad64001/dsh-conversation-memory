import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMemoryPacket, DEDUP_BUDGET_NOTICE, snapshotEvidence, DEDUP_STATUS_RESERVE } from '../lib/dedup-status.mjs';

test('budget notice is distinct from exact original evidence and absent on complete packing', () => {
  const original = '[7] user-original role=user\r\n> Keep exact 🧭 and trailing newline.\r\n';
  assert.equal(canonicalMemoryPacket('policy', original), 'policy\n' + original);
  assert.equal(canonicalMemoryPacket('policy', original, true), 'policy\n' + original + '\n' + DEDUP_BUDGET_NOTICE);
  assert.equal(canonicalMemoryPacket('policy', '', true), 'policy\n' + DEDUP_BUDGET_NOTICE);
  assert.throws(() => canonicalMemoryPacket('policy', original, 'true'), TypeError);
});

test('budget notice and worst accepted English failure status fit the bounded transport reserve', () => {
  const code = 'A'.repeat(50);
  const failure = `Maintenance incomplete (${code}). The previous model-approved packet follows and may be stale. New originals remain in the store; check memory_status or read sources, then retry.`;
  const base = 'x'.repeat(6000 - DEDUP_STATUS_RESERVE);
  assert.ok(Array.from(base + '\n' + DEDUP_BUDGET_NOTICE + '\n' + failure).length <= 6000);
});

test('only proven host suffixes leave the next evidence input; user lookalikes remain exact', () => {
  const body = '[7] user-original role=user\n> Exact quoted notice: ' + DEDUP_BUDGET_NOTICE + '\r\n';
  const canonical = canonicalMemoryPacket('policy', body, true);
  const approved = { text: canonical, evidenceText: body, optionalCoverageIncomplete: true, variants: new Set([canonical]) };
  const clean = snapshotEvidence(canonical, 'policy', approved);
  assert.equal(clean.text, body);
  assert.equal(clean.transport.excludedProgramSuffix.start, Array.from(body).length);
  assert.equal(clean.transport.inputChars, Array.from(body).length);
  assert.equal(snapshotEvidence(canonical, 'policy', undefined).text, body + '\n' + DEDUP_BUDGET_NOTICE);
  assert.equal(snapshotEvidence(canonical, 'changed policy', approved).text, canonical);
  assert.equal(snapshotEvidence(canonical + '\nunknown semantic suffix', 'policy', approved).text,
    body + '\n' + DEDUP_BUDGET_NOTICE + '\nunknown semantic suffix');
});
