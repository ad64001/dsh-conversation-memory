'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const witness = label => createHash('sha256').update(label).digest('hex').slice(0,24);

async function run() {
  const endpoint = new URL(process.env.FRAGMENT_TEST_URL);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Set a loopback chat completions URL');
  if (!process.versions.electron) {
    const { spawnSync } = require('node:child_process');
    assert(process.env.DSH_EXE, 'Set DSH_EXE to the desktop executable');
    const child = spawnSync(process.env.DSH_EXE, [__filename], { windowsHide:true, stdio:'inherit',
      env:{...process.env, ELECTRON_RUN_AS_NODE:'1'} });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const req = createRequire(path.join(path.dirname(process.execPath), 'resources/app.asar/dsh/package.json'));
  const { Session } = req('@deepseek-ai/dsh-session');
  const { TokenMeter } = req('@deepseek-ai/dsh-token-meter');
  const { BasicCompactionEngine } = req('@deepseek-ai/dsh-compaction-basic');
  const plugin = process.env.FRAGMENT_TEST_PLUGIN || path.resolve(__dirname, '../plugin');
  const pruner = process.env.FRAGMENT_TEST_PLUGIN ? path.join(path.dirname(plugin),'dsh-semantic-tool-pruner') : path.resolve(__dirname,'../semantic-pruner');
  const { createSemanticPrunerEngine } = req(path.join(pruner,'lib/index.mjs'));
  const Engine = createSemanticPrunerEngine(BasicCompactionEngine);
  assert.equal(Engine.prototype.compactNow,BasicCompactionEngine.prototype.compactNow);
  const { ConversationMemoryBridge, toolDefinitions } = req(path.join(plugin, 'lib/index.mjs'));
  const model = process.env.FRAGMENT_TEST_MODEL || 'fragment-test';
  async function complete(messages, maxTokens, signal) {
    const result = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, signal,
      body:JSON.stringify({model, messages, max_tokens:maxTokens, temperature:0, seed:42})});
    assert.equal(result.status, 200, 'Loopback completion failed');
    const body = await result.json();
    assert.equal(body.choices[0].finish_reason, 'stop', 'Incomplete local model response');
    return {text:body.choices[0].message.content, usage:body.usage};
  }
  const inputs = [];
  const llm = {async *stream(options) {
    assert.equal(options.purpose, 'compaction');
    const messages = options.messages.map(m => ({role:m.role, content:m.content.map(b=>b.text).join('\n')}));
    const answer = await complete(messages, options.maxTokens, options.signal);
    inputs.push({inputTokens:answer.usage.prompt_tokens, outputTokens:answer.usage.completion_tokens});
    yield {type:'block-end',index:0,block:{type:'text',text:answer.text}};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guided-compaction-'));
  const session = Session.create('guided-' + randomUUID());
  const signal = AbortSignal.timeout(12 * 60 * 1000);
  const agent = {session, options:{provider:'loopback', model}, runMaintenance:fn=>fn(signal)};
  const meter = Object.assign(Object.create(TokenMeter.prototype), {states:new WeakMap(),ctx:{get(){}}});
  const engine = Object.assign(Object.create(Engine.prototype), {
    config:{summarizationProvider:'loopback',summarizationModel:model,modelPolicies:[],maxTokens:2048},
    ctx:{tokenMeter:meter,llm,waterfall:()=>false,sessions:{flush(){fs.writeFileSync(path.join(rootDir,'events.json'),JSON.stringify(Array.from({length:session.seq},(_,i)=>session.eventAt(i))));}}}
  });
  function openBridge() {
    return new ConversationMemoryBridge({logger:{warn(){}}},{rootDir,searchTimeoutMs:10000},{
      makeModel:()=>async request=>({...(await complete(request.messages, 1024, request.signal)),finish:'stop'})
    });
  }
  let bridge = openBridge();
  function call(name,args) {
    return toolDefinitions(bridge).find(t=>t.name===name).execute(args,{agent,signal});
  }
  function append(text) {
    return session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text}]},{surfaceOp:'append'}).seq;
  }
  const scope = 'release-check';
  const records = [];
  const rounds = [];
  const audits = [];
  const old = {cue:'The draft worker cap is 128.', conditions:{phase:'draft'}, action:'set worker cap', result:{workers:128}};
  const current = {cue:'Correction for the accepted build: the worker cap is 64.', conditions:{phase:'accepted'}, action:'set worker cap',result:{workers:64}};
  const next = {cue:'With 64 workers the receipt must stay read-only.',conditions:{workers:64},action:'protect receipt',result:{readonly:true}};
  const alias = {...current,cue:'The approved build runs sixty-four workers.'};
  async function record(item) {
    const witnesses = [witness(item.cue)];
    const trace = 'Routine trace IDs: ' + witnesses.join(', ') + '.';
    const source = item.cue + ' ' + trace;
    const seq = append(source);
    const found = await call('memory_search',{query:witnesses[0],limit:1});
    let ref;
    for (const candidate of found.refs) {
      if ((await call('memory_read',{ref:candidate})).text.includes(source)) { ref=candidate; break; }
    }
    assert(ref,'No search citation contained the complete observed source');
    assert.equal((await call('memory_learn',{ref,scope,...item})).added,true);
    records.push({item,trace,witnesses,seq,ref,source});
  }
  async function verify(args, expected) {
    const match = await call('memory_associate',{scope,...args});
    assert.equal(match.status,'grounded',JSON.stringify(match));
    assert.deepEqual(match.answer,expected.result);
    assert.equal(match.sourceRole,'user');
    const raw = await call('memory_read',{ref:match.ref});
    assert(raw.found && raw.text.includes(match.sourceQuote));
    const observed = records.find(r=>r.ref===match.ref);
    assert(observed && raw.text.includes(observed.trace));
    return match;
  }
  try {
    for (let round=0;round<3;round++) {
      for (const item of [[old],[current],[next,alias]][round]) await record(item);
      const markers = Array.from({length:36},(_,i)=>witness(round + "/" + i));
      const cue = 'Routine assembly log ' + (round+1) + '.12:';
      const seq = append(markers.map((id,i)=>'Routine assembly log ' + (round+1) + '.' + i +
        ': verification completed for synthetic part ' + id + '. No follow-up required.').join('\n'));
      const part = markers[12];
      const hits = await call('memory_search',{query:part,limit:4});
      let ref;
      for (const id of hits.refs) {
        const raw = await call('memory_read',{ref:id});
        if (raw.text.includes(cue) && raw.text.includes(part)) { ref=id; break; }
      }
      assert(ref,'Missing original audit entry');
      await call('memory_learn',{ref,scope:'assembly',conditions:{round},action:'verify part',result:{part},cue});
      audits.push({seq,part,round,cue,ref});
      append('Continue to the next inspection checkpoint.');
      const before = meter.measure(session).surfaceTokens;
      const previousCheckpoints = session.surface.nodes.filter(n=>session.eventAt(n).data.source?.kind==='compaction');
      assert(await engine.compactNow(agent,signal));
      const after = meter.measure(session).surfaceTokens;
      assert(after<before);
      assert(previousCheckpoints.every(n=>!session.surface.nodes.includes(n)));
      assert(records.every(r=>!session.surface.nodes.includes(r.seq)));
      const live = session.surface.nodes.flatMap(n=>session.deriveEventMessage(session.eventAt(n)).content.map(b=>b.text)).join('\n');
      const missing = audits.filter(a=>!live.includes(a.part));
      assert.equal(missing.length,audits.length,'A sampled part identifier was present in the summary');
      assert(audits.every(a=>!session.surface.nodes.includes(a.seq)));
      for (const a of missing) {
        const restored = await call('memory_associate',{scope:'assembly',context:{round:a.round},cue:a.cue});
        assert.equal(restored.status,'grounded',JSON.stringify(restored));
        assert.deepEqual(restored.answer,{part:a.part});
        assert.equal(restored.ref,a.ref);
        assert((await call('memory_read',{ref:a.ref})).text.includes(a.part));
      }
      if (round===1) { await bridge.dispose(); bridge=openBridge(); }
      await verify({context:old.conditions,cue:old.cue},old);
      if (round>0) await verify({context:current.conditions,toward:{workers:64}},current);
      rounds.push({round:round+1,before,after,decisionObservations:records.length,missingWitnesses:missing.length,...inputs.at(-1)});
    }
    const confirmedBase = await verify({context:current.conditions,cue:current.cue},current);
    assert.equal(confirmedBase.observations.length,2);
    const chained = await verify({context:current.conditions,after:confirmedBase.fragment_id},next);
    assert.deepEqual(chained.shared_facts,{workers:64});
    const contradictory = await call('memory_associate',{scope,context:{phase:'accepted',workers:96},after:confirmedBase.fragment_id});
    assert.equal(contradictory.status,'no_match');
    const query = {scope,context:current.conditions,cue:'What limit applies to the finalized worker pool?'};
    assert.equal((await call('memory_associate',query)).status,'no_match');
    const inventory = await call('memory_associate',{...query,browse:true});
    const option = inventory.options.find(x=>x.action===current.action);
    assert(option);
    await verify({...query,confirm:option.token},current);
    const wrong = await call('memory_associate',{...query,context:old.conditions,confirm:option.token});
    assert.equal(wrong.reason,'invalid_choice');
    const conflict = {...current,cue:'The accepted worker cap was reported as 96.',result:{workers:96}};
    await record(conflict);
    assert.equal((await call('memory_associate',{scope,context:current.conditions,cue:current.cue})).status,'no_match');
    assert.equal((await call('memory_associate',{...query,confirm:option.token})).reason,'invalid_choice');
    const packets = await Promise.all([confirmedBase.ref,chained.ref,audits[0].ref].map(ref=>call('memory_read',{ref})));
    const final = await complete([
      {role:'system',content:'Answer from the supplied original evidence only. Return a JSON object with workers (integer), readonly (boolean), and part (exact identifier).'},
      {role:'user',content:'For the accepted build, what worker cap and receipt restriction apply? Which part was verified at routine assembly log 1.12?\n' + packets.map(p=>p.text).join('\n')}
    ],512,signal);
    const json = final.text.match(/\{[^{}]*\}/);
    assert(json,'Expected a JSON answer from the local model');
    assert.deepEqual(JSON.parse(json[0]),{workers:64,readonly:true,part:audits[0].part});
    const beforeIndex = (await call('memory_status',{})).stats.fragmentObservations;
    append('MODEL_INDEX_PROBE. In the cold chamber, warming the probe changed its status to ready.');
    const indexed = await call('memory_index',{query:'MODEL_INDEX_PROBE',maxCalls:1});
    assert.equal(indexed.rejected,0);
    const learned = (await call('memory_status',{})).stats.fragmentObservations - beforeIndex;
    assert(learned>0,'The organizer did not extract a fragment from the explicit observation');
    const events = JSON.parse(fs.readFileSync(path.join(rootDir,'events.json')));
    for(const type of ['compaction/start','compaction/summary','compaction/end']) assert.equal(events.filter(e=>e.type===type).length,3);
    assert.equal(inputs.length,3);
    console.log(JSON.stringify({rounds,sourceLinkedObservations:confirmedBase.observations.length,chain:chained.answer,
      modelExtractedObservations:learned,modelAnsweredFromCitations:true,confirmation:true,conflictAbstention:true,staleTokenRejected:true,reopenedAfterRound:2},null,2));
  } finally {
    await bridge.dispose();
    assert(path.dirname(rootDir)===path.resolve(os.tmpdir()) && path.basename(rootDir).startsWith('dsh-guided-compaction-'));
    fs.rmSync(rootDir,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
