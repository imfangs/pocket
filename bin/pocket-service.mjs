import { homedir } from 'node:os';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectRoot } from './pocket-config.mjs';
const exec=promisify(execFile);
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function servicePlan(config, home=homedir(), uid=process.getuid?.()) {
  const label=`cc.pocket.selfhost.${config.value.client.defaultMachine}`;
  const path=join(home,'Library/LaunchAgents',label+'.plist'), logs=join(dirname(config.path),'logs');
  const program=join(projectRoot,'bin/pocket.mjs');
  const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(program)}</string><string>start</string><string>--config</string><string>${xml(config.path)}</string></array><key>WorkingDirectory</key><string>${xml(projectRoot)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(logs,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs,'service-error.log'))}</string></dict></plist>\n`;
  return {label,path,logs,program,domain:`gui/${uid}`,plist};
}
export function serviceIdentity(value,plan,config) {
  const args=value?.ProgramArguments;
  return value?.Label===plan.label && Array.isArray(args) && args.length===5 &&
    typeof args[0]==='string' && isAbsolute(args[0]) && (args[0]===process.execPath || basename(args[0])==='node') &&
    args[1]===plan.program && args[2]==='start' && args[3]==='--config' && args[4]===config.path;
}
export function loadedArguments(text) {
  const match=/\barguments = \{\s*([\s\S]*?)\n\s*\}/.exec(text);
  if(!match)return null;
  try{return match[1].split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>line.startsWith('"')?JSON.parse(line):line);}catch{return null;}
}
export async function manageService(action,config,apply=false) {
  if(!['install','uninstall','status'].includes(action)) throw new Error('Use service install, uninstall or status');
  const plan=servicePlan(config);
  const base={label:plan.label,plistFile:plan.path,dataPreserved:true};
  if(!apply && action!=='status') return {...base,applied:false,command:action};
  if(process.platform!=='darwin') throw new Error('Pocket service management requires macOS');
  let loaded=false,pid=null,loadedArgs=null;
  try { const result=await exec('/bin/launchctl',['print',`${plan.domain}/${plan.label}`],{timeout:10000}); loaded=true;loadedArgs=loadedArguments(result.stdout);pid=Number(/\bpid = (\d+)/.exec(result.stdout)?.[1])||null; } catch {}
  if(action==='status') return {...base,loaded,pid};
  if(loaded && !existsSync(plan.path)) throw new Error('Cannot verify ownership of the loaded service');
  let stored;
  if(existsSync(plan.path)) {
    try { const decoded=await exec('/usr/bin/plutil',['-convert','json','-o','-',plan.path],{timeout:10000});stored=JSON.parse(decoded.stdout); }
    catch { throw new Error('Unable to validate the installed Pocket service'); }
    if(!serviceIdentity(stored,plan,config)) throw new Error('Existing service is not owned by this Pocket installation');
  }
  if(loaded && (!loadedArgs || loadedArgs.length!==stored.ProgramArguments.length || loadedArgs.some((arg,index)=>arg!==stored.ProgramArguments[index])))
    throw new Error('Loaded service identity differs from its owned registration');
  if(action==='install') {
    if(loaded) throw new Error('This service is already running. Stop it before changing its installation.');
    mkdirSync(dirname(plan.path),{recursive:true});mkdirSync(plan.logs,{recursive:true,mode:0o700});
    writeFileSync(plan.path,plan.plist,{mode:0o600});chmodSync(plan.path,0o600);
    await exec('/bin/launchctl',['bootstrap',plan.domain,plan.path],{timeout:15000});
  } else {
    if(loaded) await exec('/bin/launchctl',['bootout',`${plan.domain}/${plan.label}`],{timeout:15000});
    if(existsSync(plan.path)) unlinkSync(plan.path);
  }
  return {...base,applied:true,command:action};
}
