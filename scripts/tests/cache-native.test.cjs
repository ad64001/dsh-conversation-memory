const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {evaluate}=require('../native-evaluate.cjs');
test('native pi-ai wire options carry independent Go conversation headers on main and auxiliary calls',
{skip:process.env.DSH_RUNTIME_NATIVE_TEST!=='1'},async()=>{
 const helper=path.resolve(__dirname,'../../plugin/lib/opencode-affinity.mjs');
 const result=await evaluate(`(async()=>{
  const req=require('node:module').createRequire(process.env.DSH_RUNTIME_ANCHOR);
  const {PiAiAdapter}=req('@deepseek-ai/dsh-llm-pi-ai'),{installOpenCodeAffinity}=req(${JSON.stringify(helper)});
  const profile={modelErrors:new Map(),headers:{'x-custom':'preserved'},streamIdleTimeoutMs:30000},profiles=new Map([['opencode-go',profile]]),calls=[];
  const model={id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',provider:'opencode-go',api:'openai-completions',baseUrl:'https://opencode.ai/zen/go/v1',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const models={getModel:()=>model,streamSimple:(_m,_c,options)=>{calls.push(options.headers);return(async function*(){yield{type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'OK'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0}}})()}};
  const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=> 'synthetic-test-key'});adapter.snapshot={profiles,models};
  const dispose=installOpenCodeAffinity(PiAiAdapter);
  try{for(const [sessionId,purpose]of[['conversation-A','agent'],['conversation-A','compaction'],['conversation-B','agent']])for await(const chunk of adapter.stream({provider:model.provider,model:model.id,sessionId,purpose,messages:[{role:'user',content:[{type:'text',text:'inspect synthetic source'}]}],tools:[],maxTokens:32})){} }
  finally{dispose()}
  return{headers:calls.map(h=>({session:h['x-opencode-session'],custom:h['x-custom'],userAgent:!!h['user-agent']})),sharedUntouched:profile.headers['x-opencode-session']===undefined};
 })()`);
 assert.deepEqual(result,{headers:[{session:'conversation-A',custom:'preserved',userAgent:true},{session:'conversation-A',custom:'preserved',userAgent:true},{session:'conversation-B',custom:'preserved',userAgent:true}],sharedUntouched:true});
});
test('native Session preserves previously sent prefixes and does not loop on its own compaction relocation',
{skip:process.env.DSH_RUNTIME_NATIVE_TEST!=='1'},async()=>{
 const bridgePath=path.resolve(__dirname,'../../plugin/lib/index.mjs');
 const result=await evaluate(`(async()=>{
  const req=require('node:module').createRequire(process.env.DSH_RUNTIME_ANCHOR),{Session}=req('@deepseek-ai/dsh-session');
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
  const {ConversationMemoryBridge}=req(${JSON.stringify(bridgePath)}),rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-native-cache-'));
  const session=Session.create('cache-native-'+randomUUID()),agent={session},route={provider:'opencode-go',model:'deepseek-v4.1-flash'};session.requestHeader=()=>({config:route});
  let modelCalls=0,refreshes=0;
  const bridge=new ConversationMemoryBridge({logger:{warn(){}}},{rootDir,autoRecallTimeoutMs:10000},{workingPrompt:'Exact recalled source evidence.',makeModel:()=>async request=>{
   modelCalls++;const data=JSON.parse(request.messages[1].content),refs=data.required.map(x=>x.ref),selected=new Set(refs.length?['current']:[]);
   return{finish:'stop',text:JSON.stringify({version:3,requiredRefs:refs,decisions:data.sources.map(x=>({sourceId:x.id,action:selected.has(x.id)?'select':'retire',reason:selected.has(x.id)?'selected':'duplicate'})),candidateIds:[]})};
  }});
  const refresh=bridge.refreshBounded.bind(bridge);bridge.refreshBounded=(...args)=>{refreshes++;return refresh(...args)};
  const user=(id,text)=>session.append('user/message',{id,role:'user',source:{kind:'user'},content:[{type:'text',text}]},{surfaceOp:'append'});
  const runtime=()=>{const sections=[{name:'environment',text:'Stable test sandbox.'},{name:'conversation-memory:evidence',text:bridge.contextFor(agent)}];const text='Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\n\\n'+sections.map(s=>s.text).join('\\n\\n');const last=[...session.surface.nodes].reverse().map(seq=>session.eventAt(seq)).find(e=>e.type==='user/message'&&e.data.source?.kind==='runtime-context');if(last?.data.content[0].text!==text)session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text}]},{surfaceOp:'append'});};
  const wire=()=>session.surface.nodes.map(seq=>session.deriveEventMessage(session.eventAt(seq))).filter(Boolean).map(m=>({role:m.role,content:m.content}));
  const step=async(turn,messages=[])=>{const payload={agent,turn,step:2,messages,signal:AbortSignal.timeout(10000)};await bridge.preStep(payload,async()=>({kind:'enter',messages}));await bridge.beforeRequest(payload,async()=>route);runtime();};
  try{
   const original=user('constraint','fixture_cache batch_size=128, readonly=true. Preserve the original scope.');session.append('turn/start',{turn:1});const task=user('task','Audit fixture_cache and batch_size without modifying files.');await step(1,[task.data]);
   const first=wire();await step(1);await step(1);const frozen=JSON.stringify(wire())===JSON.stringify(first),zeroRegularModels=modelCalls===0;
   const correction=user('correction','Correction for fixture_cache: batch_size=64, readonly=true.');await step(2,[correction.data]);const second=wire();const prefixPreserved=JSON.stringify(second.slice(0,first.length))===JSON.stringify(first);
   session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'compaction'},content:[{type:'text',text:'Synthetic native compact checkpoint.'}]},{surfaceOp:{op:'replace',startSeq:original.seq,endSeq:original.seq},sourceEventSeqs:[original.seq]});
   await step(2);const modelsAfterBoundary=modelCalls,refreshAfterBoundary=refreshes;await step(2);await step(2);
   return{frozen,prefixPreserved,zeroRegularModels,consolidatedAtBoundary:modelsAfterBoundary>0,noRelocationLoop:modelCalls===modelsAfterBoundary&&refreshes===refreshAfterBoundary,allPacketsBounded:Array.from(bridge.contextFor(agent)).length<=6000};
  }finally{await bridge.dispose();const resolved=path.resolve(rootDir);if(path.dirname(resolved)!==path.resolve(os.tmpdir()))throw Error('Unsafe test cleanup');fs.rmSync(resolved,{recursive:true,force:true});}
 })()`);
 assert.deepEqual(result,{frozen:true,prefixPreserved:true,zeroRegularModels:true,consolidatedAtBoundary:true,noRelocationLoop:true,allPacketsBounded:true});
});
