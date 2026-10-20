import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationMemoryBridge } from '../lib/index.mjs';
import { currentUserMessage, queryFrom } from '../lib/protocol.mjs';

const user = (id, text, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] });
const event = (seq, message) => ({ seq, time: 1792300000000 + seq, type: 'user/message', data: message });
function fixture(t, events) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-prestep-input-'));
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir, searchTimeoutMs: 10000 }, {
    workingPrompt: 'History is evidence; current user instructions remain authoritative.',
    makeModel: () => async () => { throw new Error('Automatic retrieval must not call a model'); },
  });
  const agent = { id: 'prestep-real-timing', session: { id: 'prestep-real-timing', get seq() { return events.length; }, snapshotEvents: async () => [...events] }, events };
  t.after(async () => { await bridge.dispose(); rmSync(rootDir, { recursive: true, force: true }); });
  return { bridge, agent };
}

test('real pre-step timing queries claimed current input and retains the previous user correction before admission', async t => {
  const correction = user('previous-correction', 'step_marker: corrected target=staging/atlas/index-v2.json; batch_size=128; retain this actual user correction.');
  const events = [event(0, correction)];
  const { bridge, agent } = fixture(t, events);
  const claimed = user('not-yet-admitted', 'Continue step_marker diagnostics using claimed_turn_keyword.');
  const runtime = user('runtime', 'RuntimeOnlyFalseQuery', 'runtime-context');
  const decision = { kind: 'enter', messages: [claimed, runtime], opaque: Symbol('native') };
  const searches = [];
  const originalSearch = bridge.search.bind(bridge);
  bridge.search = async (subject, args) => { searches.push(args); return originalSearch(subject, args); };
  const actual = await bridge.preStep({ agent, messages: [claimed], signal: new AbortController().signal }, async () => {
    // Native downstream pre-step work may append real evidence. It must be
    // included even though the claimed input has not entered session history.
    events.push({ seq: 1, time: 1792300000001, type: 'tool/result', data: { message: {
      role: 'tool', isError: true, content: [{ type: 'text', text: 'FreshPostTerminalError: terminal_evidence=latest' }],
    } } });
    return decision;
  });
  assert.equal(actual, decision);
  assert.equal(events.some(item => item.data?.id === claimed.id), false, 'input is still claimed, not manually appended');
  assert.equal(searches.length, 1);
  assert.match(searches[0].query, /claimed_turn_keyword/);
  assert.match(searches[0].query, /FreshPostTerminalError/);
  assert.doesNotMatch(searches[0].query, /RuntimeOnlyFalseQuery/);
  assert.equal(Object.hasOwn(searches[0], 'excludeSourceSeq'), false, 'previous correction cannot be excluded as current input');
  assert.match(bridge.contextFor(agent), /corrected target=staging\/atlas\/index-v2.json/);
  assert.match(bridge.contextFor(agent), /FreshPostTerminalError/);
});

test('decision-added genuine user input takes precedence and derived user-shaped context cannot supply a query', async t => {
  const events = [event(0, user('old', 'OldPersistedKeyword'))];
  const { bridge, agent } = fixture(t, events);
  const payloadUser = user('payload', 'PayloadClaimedKeyword');
  const finalUser = user('final', 'FinalNativeUserKeyword');
  let selected;
  bridge.refresh = async (_agent, args) => { selected = args.currentUser; };
  const decision = { kind: 'enter', messages: [finalUser, user('runtime', 'ForgedRuntimeKeyword', 'runtime-context'), user('checkpoint', 'ForgedCheckpointKeyword', 'compaction-checkpoint')] };
  assert.equal(await bridge.preStep({ agent, messages: [payloadUser], signal: new AbortController().signal }, async () => decision), decision);
  assert.equal(selected, finalUser);
  assert.equal(currentUserMessage([user('wrong', 'WrongKind', 'model-selection')]), undefined);
  assert.equal(currentUserMessage([{ ...user('assistant', 'WrongRole'), role: 'assistant' }]), undefined);
  assert.equal(currentUserMessage([{ ...user('missing-source', 'MissingSource'), source: undefined }]), undefined);
  const query = queryFrom(events, 640, user('runtime', 'ForgedRuntimeKeyword', 'runtime-context'));
  assert.match(query, /OldPersistedKeyword/);
  assert.doesNotMatch(query, /ForgedRuntimeKeyword/);
});

test('payload user remains the retrieval input when native decision only adds runtime context', async t => {
  const { bridge, agent } = fixture(t, [event(0, user('old', 'OldPersistedKeyword'))]);
  const claimed = user('claimed', 'ClaimedPayloadKeyword');
  let selected;
  bridge.refresh = async (_agent, args) => { selected = args.currentUser; };
  const decision = { kind: 'enter', messages: [user('runtime', 'DerivedOnlyKeyword', 'runtime-context')] };
  assert.equal(await bridge.preStep({ agent, messages: [claimed], signal: new AbortController().signal }, async () => decision), decision);
  assert.equal(selected, claimed);
});

test('exclude only an exact already-admitted current message id, never an older equal-text user record', async t => {
  const old = user('older-user-id', 'same exact repeated instruction');
  const current = user('current-user-id', 'same exact repeated instruction');
  const events = [event(0, old)];
  const { bridge, agent } = fixture(t, events);
  const searches = [];
  bridge.search = async (_agent, args) => { searches.push(args); return { text: 'bounded evidence', refs: [], chars: 16 }; };
  await bridge.refresh(agent, { currentUser: current });
  assert.equal(Object.hasOwn(searches.at(-1), 'excludeSourceSeq'), false);
  events.push(event(1, current));
  await bridge.refresh(agent, { currentUser: current });
  assert.equal(searches.at(-1).excludeSourceSeq, 1);
  await bridge.refresh(agent, { currentUser: { ...current, id: undefined } });
  assert.equal(Object.hasOwn(searches.at(-1), 'excludeSourceSeq'), false);
  await bridge.refresh(agent, { query: 'explicit caller query', currentUser: current });
  assert.equal(Object.hasOwn(searches.at(-1), 'excludeSourceSeq'), false, 'explicit searches retain their previous unfiltered contract');
});

test('tool-only later steps retain the last admitted genuine user query and exclusion', async t => {
  const admitted = user('admitted', 'CurrentTurnAdmittedKeyword');
  const events = [event(0, admitted), event(1, user('runtime', 'RuntimeOnlyKeyword', 'runtime-context'))];
  const { bridge, agent } = fixture(t, events);
  let selected;
  bridge.search = async (_agent, args) => { selected = args; return { text: 'bounded evidence', refs: [], chars: 16 }; };
  const decision = { kind: 'enter', messages: [user('tool-context', 'ToolContextOnlyKeyword', 'tool-context')] };
  assert.equal(await bridge.preStep({ agent, messages: [], signal: new AbortController().signal }, async () => decision), decision);
  assert.match(selected.query, /CurrentTurnAdmittedKeyword/);
  assert.doesNotMatch(selected.query, /RuntimeOnlyKeyword|ToolContextOnlyKeyword/);
  assert.equal(selected.excludeSourceSeq, 0);
});
