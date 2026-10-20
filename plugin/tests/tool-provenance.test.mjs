import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { projectEvents } from '../lib/protocol.mjs';
import { openConversation } from '../../library/lib/index.mjs';

const call = (seq, turn, argumentsText, name = 'terminal') => ({ seq, time: 1000 + seq, type: 'tool/call', data: { turn, step: 1, callId: 'reused-id', name, arguments: argumentsText } });
const result = (seq, turn, text) => ({ seq, time: 1000 + seq, type: 'tool/result', sourceEventSeqs: [seq - 1], data: { turn, step: 1,
  message: { role: 'tool', source: { kind: 'tool-result', callId: 'reused-id' }, isError: false, content: [{ type: 'text', text }] } } });
function fixture(t, events) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-tool-provenance-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 10000 });
  const agent = { session: { id: 'tool-provenance', get seq() { return events.length; }, snapshotEvents: async () => events } };
  t.after(async () => { await bridge.dispose(); if (dirname(resolve(rootDir)) !== resolve(tmpdir())) throw Error('Unsafe cleanup'); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { rootDir, bridge, agent };
}

test('native argument strings retain exact bytes and are assistant actions, including malformed JSON', () => {
  const argument = '{"cmd":"Get-Content C:\\data\\audit.csv","readonly":true}';
  const projected = projectEvents([call(0, 1, argument), result(1, 1, 'Done')]);
  assert.equal(projected.records[0].role, 'assistant'); assert.equal(projected.records[1].role, 'tool');
  assert.equal(JSON.parse(projected.records[0].text).arguments, argument);
  assert.equal(projected.records[1].metadata.callEventSeq, 0);
  assert.equal(JSON.parse(projectEvents([call(0, 1, 'invalid { json')]).records[0].text).arguments, 'invalid { json');
  assert.equal(projectEvents([call(0, 1, argument, 'memory_search'), result(1, 1, 'self quote')]).records.length, 0);
});

test('real worker searches commands that occur only in tool/call and pairs call/result without crossing reused ids', async t => {
  const events = [call(0, 1, '{"command":"audit_only_parameter --readonly","budget":17}'), result(1, 1, 'Done first'),
    call(2, 2, '{"command":"second_action"}'), result(3, 2, 'Done second')];
  const { bridge, agent } = fixture(t, events);
  const found = await bridge.search(agent, { query: 'audit_only_parameter' }); assert.ok(found.refs.length);
  const read = await bridge.read(agent, { ref: found.refs[0] });
  assert.match(read.text, /audit_only_parameter/); assert.equal(read.provenance.role, 'assistant'); assert.equal(read.provenance.kind, 'tool-call');
  assert.equal(read.provenance.eventSeq, 0); assert.equal(read.relatedRefs.length, 1); assert.equal(read.relatedRefs[0].eventSeq, 1);
  const outcome = await bridge.read(agent, { ref: read.relatedRefs[0].ref });
  assert.match(outcome.text, /Done first/); assert.doesNotMatch(outcome.text, /Done second/); assert.equal(outcome.provenance.role, 'tool');
  const bounded = await bridge.read(agent, { ref: found.refs[0], maxChars: 256 }); assert.ok(bounded.chars <= 256);
  await bridge.flush(agent); assert.equal((await bridge.status(agent)).stats.messages, 4);
});

test('old archive cursors backfill tool calls and links idempotently while preserving existing result citations', async t => {
  const events = [call(0, 1, '{"command":"old_archive_parameter"}'), result(1, 1, 'Done legacy exact 😀'),
    call(2, 2, '{"command":"other_parameter"}'), result(3, 2, 'Done other')];
  const { rootDir, bridge, agent } = fixture(t, events);
  const old = openConversation({ rootDir, conversationId: agent.session.id });
  let originalRef;
  for (const event of events.filter(event => event.type === 'tool/result')) {
    const message = old.append({ sourceKey: `dsh:${agent.session.id}:${event.seq}`, role: 'tool', text: event.data.message.content[0].text,
      createdAt: new Date(event.time).toISOString(), metadata: { seq: event.seq, type: event.type, role: 'tool', time: event.time, toolName: 'terminal', isError: false } });
    const citation = old.cite({ messageId: message.id, start: 0, end: Array.from(message.text).length }); if (!originalRef) originalRef = citation.ref;
  }
  old.close();
  const directory = join(rootDir, createHash('sha256').update(agent.session.id).digest('hex'));
  writeFileSync(join(directory, 'bridge-state.json'), JSON.stringify({ schema: 1, conversationId: agent.session.id, archivedThroughSeq: 3, indexOffsets: {}, completedMessages: [], lastErrorCode: null }));
  await bridge.flush(agent);
  const status = await bridge.status(agent); assert.equal(status.projectionVersion, 2); assert.equal(status.stats.messages, 4);
  const legacy = await bridge.read(agent, { ref: originalRef }); assert.match(legacy.text, /Done legacy exact 😀/);
  assert.equal(legacy.requestedRef, originalRef); assert.equal(legacy.provenance.eventSeq, 1); assert.equal(legacy.relatedRefs[0].eventSeq, 0);
  const found = await bridge.search(agent, { query: 'old_archive_parameter' }); assert.ok(found.refs.length);
  await bridge.flush(agent); assert.equal((await bridge.status(agent)).stats.messages, 4);
  const store = openConversation({ rootDir, conversationId: agent.session.id });
  const raw = store.read(originalRef); assert.equal(raw.text, 'Done legacy exact 😀');
  assert.equal(raw.sourceMetadata.callId, undefined, 'immutable legacy metadata is not rewritten'); store.close();
});

test('detached actual DSH Session projects native tool arguments and source links', { skip: process.env.DSH_RUNTIME_NATIVE_TEST !== '1' }, async () => {
  const require = createRequire(import.meta.url), { evaluate } = require('../../scripts/native-evaluate.cjs');
  const modulePath = fileURLToPath(new URL('../lib/protocol.mjs', import.meta.url));
  const projected = await evaluate(`(async()=>{const req=require('node:module').createRequire(process.env.DSH_RUNTIME_ANCHOR),{Session}=req('@deepseek-ai/dsh-session');
    const {projectEvents}=await import(require('node:url').pathToFileURL(${JSON.stringify(modulePath)}).href);
    const session=Session.create('detached-tool-provenance');
    session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1});
    const seq=session.append('tool/call',{turn:1,step:1,callId:'native-call',name:'terminal',arguments:'{"command":"native_argument_marker"}'}).seq;
    session.append('tool/result',{turn:1,step:1,message:{id:'native-result',role:'tool',source:{kind:'tool-result',callId:'native-call'},content:[{type:'text',text:'Done native'}],isError:false}},{surfaceOp:'append',sourceEventSeqs:[seq]});
    return projectEvents(Array.from(await session.snapshotEvents()));})()`);
  assert.equal(projected.records.length, 2); assert.match(projected.records[0].text, /native_argument_marker/);
  assert.equal(projected.records[1].metadata.callEventSeq, projected.records[0].seq);
});

test('legacy backfill and fresh archives return the same native chronology at the default six-result limit', async t => {
  const events = Array.from({ length: 8 }, (_, turn) => [call(turn * 2, turn, '{"command":"chrono_marker --mode=old"}'),
    result(turn * 2 + 1, turn, turn === 7 ? 'chrono_marker mode=NEW; old mode ignored' : 'ordinary completion')]).flat();
  const upgraded = fixture(t, events), fresh = fixture(t, events);
  const old = openConversation({ rootDir: upgraded.rootDir, conversationId: upgraded.agent.session.id });
  let originalRef;
  for (const record of projectEvents(events).records.filter(row => row.role === 'tool')) {
    const message = old.append({ sourceKey: `dsh:${old.conversationId}:${record.seq}`, role: record.role, text: record.text, metadata: { ...record.metadata, sessionId: old.conversationId } });
    if (record.seq === 15) originalRef = old.cite({ messageId: message.id, start: 0, end: message.text.length }).ref;
  }
  old.close();
  const directory = join(upgraded.rootDir, createHash('sha256').update(upgraded.agent.session.id).digest('hex'));
  writeFileSync(join(directory, 'bridge-state.json'), JSON.stringify({ schema: 1, conversationId: upgraded.agent.session.id, archivedThroughSeq: 15, indexOffsets: {}, completedMessages: [] }));
  const a = await upgraded.bridge.search(upgraded.agent, { query: 'chrono_marker' });
  const b = await fresh.bridge.search(fresh.agent, { query: 'chrono_marker' });
  assert.equal(a.searchIncomplete, false); assert.equal(b.searchIncomplete, false);
  assert.deepEqual(a.providedSources.map(row => row.eventSeq), b.providedSources.map(row => row.eventSeq));
  assert.equal(a.providedSources[0].eventSeq, 15); assert.equal(a.providedSources.length, 6);
  assert.match((await upgraded.bridge.read(upgraded.agent, { ref: originalRef })).text, /mode=NEW/);
  await upgraded.bridge.flush(upgraded.agent); await upgraded.bridge.flush(upgraded.agent);
  assert.equal((await upgraded.bridge.status(upgraded.agent)).stats.messages, 16);
});

test('explicit call event references win, ambiguous same-step reused ids are left unpaired', () => {
  const calls = [call(0, 1, 'first'), call(1, 1, 'second')];
  const output = result(2, 1, 'result'); output.sourceEventSeqs = [0];
  assert.equal(projectEvents([...calls, output]).records.at(-1).metadata.callEventSeq, 0);
  delete output.sourceEventSeqs;
  assert.equal(projectEvents([...calls, output]).records.at(-1).metadata.callEventSeq, undefined);
  output.sourceEventSeqs = [99];
  assert.equal(projectEvents([...calls, output]).records.at(-1).metadata.callEventSeq, undefined);
  const self = call(1, 1, 'self', 'memory_search'); delete output.sourceEventSeqs;
  assert.equal(projectEvents([calls[0], self, output]).records.length, 1, 'an ambiguous self-tool result cannot feed the evidence store');
});
