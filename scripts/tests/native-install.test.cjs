const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { evaluate } = require('../native-evaluate.cjs');
test('native desktop parser composes isolated install, loads original Basic and restores exact profile',
  { skip: process.env.DSH_RUNTIME_NATIVE_TEST !== '1' }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-native-install-'));
    t.after(() => { const resolved = path.resolve(home); if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unsafe cleanup'); fs.rmSync(resolved, { recursive: true, force: true }); });
    const root = path.resolve(__dirname, '../..');
    const expression = `(async()=>{
      const fs=require('node:fs'),path=require('node:path'),home=${JSON.stringify(home)},root=${JSON.stringify(root)};
      const dir=path.dirname(process.env.DSH_EXE),profile=path.join(home,'profiles/desktop/cordis.patch.yml');
      fs.mkdirSync(path.dirname(profile),{recursive:true});
      fs.writeFileSync(path.join(home,'profiles/desktop/package.json'),JSON.stringify({name:'isolated-install-test',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
      const original=Buffer.from('# original CRLF comment\\r\\n[]\\r\\n');fs.writeFileSync(profile,original);
      const installer=require(path.join(root,'scripts/install.cjs')),core=require(path.join(root,'scripts/install-core.cjs'));
      const plan=installer.buildPlan({home},root,dir),checkWasReadOnly=fs.readFileSync(profile).equals(original)&&!fs.existsSync(plan.destinations[0]);
      const receipt=core.install(plan),req=require('node:module').createRequire(process.env.DSH_RUNTIME_ANCHOR);
      const boot=req('@deepseek-ai/dsh-app-boot'),ctx={home,dir:path.dirname(profile),patchPath:profile,installAnchor:req.resolve('@deepseek-ai/dsh/package.json')};
      const composed=boot.composeEntries([boot.readBundlePatches('test',ctx),boot.loadOptionalPatches('test',profile)]);
      const memory=composed.filter(x=>x.id==='conversation-reference-memory');
      const presets=composed.filter(x=>['preset-standard','preset-ptc','preset-cordis'].includes(x.id));
      const collect=rows=>rows.flatMap(x=>[x,...(x.group&&Array.isArray(x.config)?collect(x.config):[])]);
      const replacements=presets.map(p=>{const r=collect(p.config.plugins);return r.find(x=>x.id==='compaction-basic').name===require('node:url').pathToFileURL(path.join(plan.destinations[1],'lib/index.mjs')).href&&r.find(x=>x.id==='tool-result-pruner').disabled===true;});
      const pruner=req(path.join(plan.destinations[1],'lib/index.mjs')),native=await pruner.loadBasicRuntime(),Base=native.BasicCompactionEngine??native.default,Engine=pruner.createSemanticPrunerEngine(Base);
      const inherited=Engine.prototype instanceof Base&&Engine.prototype.compactNow===Base.prototype.compactNow&&Engine.prototype.summarize===Base.prototype.summarize;
      const {ConversationMemoryBridge,toolDefinitions}=req(path.join(plan.destinations[0],'lib/index.mjs')),{Session}=req('@deepseek-ai/dsh-session');
      const bridge=new ConversationMemoryBridge({logger:{warn(){}}},{rootDir:path.join(home,'memory-smoke'),searchTimeoutMs:10000},{makeModel:()=>async()=>{throw Error('Unexpected model call during local archive smoke test');}});
      let localMemory;
      try {
        const session=Session.create('native-archive-smoke'),agent={session},originalText='rc3_smoke_token batch_size=128, readonly=true. Preserve this exact original.';
        session.append('user/message',{id:require('node:crypto').randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:originalText}]},{surfaceOp:'append'});
        await bridge.flush(agent);
        const status=await bridge.status(agent),found=await bridge.search(agent,{query:'rc3_smoke_token'});
        const read=await bridge.read(agent,{ref:found.refs[0],start:0,maxChars:4000});
        const body=read.text.slice(read.text.indexOf('\\n')+1,read.text.lastIndexOf('\\n'));
        localMemory={tools:toolDefinitions(bridge).map(tool=>tool.name).sort(),messages:status.stats.messages,found:found.refs.length>0,exactRead:read.found&&!read.hasMore&&read.totalChars===Array.from(originalText).length&&body===originalText};
      } finally {await bridge.dispose();}
      const rolled=core.rollback(receipt.backup,home);
      return{checkWasReadOnly,memoryCount:memory.length,presetCount:presets.length,replacements,inherited,localMemory,rolledBack:rolled.rolledBack,profileExact:fs.readFileSync(profile).equals(original),pluginRemoved:plan.destinations.every(x=>!fs.existsSync(x))};
    })()`;
    const result = await evaluate(expression);
    assert.deepEqual(result, { checkWasReadOnly: true, memoryCount: 1, presetCount: 3, replacements: [true, true, true], inherited: true, localMemory: { tools: ['memory_index','memory_read','memory_search','memory_status'], messages: 1, found: true, exactRead: true }, rolledBack: true, profileExact: true, pluginRemoved: true });
  });
