#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const top=new Set(['package.json','package-lock.json','.npmrc','.gitignore','.node-version','tsconfig.json','vite.config.ts','index.html','LICENSE','CONTRIBUTING.md','SECURITY.md','PRIVACY.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','THIRD_PARTY_DEPENDENCIES.json','THIRD_PARTY_LICENSES.txt']);
const docs=new Set(['docs/SELF_HOSTING.md','docs/SELF_HOSTING.zh-CN.md','docs/COMPATIBILITY.md','docs/UPGRADING.md']);
const prefixes=['src/','server/','shared/','bin/','public/','vendor/','packages/','.github/','tests/'];
const digest=value=>createHash('sha256').update(value).digest('hex');
function readSource(name) {
  const path=join(root,name), before=lstatSync(path);
  if(!before.isFile()||!realpathSync(path).startsWith(realpathSync(root)+'/')) throw new Error('Required source input is not an owned regular file');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const bound=fstatSync(fd);
    if(bound.dev!==before.dev||bound.ino!==before.ino) throw new Error('Source input changed while packaging');
    const value=readFileSync(fd), after=fstatSync(fd);
    if(bound.size!==after.size||bound.mtimeMs!==after.mtimeMs) throw new Error('Source input changed while packaging');
    return value;
  } finally { closeSync(fd); }
}
export function packageSource(directory) {
  directory=resolve(directory);
  if(directory===root || root.startsWith(directory+'/') || existsSync(directory)) throw new Error('Source export needs a new output directory');
  const gitRoot=existsSync(join(root,'.git'));
  let previous=null;
  if(existsSync(join(root,'source-manifest.json'))) {
    try{previous=JSON.parse(readSource('source-manifest.json').toString('utf8'));}catch{throw new Error('Invalid exported source manifest');}
  }
  const paths=gitRoot ? execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n') : previous?.files?.map(file=>file.path);
  if(!paths) throw new Error('Source packaging requires a repository or an exported source manifest');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const copied=[];
  for(const name of paths) {
    if(typeof name!=='string'||name.includes('\\')||/[\p{Cc}]/u.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error('Invalid source manifest path');
    if(!(top.has(name)||docs.has(name)||prefixes.some(prefix=>name.startsWith(prefix))) || /(?:^|\/)(?:node_modules|dist|\.local|__pycache__)(?:\/|$)/.test(name) || /\.(?:sqlite(?:-wal|-shm)?|log|pyc)$/.test(name)) continue;
    const source=join(root,name);
    if(!existsSync(source) || !lstatSync(source).isFile()) continue;
    if(!realpathSync(source).startsWith(realpathSync(root)+'/')) throw new Error('Source file escapes the repository');
    const target=join(directory,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readSource(name));copied.push(name);
  }
  mkdirSync(join(directory,'config'),{recursive:true});
  for(const name of ['client','desktop-bridge','relay']) {
    const source=readSource(`config/${name}.example.json`);
    writeFileSync(join(directory,`config/${name}.example.json`),source);
    if(name==='desktop-bridge') writeFileSync(join(directory,'config/desktop-bridge.json'),source);
  }
  writeFileSync(join(directory,'config/usage-analytics.json'),JSON.stringify({enabled:false,projectKey:'',apiHost:'https://us.i.posthog.com',uiHost:'https://us.posthog.com',origins:[],environment:'self-hosted'},null,2)+'\n');
  const readme=readSource('README.en.md');writeFileSync(join(directory,'README.md'),readme);writeFileSync(join(directory,'README.en.md'),readme);
  writeFileSync(join(directory,'AGENTS.md'),'# Pocket development\n\nRead README.md, SECURITY.md and docs/SELF_HOSTING.md. Keep user data, credentials, logs and screenshots outside Git. Use synthetic fixtures for tests; never write Codex SQLite or replay unknown requests. Preserve request identity, owner/model permissions, and input/reading state. Run npm test, npm run build and npm run test:browser before shipping code changes. Desktop control requires the supported macOS/Codex combination described in docs/COMPATIBILITY.md.\n');
  const files=[];
  for(const name of [...new Set([...copied,'config/client.example.json','config/desktop-bridge.example.json','config/desktop-bridge.json','config/relay.example.json','config/usage-analytics.json','README.md','README.en.md','AGENTS.md'])].sort()) {
    const path=join(directory,name);if(existsSync(path)) files.push({path:name,sha256:digest(readFileSync(path))});
  }
  const manifest={schemaVersion:1,version:JSON.parse(readSource('package.json').toString('utf8')).version,
    sourceCommit:gitRoot ? execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim() : previous.sourceCommit,
    sourceDirty:gitRoot ? !!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim() : true,
    published:false,files};
  writeFileSync(join(directory,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {ok:true,directory,version:manifest.version,files:files.length,manifest:join(directory,'source-manifest.json'),published:false};
}
if(isMain(import.meta.url)) {
  try { const at=process.argv.indexOf('--out');if(at<0||!process.argv[at+1]) throw new Error('Use --out /absolute/new/source-directory');console.log(JSON.stringify(packageSource(process.argv[at+1]))); }
  catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
