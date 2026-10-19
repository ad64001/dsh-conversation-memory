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
      const rolled=core.rollback(receipt.backup,home);
      return{checkWasReadOnly,memoryCount:memory.length,presetCount:presets.length,replacements,inherited,rolledBack:rolled.rolledBack,profileExact:fs.readFileSync(profile).equals(original),pluginRemoved:plan.destinations.every(x=>!fs.existsSync(x))};
    })()`;
    const result = await evaluate(expression);
    assert.deepEqual(result, { checkWasReadOnly: true, memoryCount: 1, presetCount: 3, replacements: [true, true, true], inherited: true, rolledBack: true, profileExact: true, pluginRemoved: true });
  });
