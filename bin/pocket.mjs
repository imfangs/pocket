#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readPocketConfig, setupPocket } from './pocket-config.mjs';
import { readBridgeConfig } from '../server/bridge-config.mjs';
import { normalizeDeploymentConfig } from '../server/deployment-config.mjs';
import { acquireDataLock } from './pocket-lock.mjs';
import { createServer } from 'node:net';
import { isMain } from './is-main.mjs';
const exec = promisify(execFile);

function argumentsOf(args) {
  const values = {}, positional = [];
  for (let i=0; i<args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key=args[i].slice(2);
    if (key==='apply') { values.apply=true; continue; }
    if (!['config','port','data-dir','codex-home','public-origin','machine-id','label'].includes(key) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Invalid Pocket CLI option');
    values[key]=args[++i];
  }
  return { values, positional };
}
export async function doctor(path) {
  const report = { ok: false, runtime: { macOS: process.platform==='darwin', node: process.versions.node, supportedNode: Number(process.versions.node.split('.')[0])===26 }, checks: {} };
  let config;
  try { config=readPocketConfig(path); report.checks.configuration=true; } catch(error) { report.checks.configuration=false; report.reason=error.message; return report; }
  const value=config.value;
  let bridge;
  try { bridge=readBridgeConfig(value.bridgeConfig); report.checks.bridgeConfiguration=true; }
  catch { report.checks.bridgeConfiguration=false; report.reason='Bridge configuration is unavailable. Check the local configuration.'; return report; }
  let pythonOK=false, modulesOK=false, desktopOK=false;
  try {
    const version=await exec(bridge.python,['-c','import sys; print("ok" if sys.version_info >= (3,11) else "old")'],{timeout:10000}); pythonOK=version.stdout.trim()==='ok';
    const imported=await exec(bridge.python,['-c','import sys; sys.path[:0]=sys.argv[1:]; import app_ipc, contracts, archive_cli, metadata_cli; print("ok")',bridge.ipcModuleDirectory,bridge.metadataModuleDirectory],{timeout:10000}); modulesOK=imported.stdout.trim()==='ok';
    const bundle=await exec(bridge.python,['-c','import sys; sys.path.insert(0,sys.argv[1]); from bundled_cli import desktop_app,bundled_cli; app=desktop_app(sys.argv[2]); bundled_cli(app["path"]); print("ok")',fileURLToPath(new URL('.',import.meta.url)),bridge.appPath],{timeout:10000}); desktopOK=bundle.stdout.trim()==='ok';
  } catch { /* Paths and interpreter diagnostics do not expose credential values. */ }
  report.checks={...report.checks,python:pythonOK,bridgeModules:modulesOK,desktopApp:desktopOK,
    codexMetadata:existsSync(join(value.codexHome,'state_5.sqlite')) && existsSync(join(value.codexHome,'.codex-global-state.json')),
    dataDirectory:existsSync(value.dataDir),builtFrontend:existsSync(fileURLToPath(new URL('../dist/index.html',import.meta.url)))};
  let sourceSchema=false;
  if (report.runtime.supportedNode && report.checks.codexMetadata) {
    const { DatabaseSync }=await import('node:sqlite'); let db;
    try {
      const global=JSON.parse(readFileSync(join(value.codexHome,'.codex-global-state.json'),'utf8'));
      db=new DatabaseSync(join(value.codexHome,'state_5.sqlite'),{readOnly:true});
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>row.name));
      sourceSchema=Array.isArray(global['pinned-thread-ids']) && ['id','title','cwd','archived','created_at','updated_at','source'].every(field=>columns.has(field));
    } catch { /* Report a capability gap rather than guessing a future schema. */ } finally { db?.close(); }
  }
  report.checks.sourceSchema=sourceSchema;
  report.deployment={machineId:value.client.defaultMachine,publicOriginConfigured:!!value.client.publicOrigin,minimumPassphraseLength:normalizeDeploymentConfig(value.deployment).minimumPassphraseLength};
  report.version=JSON.parse(readFileSync(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')).version;
  report.control='not_checked'; report.mobileConnection='not_checked';
  report.ok=report.runtime.macOS && report.runtime.supportedNode && pythonOK && modulesOK && report.checks.desktopApp && sourceSchema && report.checks.builtFrontend;
  return report;
}
export async function main(args=process.argv.slice(2)) {
  const command=args.shift()||'help'; const {values,positional}=argumentsOf(args);
  const path=values.config ? resolve(values.config) : undefined;
  if (command==='help') { console.log('Pocket: setup | doctor | start | service install/uninstall/status. Use --config /absolute/path/config.json.'); return; }
  if (command==='setup') {
    const result=setupPocket({ path,port:values.port===undefined?4397:Number(values.port),dataDir:values['data-dir'],codexHome:values['codex-home'],publicOrigin:values['public-origin'],machineId:values['machine-id'],label:values.label });
    console.log(JSON.stringify({ok:true,created:result.created,configFile:result.path,next:'npm run build && npm start'})); return;
  }
  if (command==='doctor') { const result=await doctor(path); console.log(JSON.stringify(result)); if(!result.ok) process.exitCode=1; return; }
  if (command==='service') { const {manageService}=await import('./pocket-service.mjs'); console.log(JSON.stringify(await manageService(positional[0],readPocketConfig(path),!!values.apply))); return; }
  if (command!=='start') throw new Error('Unknown Pocket command');
  if (process.platform!=='darwin') throw new Error('Pocket desktop control currently requires macOS');
  if (Number(process.versions.node.split('.')[0])!==26) throw new Error('Pocket requires Node.js 26.x');
  const {value}=readPocketConfig(path);
  const releaseLock=acquireDataLock(value.dataDir);
  process.once('exit',releaseLock);
  try {
    await new Promise((done,reject)=>{
      const probe=createServer();probe.once('error',reject);probe.listen(value.port,'127.0.0.1',()=>probe.close(done));
    });
  } catch { releaseLock(); throw new Error('Pocket port is already in use. Stop the other instance first.'); }
  process.env.NAVIGATOR_BRIDGE_CONFIG=value.bridgeConfig;
  const {makeApp}=await import('../server/index.mjs');
  const app=makeApp({dataDir:value.dataDir,codexHome:value.codexHome,machineId:value.client.defaultMachine,clientConfig:value.client,
    deploymentConfig:value.deployment,notifications:{subject:process.env.NAVIGATOR_PUSH_SUBJECT || value.client.publicOrigin || 'https://pocket.invalid'}});
  app.server.on('close',releaseLock);
  app.server.on('error',()=>{releaseLock();app.server.close();process.exitCode=1;console.error('Pocket could not bind its local port. Check another running instance.');});
  app.server.listen(value.port,'127.0.0.1',()=>console.log(JSON.stringify({ok:true,url:value.client.publicOrigin||`http://127.0.0.1:${value.port}`,passphraseFile:app.auth.passphrasePath})));
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{app.stopVideoStreams();app.server.close(()=>process.exit(0));});
}
if (isMain(import.meta.url)) main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
