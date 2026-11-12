import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,mkdirSync,statSync,realpathSync,symlinkSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { normalizeClientConfig,serializeClientConfig } from '../shared/client-config.mjs';
import { acquireDataLock } from '../bin/pocket-lock.mjs';
import { packageSource } from '../bin/package-source.mjs';
import { servicePlan,serviceIdentity,loadedArguments } from '../bin/pocket-service.mjs';

test('public machine profiles fail closed and serialized labels cannot inject script content',()=>{
  assert.equal(normalizeClientConfig().defaultMachine,'local');
  for(const id of [undefined,null,{},'../other','bad id']) assert.throws(()=>normalizeClientConfig({schemaVersion:1,defaultMachine:id,machines:[{id,label:'My Mac'}],publicOrigin:null}));
  assert.throws(()=>normalizeClientConfig({schemaVersion:1,defaultMachine:'local',machines:[{id:'local',label:'Mac'}],publicOrigin:'https://user:secret@example.com'}));
  const js=serializeClientConfig({schemaVersion:1,defaultMachine:'studio',machines:[{id:'studio',label:'</script>'}],publicOrigin:'https://pocket.example.com'});
  assert.ok(!js.includes('</script>')); assert.match(js,/\\u003c/);
});

test('a data directory admits one service owner and preserves that lock across competing attempts',t=>{
  const directory=mkdtempSync(join(tmpdir(),'pocket-lock-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const release=acquireDataLock(directory);
  assert.throws(()=>acquireDataLock(directory),/Another Pocket instance/);
  assert.ok(existsSync(join(directory,'.pocket-service.lock')));
  release();const next=acquireDataLock(directory);next();assert.ok(!existsSync(join(directory,'.pocket-service.lock')));
  writeFileSync(join(directory,'.pocket-service.lock'),JSON.stringify({kind:'pocket-service-v1',pid:99999999,token:'stale'}));
  assert.throws(()=>acquireDataLock(directory),/stale lock/);assert.ok(existsSync(join(directory,'.pocket-service.lock')));
});

test('the exported source bootstraps without private configuration, FBT or author data',t=>{
  const directory=mkdtempSync(join(tmpdir(),'pocket-source-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const source=join(directory,'source');const result=packageSource(source);
  assert.equal(result.published,false);assert.ok(existsSync(join(source,'.gitignore')));
  const manifest=JSON.parse(readFileSync(join(source,'source-manifest.json'),'utf8'));
  assert.ok(manifest.files.every(file=>!file.path.startsWith('.local/') && !file.path.endsWith('.sqlite')));
  assert.equal(JSON.parse(readFileSync(join(source,'config/usage-analytics.json'),'utf8')).enabled,false);
  assert.deepEqual(JSON.parse(readFileSync(join(source,'config/desktop-bridge.json'),'utf8')),{python:'python3'});
  assert.ok(!existsSync(join(source,'config/pages-site.json')) && !existsSync(join(source,'CURRENT.md')));
  const config=join(directory,'config','pocket.json'), data=join(directory,'data'), codex=join(directory,'codex');mkdirSync(codex);
  // This child is a fresh installation; the caller's machine/CI bridge is
  // deliberately outside the exported source being verified.
  const env={...process.env};delete env.NAVIGATOR_BRIDGE_CONFIG;
  const args=[join(source,'bin/pocket.mjs'),'setup','--config',config,'--data-dir',data,'--codex-home',codex,'--public-origin','https://pocket.example.com'];
  const first=JSON.parse(execFileSync(process.execPath,args,{cwd:source,env,encoding:'utf8'}));assert.equal(first.created,true);
  const next=JSON.parse(execFileSync(process.execPath,args,{cwd:source,env,encoding:'utf8'}));assert.equal(next.created,false);
  const value=JSON.parse(readFileSync(config,'utf8')), bridge=JSON.parse(readFileSync(value.bridgeConfig,'utf8'));
  assert.equal(value.client.defaultMachine,'local');assert.equal(value.deployment.minimumPassphraseLength,12);
  assert.ok(bridge.ipcModuleDirectory.startsWith(realpathSync(source)) && bridge.metadataModuleDirectory.startsWith(realpathSync(source)));
  assert.equal(statSync(config).mode & 0o777,0o600);
  const plan=servicePlan({path:config,value},join(directory,'home'),123);
  assert.ok(plan.plist.includes(process.execPath) && plan.plist.includes(config));assert.match(plan.label,/local$/);
  assert.equal(existsSync(plan.path),false,'Planning cannot install a real service');
  const owned={Label:plan.label,ProgramArguments:[process.execPath,plan.program,'start','--config',config]};
  assert.equal(serviceIdentity(owned,plan,{path:config}),true);
  assert.equal(serviceIdentity({Label:plan.label,ProgramArguments:['/bin/foreign'],Comment:plan.program+config},plan,{path:config}),false);
  assert.deepEqual(loadedArguments('arguments = {\n'+owned.ProgramArguments.join('\n')+'\n}'),owned.ProgramArguments);
  const privateFile=join(directory,'outside.json');writeFileSync(privateFile,'{"privateMarker":"synthetic-secret"}');
  unlinkSync(join(source,'config/client.example.json'));symlinkSync(privateFile,join(source,'config/client.example.json'));
  assert.throws(()=>execFileSync(process.execPath,[join(source,'bin/package-source.mjs'),'--out',join(directory,'bad-export')],{cwd:source,stdio:'pipe'}));
  const copied=join(directory,'bad-export/config/client.example.json');
  assert.ok(!existsSync(copied)||!readFileSync(copied,'utf8').includes('synthetic-secret'));
});
