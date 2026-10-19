import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationMemoryBridge, evidenceAlreadyVisible } from '../lib/index.mjs';
import { createHash } from 'node:crypto';
import { withOpenCodeSession, installOpenCodeAffinity } from '../lib/opencode-affinity.mjs';

function fixture() {
  const events = [{seq:0,type:'user/message',data:{id:'original-user',source:{kind:'user'},content:[{type:'text',text:'audit the staged code'}]}}];
  const session = {id:'cache-test',surface:{nodes:[0],replaceGeneration:0},append(){throw Error('Ordinary memory refresh must not rewrite history');},snapshotEvents:async()=>events,requestHeader:()=>({config:{provider:'opencode-go',model:'deepseek-v4.1-flash'}})};
  const agent={session},bridge=new ConversationMemoryBridge({logger:{warn(){}}});
  const entry={id:session.id,agent,session,cache:'',cacheVersion:0};bridge.entries.set(session.id,entry);
  bridge.ensure=async()=>entry;
  let refreshes=0,consolidations=0;
  bridge.refreshBounded=async()=>{entry.cache=`exact recalled source ${++refreshes}`;};
  bridge.consolidate=async()=>{consolidations++;};
  const decision=Object.freeze({kind:'enter'}),config=Object.freeze({provider:'opencode-go',model:'deepseek-v4.1-flash'});
  const step=async(turn,extra={})=>{assert.equal(await bridge.preStep({agent,turn,step:2,messages:[],signal:new AbortController().signal,...extra},async()=>decision),decision);assert.equal(await bridge.beforeRequest({agent,signal:new AbortController().signal},async()=>config),config);};
  return{bridge,entry,events,session,agent,step,counts:()=>({refreshes,consolidations})};
}

test('default native path freezes recalled context across tool steps without rewriting cached history',async()=>{
  const f=fixture();await f.step(1);const packet=f.bridge.contextFor(f.agent),before=structuredClone(f.events);
  for(let n=0;n<5;n++){f.events.push({seq:n+1,type:'tool/result',data:{message:{content:[{type:'text',text:`new tool evidence ${n}`}]}}});await f.step(1);assert.equal(f.bridge.contextFor(f.agent),packet);}
  assert.deepEqual(f.events.slice(0,before.length),before);assert.deepEqual(f.counts(),{refreshes:1,consolidations:0});
  await f.step(2);assert.notEqual(f.bridge.contextFor(f.agent),packet);assert.deepEqual(f.counts(),{refreshes:2,consolidations:0});
});
test('native compaction permits one consolidation, then the new epoch is stable',async()=>{
  const f=fixture();await f.step(1);f.session.surface.replaceGeneration++;await f.step(1);await f.step(1);
  assert.deepEqual(f.counts(),{refreshes:2,consolidations:1});assert.equal(f.entry.compactionMaintenance,false);
});
test('rejected and cancelled admission cannot change the current memory packet',async()=>{
  const f=fixture();await f.step(1);const packet=f.bridge.contextFor(f.agent),rejected={kind:'reject'};
  assert.equal(await f.bridge.preStep({agent:f.agent,turn:2,messages:[]},async()=>rejected),rejected);
  const controller=new AbortController();controller.abort();await f.step(2,{signal:controller.signal});
  assert.equal(f.bridge.contextFor(f.agent),packet);assert.deepEqual(f.counts(),{refreshes:1,consolidations:0});
});
test('model route changes and a new session cannot inherit another turn freeze',async()=>{
  const f=fixture();await f.step(1);f.session.requestHeader=()=>({config:{provider:'other',model:'other'}});await f.step(1);
  assert.deepEqual(f.counts(),{refreshes:2,consolidations:0});
});
test('a genuine user correction inside the current turn refreshes recall without rewriting history',async()=>{
  const f=fixture();await f.step(1);f.events.push({seq:1,type:'user/message',data:{id:'new-correction',source:{kind:'user'},content:[{type:'text',text:'Correction: use the newly specified read-only scope'}]}});
  await f.step(1);await f.step(1);assert.deepEqual(f.counts(),{refreshes:2,consolidations:0});
});
test('duplicate suppression requires exact active raw provenance and keeps missing, altered and omitted evidence',()=>{
  const text='Exact 😀 original readonly=true.',events=[{seq:4,time:1000,type:'user/message',data:{id:'raw',role:'user',source:{kind:'user'},content:[{type:'text',text}]}}];
  const result={refs:[1],providedSources:[{ref:1,eventSeq:4,start:0,end:Array.from(text).length,sha256:createHash('sha256').update(text).digest('hex')}],omittedRefs:[],userOriginalCoverageIncomplete:false};
  assert.equal(evidenceAlreadyVisible(result,events,[4]),true);
  assert.equal(evidenceAlreadyVisible(result,events,[]),false);
  assert.equal(evidenceAlreadyVisible({...result,providedSources:[{...result.providedSources[0],sha256:'bad'}]},events,[4]),false);
  assert.equal(evidenceAlreadyVisible({...result,userOriginalCoverageIncomplete:true},events,[4]),false);
  assert.equal(evidenceAlreadyVisible({...result,omittedRefs:[2]},events,[4]),false);
  assert.equal(evidenceAlreadyVisible({...result,providedSources:[]},events,[4]),false);
  assert.equal(evidenceAlreadyVisible(result,[{...events[0],surfaceOp:{op:'replace',startSeq:1,endSeq:1},data:{...events[0].data,source:{kind:'compaction'}}}],[4]),false);
});
function snapshot(baseUrl='https://opencode.ai/zen/go/v1') {
  return{profiles:new Map([['go',{headers:{'X-OpenCode-Session':'old-static','x-existing':'keep'}}],['other',{headers:{'x-existing':'untouched'}}]]),models:{getModel:()=>({baseUrl})}};
}
test('Go headers use the real conversation on main and helper calls without mutating shared settings',()=>{
  const original=snapshot(),before=structuredClone(original.profiles);
  const main=withOpenCodeSession(original,{provider:'go',model:'deepseek-v4.1-flash',sessionId:'conversation-A'});
  const helper=withOpenCodeSession(original,{provider:'go',model:'deepseek-v4.1-flash',sessionId:'conversation-A',purpose:'compaction'});
  const concurrent=withOpenCodeSession(original,{provider:'go',model:'deepseek-v4.1-flash',sessionId:'conversation-B'});
  assert.equal(main.profiles.get('go').headers['x-opencode-session'],'conversation-A');assert.equal(helper.profiles.get('go').headers['x-opencode-session'],'conversation-A');
  assert.equal(concurrent.profiles.get('go').headers['x-opencode-session'],'conversation-B');assert.deepEqual(original.profiles,before);assert.equal(main.models,original.models);assert.equal(main.profiles.get('other'),original.profiles.get('other'));
});
test('affinity leaves other hosts, protocols and missing or unsafe ids untouched',()=>{
  for(const base of ['https://example.com/zen/go/v1','https://opencode.ai.attacker.example/zen/go/v1','http://opencode.ai/zen/go/v1','https://opencode.ai/zen/v1']){const s=snapshot(base);assert.equal(withOpenCodeSession(s,{provider:'go',model:'x',sessionId:'session'}),s);}
  for(const sessionId of [undefined,'','bad\r\nheader','x'.repeat(513)]){const s=snapshot();assert.equal(withOpenCodeSession(s,{provider:'go',model:'x',sessionId}),s);}
  const s=snapshot('https://opencode.ai/inference/go/openai/v1');assert.notEqual(withOpenCodeSession(s,{provider:'go',model:'x',sessionId:'valid'}),s);
});
test('adapter compatibility hook is reversible and concurrent plugin owners share one wrapper',()=>{
  class Adapter{streamWithSnapshot(options,snapshot){return{options,snapshot};}}
  const original=Adapter.prototype.streamWithSnapshot,disposeA=installOpenCodeAffinity(Adapter),wrapped=Adapter.prototype.streamWithSnapshot,disposeB=installOpenCodeAffinity(Adapter);
  const result=new Adapter().streamWithSnapshot({provider:'go',model:'x',sessionId:'one'},snapshot());assert.equal(result.snapshot.profiles.get('go').headers['x-opencode-session'],'one');
  disposeA();disposeA();assert.equal(Adapter.prototype.streamWithSnapshot,wrapped);disposeB();assert.equal(Adapter.prototype.streamWithSnapshot,original);
});
