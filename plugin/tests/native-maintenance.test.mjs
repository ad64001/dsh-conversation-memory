import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

test('native compaction completes maintenance before admitting a claimed user, without extra model steps', { skip: process.env.DSH_RUNTIME_NATIVE_TEST !== '1' }, async () => {
  const require = createRequire(import.meta.url), { evaluate } = require('../../scripts/native-evaluate.cjs');
  const modules = Object.fromEntries(['index.mjs','runtime-memory.mjs'].map(file => [file, fileURLToPath(new URL('../lib/'+file,import.meta.url))]));
  const library = new URL('./fixtures/paced-library.mjs',import.meta.url).href;
  const result = await evaluate(`(async()=>{
    const req=process.getBuiltinModule('node:module').createRequire(process.env.DSH_RUNTIME_ANCHOR),{Session}=req('@deepseek-ai/dsh-session');
    const fs=process.getBuiltinModule('node:fs'),path=process.getBuiltinModule('node:path'),os=process.getBuiltinModule('node:os'),{randomUUID}=process.getBuiltinModule('node:crypto');
    const {ConversationMemoryBridge}=req(${JSON.stringify(modules['index.mjs'])}),{renderRuntime,MEMORY_SECTION,memorySurface}=req(${JSON.stringify(modules['runtime-memory.mjs'])});
    const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-native-maintenance-'));let modelCalls=0;
    const bridge=new ConversationMemoryBridge({logger:{warn(){}}},{rootDir,searchTimeoutMs:10000,autoRecallRetryDelayMs:10},{libraryUrl:${JSON.stringify(library)},makeModel:()=>async request=>{
      modelCalls++;const data=JSON.parse(request.messages[1].content),requiredRefs=data.required.map(row=>row.ref);
      return {finish:'stop',text:JSON.stringify({version:3,requiredRefs,decisions:data.sources.map(source=>({sourceId:source.id,action:source.id==='current'&&requiredRefs.length?'select':'retire',reason:source.id==='current'&&requiredRefs.length?'selected':'duplicate'})),candidateIds:[]})};
    }});
    try {
      const session=Session.create('native-maintenance-'+randomUUID());session.requestHeader=()=>({config:{provider:'test',model:'deterministic'}});const agent={session};
      const user=session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'alpha_token beta_token gamma_token delta_token epsilon_token zeta_token eta_token theta_token'}]},{surfaceOp:'append'});
      const sections=[{name:MEMORY_SECTION,text:bridge.instructions+'\\nOld exact historical packet.'}];
      session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text:renderRuntime(sections)}]},{surfaceOp:'append'});
      const step=(messages=[])=>bridge.preStep({agent,turn:1,messages,signal:new AbortController().signal},async()=>({kind:'enter'}));
      await step();session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'compaction'},content:[{type:'text',text:'Checkpoint of the prior user request.'}]},{surfaceOp:{op:'replace',startSeq:user.seq,endSeq:user.seq},sourceEventSeqs:[user.seq]});
      bridge.config.searchTimeoutMs=200;
      const claimed={id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'alpha_token beta_token gamma_token delta_token epsilon_token zeta_token eta_token theta_token'}]};
      await step([claimed]);const entry=bridge.entries.get(session.id),progress=[entry.retrievalMetrics.snapshot().last.queryCount];
      const before=bridge.contextFor(agent),calls=modelCalls;
      session.append('user/message',claimed,{surfaceOp:'append'});await step([claimed]);
      return {state:entry.recallState,pending:entry.pendingCompactionMaintenance,maintenanceCompletions:entry.maintenanceCompletions,progress,modelCalls,stable:before===bridge.contextFor(agent)&&calls===modelCalls,ownedSlots:(await memorySurface(session)).slots.length,dedup:entry.dedup.state};
    } finally {await bridge.dispose();if(path.dirname(fs.realpathSync(rootDir))!==fs.realpathSync(os.tmpdir()))throw Error('Unsafe cleanup');fs.rmSync(rootDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  })()`);
  assert.equal(result.state,'complete',JSON.stringify(result)); assert.equal(result.pending,false); assert.equal(result.maintenanceCompletions,1);
  assert.ok(result.modelCalls>0); assert.deepEqual(result.progress,[9]);
  assert.equal(result.dedup,'ready'); assert.equal(result.stable,true); assert.ok(result.ownedSlots<=1);
});
