import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationMemory } from '../lib/index.mjs';

function fixture(t, model) {
  const tempRoot = path.resolve(os.tmpdir());
  const rootDir = mkdtempSync(path.join(tempRoot, 'conversation-race-'));
  const memory = new ConversationMemory({rootDir,conversationId:'race-conversation',model});
  t.after(() => {
    memory.close();
    // Check the exact freshly generated target before recursive cleanup.
    const target = path.resolve(rootDir);
    assert.equal(path.dirname(target),tempRoot);
    assert.ok(path.basename(target).startsWith('conversation-race-'));
    rmSync(target,{recursive:true,force:true});
  });
  return memory;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve=done;});
  return {promise,resolve};
}

const fullRef = (memory,message) => memory.cite({
  messageId:message.id,start:0,end:Array.from(message.text).length,
}).ref;

test('a delayed reranker cannot restore a superseded pin after a trusted confirmation', {timeout:5000}, async t => {
  const entered = deferred();
  const release = deferred();
  let calls=0;
  let oldRef;
  const memory=fixture(t,async request => {
    calls+=1;
    const payload=JSON.parse(request.messages[1].content);
    entered.resolve(payload);
    await release.promise;
    // This response was valid against the old snapshot, but it arrives late.
    return {finish:'stop',text:JSON.stringify({refs:[oldRef]})};
  });
  const old=memory.append({role:'user',text:'Current budget=100. Keep within this limit.'});
  oldRef=fullRef(memory,old);
  memory.remember({ref:oldRef,kind:'constraint',origin:'user',pinned:true});
  const corrected=memory.append({role:'user',text:'Correction: current budget=60. Replace the previous limit.'});
  const newRef=fullRef(memory,corrected);
  memory.remember({ref:newRef,kind:'correction',origin:'model',pinned:false});
  const before=memory.stats();
  const pending=memory.buildContext({query:'budget',currentTask:'Check the current budget',maxChars:4000});
  try {
    const oldSnapshot=await entered.promise;
    assert.ok(oldSnapshot.candidates.some(record=>record.ref===oldRef&&record.active));
    // No messages are appended during the wait: relation/confirmation changes
    // themselves must invalidate the in-flight snapshot.
    memory.confirm(newRef,{pinned:true});
    memory.supersede(oldRef,newRef);
    assert.equal(memory.stats().messages,before.messages);
    assert.equal(memory.stats().memories,before.memories);
    assert.equal(memory.stats().confirmations,before.confirmations+1);
    assert.equal(memory.stats().relations,before.relations+1);
    release.resolve();
    const result=await pending;
    assert.equal(result.retrievalStatus,'local-state-changed');
    assert.ok(result.usedRefs.includes(newRef));
    assert.ok(!result.usedRefs.includes(oldRef));
    assert.ok(result.text.includes('budget=60'));
    assert.ok(!result.text.includes('budget=100'));
    assert.equal(result.citations.find(record=>record.ref===newRef).sourceRole,'user');
    assert.equal(memory.read(oldRef).active,false);
    assert.equal(calls,1);
  } finally {
    release.resolve();
    await pending.catch(()=>{});
  }
});

test('opt-in recent raw history cannot resurrect an overlapping retracted constraint', async t => {
  const memory=fixture(t);
  const old=memory.append({role:'user',text:'Historical note: Never deploy the staging branch. End note.'});
  const quote='Never deploy the staging branch.';
  const start=Array.from(old.text.slice(0,old.text.indexOf(quote))).length;
  const retiredRef=memory.cite({messageId:old.id,start,end:start+Array.from(quote).length}).ref;
  memory.remember({ref:retiredRef,kind:'constraint',origin:'user',pinned:true});
  memory.retract(retiredRef);
  const latest=memory.append({role:'tool',text:'Unrelated current diagnostic: process exited with status=0.'});
  const latestRef=fullRef(memory,latest);
  const oldFullRef=fullRef(memory,old);
  assert.notEqual(oldFullRef,retiredRef);
  assert.equal(memory.read(oldFullRef).active,false);
  assert.ok(memory.read(oldFullRef).relatedInactiveMemoryRefs.includes(retiredRef));
  const result=await memory.buildContext({query:'',currentTask:'Review current diagnostics',
    recentLimit:2,useModel:false,maxChars:4000});
  assert.deepEqual(result.usedRefs,[latestRef]);
  assert.ok(!result.usedRefs.includes(oldFullRef));
  assert.ok(!result.usedRefs.includes(retiredRef));
  assert.ok(!result.text.includes(quote));
  assert.ok(result.text.includes(latest.text));
  // The original remains readable for explicit historical inspection.
  assert.equal(memory.read(retiredRef).text,quote);
});
