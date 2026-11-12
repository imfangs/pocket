#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { privateSourceMarkers, privateSourcePathReason, sourcePrivacyFindings, publicSourceDocumentationPaths } from './source-privacy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const top=new Set(['package.json','package-lock.json','.npmrc','.gitignore','.gitattributes','.node-version','tsconfig.json','vite.config.ts','index.html','LICENSE','CONTRIBUTING.md','SECURITY.md','PRIVACY.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','THIRD_PARTY_DEPENDENCIES.json','THIRD_PARTY_LICENSES.txt']);
const docs=publicSourceDocumentationPaths;
const prefixes=['src/','server/','shared/','bin/','edge/','public/','vendor/','packages/','.github/','tests/'];
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
  const markers=privateSourceMarkers(root), entries=new Map();
  for(const name of paths) {
    if(typeof name!=='string'||name.includes('\\')||/[\p{Cc}]/u.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error('Invalid source manifest path');
    if(!(top.has(name)||docs.has(name)||prefixes.some(prefix=>name.startsWith(prefix))) || privateSourcePathReason(name)) continue;
    const source=join(root,name);
    if(!existsSync(source) || !lstatSync(source).isFile()) continue;
    if(!realpathSync(source).startsWith(realpathSync(root)+'/')) throw new Error('Source file escapes the repository');
    entries.set(name,readSource(name));
  }
  for(const name of ['client','desktop-bridge','relay','usage-analytics']) {
    const source=readSource(`config/${name}.example.json`);
    entries.set(`config/${name}.example.json`,source);
    if(name==='desktop-bridge') entries.set('config/desktop-bridge.json',source);
  }
  entries.set('config/usage-analytics.json',JSON.stringify({enabled:false,projectKey:'',apiHost:'https://us.i.posthog.com',uiHost:'https://us.posthog.com',origins:[],environment:'self-hosted'},null,2)+'\n');
  const readme=readSource('README.en.md').toString('utf8').replace(/\]\(README\.md\)/g,'](README.zh-CN.md)');
  entries.set('README.md',readme);entries.set('README.en.md',readme);
  entries.set('README.zh-CN.md',readSource(existsSync(join(root,'README.zh-CN.md')) ? 'README.zh-CN.md' : 'README.md'));
  entries.set('AGENTS.md','# Pocket development\n\nRead README.md, SECURITY.md and docs/SELF_HOSTING.md. Keep user data, credentials, logs and screenshots outside Git. Use synthetic fixtures for tests; never write Codex SQLite or replay unknown requests. Preserve request identity, owner/model permissions, and input/reading state. For portable checks run node .github/scripts/test-synthetic.mjs and npm run build; run npm run test:browser for UI changes. For release acceptance run npm test on a supported isolated Mac, including the seven installed-desktop suites, and report native controls separately. Desktop control requires the supported macOS/Codex combination described in docs/COMPATIBILITY.md.\n');
  // Scan exact outgoing bytes before creating any output. Findings name the
  // file and category only; private markers never enter the release receipt.
  const findings=[...entries].flatMap(([name,bytes])=>sourcePrivacyFindings(name,Buffer.from(bytes),markers));
  if(findings.length) throw new Error('Source privacy guard rejected: '+JSON.stringify(findings));
  mkdirSync(directory,{recursive:true,mode:0o700});
  for(const [name,bytes] of entries) { const target=join(directory,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes); }
  const files=[];
  for(const name of [...entries.keys()].sort()) {
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
