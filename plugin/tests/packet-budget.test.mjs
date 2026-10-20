import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { WORKING_MEMORY_PROMPT } from '../library/lib/index.mjs';
import { requiredPacketChars, canonicalMemoryPacket, DEDUP_BUDGET_NOTICE } from '../lib/dedup-status.mjs';

test('production instructions admit whole original units that fit refresh and dedup envelopes including fallback coverage', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-packet-budget-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 10000 }, { workingPrompt: WORKING_MEMORY_PROMPT });
  t.after(async () => { await bridge.dispose(); if (dirname(realpathSync(rootDir)) !== realpathSync(tmpdir())) throw Error('Unsafe cleanup'); rmSync(rootDir, { recursive: true, force: true }); });
  const texts = ['budget_marker '+ 'A'.repeat(1400), 'budget_marker '+ 'B'.repeat(700), 'budget_marker '+ '😀'.repeat(3000)];
  const events = texts.map((text, seq) => ({ seq, time: seq + 1000, type: 'user/message',
    data: { id: 'original-'+seq, source: { kind: 'user' }, content: [{ type: 'text', text }] } }));
  const agent = { session: { id: 'budget-originals', seq: events.length, snapshotEvents: async () => events } };
  for (const maxChars of [900, 1600, bridge.evidenceChars, 2600]) {
    const result = await bridge.search(agent, { query: 'budget_marker', maxChars });
    assert.ok(requiredPacketChars(result.requiredUserOriginals.map(row => ({ text: row.wireText }))) <= maxChars);
    for (const source of result.requiredUserOriginals) {
      assert.equal(Array.from(texts[source.eventSeq]).slice(source.start, source.end).join(''), source.text);
    }
  }
  await bridge.refresh(agent, { query: 'budget_marker' });
  const entry = bridge.entries.get(agent.session.id), required = entry.requiredUserOriginals.map(row => ({ text: row.wireText }));
  assert.ok(required.length); assert.equal(entry.userOriginalCoverageIncomplete, true);
  required.push({ text: entry.coverageNotice });
  assert.ok(requiredPacketChars(required) <= bridge.packetBudget.dedup);
  const packet = canonicalMemoryPacket(bridge.instructions, required.map(row => row.text).join('\n\n'), true);
  assert.ok(Array.from(packet).length <= bridge.config.contextChars);
  assert.ok(packet.endsWith(DEDUP_BUDGET_NOTICE));
  assert.ok(Array.from(bridge.contextFor(agent)).length <= bridge.config.contextChars);
});

test('completed provenance migration is not rerun by empty flushes, new sources, or explicit search', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-repair-once-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 3000 },
    { libraryUrl: new URL('./fixtures/repair-once-library.mjs', import.meta.url).href });
  t.after(async () => { await bridge.dispose(); if (dirname(realpathSync(rootDir)) !== realpathSync(tmpdir())) throw Error('Unsafe cleanup'); rmSync(rootDir, { recursive: true, force: true }); });
  const events = [], agent = { session: { id: 'migration-once', get seq() { return events.length; }, snapshotEvents: async () => events } };
  await bridge.flush(agent);
  for (let seq = 0; seq < 3; seq++) {
    events.push({ seq, time: 1000+seq, type: 'user/message', data: { id: 'user-'+seq, source: { kind: 'user' }, content: [{ type: 'text', text: 'repair_marker exact source '+seq }] } });
    await bridge.flush(agent); await bridge.flush(agent);
    const result = await bridge.search(agent, { query: 'repair_marker' });
    assert.equal(result.searchIncomplete, false); assert.ok(result.refs.length);
  }
  assert.equal((await bridge.status(agent)).projectionVersion, 2);
});
