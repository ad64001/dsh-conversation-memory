import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationMemory } from '../lib/index.mjs';
import { association } from '../lib/fragments.mjs';

test('indexing groups equivalent observations, retains individual original refs and excludes retracted spans after reopening', async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(),'dsh-fragment-test-'));
  const options = {rootDir, conversationId:'fragment-test'};
  const memory = new ConversationMemory({...options,model:async ({messages})=>{
    const [source] = JSON.parse(messages[1].content).sources;
    const fragment = {conditions:{stage:'accepted',dry:true},action:'cap',result:{batch:64},cue:source.text};
    return {finish:'stop',text:JSON.stringify({records:[{ref:source.ref,kind:'decision',quote:source.text,fragment}]})};
  }});
  t.after(()=>{memory.close();rmSync(rootDir,{recursive:true,force:true});});
  const docs = ['Use 64 for the accepted dry run.', 'Accepted dry runs use sixty-four.'].map(text=>memory.append({role:'user',text}));
  const report = await memory.indexMessages({messageIds:docs.map(x=>x.id),maxCalls:2});
  assert.equal(report.rejected.length,0);
  const observations = memory.store.fragmentRows('conversation');
  assert.deepEqual(observations.map(row=>row.cue),docs.map(doc=>doc.text));
  assert.deepEqual(observations.map(row=>row.ref),report.added);
  const duplicate = {conditions:{dry:true,stage:'accepted'},action:'cap',result:{batch:64},cue:docs[0].text};
  assert.equal(memory.store.learnFragment(report.added[0],duplicate).added,false);
  assert.throws(()=>memory.store.learnFragment(report.added[0],{...duplicate,cue:'not in original'}));
  assert.equal(memory.stats().fragmentUnits,1);
  assert.equal(memory.stats().fragmentObservations,2);
  memory.retract(report.added[0]);
  assert.throws(()=>memory.store.learnFragment(report.added[0],duplicate));
  memory.close();
  const reopened = new ConversationMemory(options);
  try {
    assert.deepEqual(reopened.store.fragmentRows('conversation').map(row=>row.ref),[report.added[1]]);
    assert.equal(reopened.read(report.added[0]).text,docs[0].text);
    assert.deepEqual(reopened.store.fragmentRows('alternate'),[]);
  } finally {reopened.close();}
});

test('association accepts typed state and forward links, rejects ambiguous query shapes',()=>{
  assert.deepEqual(association({toward:{ready:false,count:0}}).toward,{count:0,ready:false});
  assert.throws(()=>association({context:{stage:'initial'}}));
  assert.throws(()=>association({context:{stage:NaN},browse:true}));
  assert.throws(()=>association({browse:true,confirm:'a'.repeat(64)}));
  assert.throws(()=>association({cue:'what',after:'[1]'}));
  assert.throws(()=>association({cue:'what',unexpected:true}));
});
