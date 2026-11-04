import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateSourceMarkers, privateSourcePathReason, sourcePrivacyFindings } from '../bin/source-privacy.mjs';
import { checkSourcePrivacy } from '../bin/privacy-check.mjs';
import { packageSource } from '../bin/package-source.mjs';

test('source release guards recognize private paths even if they were tracked', () => {
  for (const path of ['bin/.env','src/.env.production','tests/.local/private.json','tests/private-data/user.md',
    'tests/fake.sqlite-wal','data/submission.json','src/initial-passphrase.txt','bin/web-push-keys.json',
    'config/machine.private.json','packages/feedback-assets/image.png','config/pages-site.json',
    'src/relay-registration.json','tests/navigator-123456-private.json']) {
    assert.ok(privateSourcePathReason(path), path);
  }
  for (const path of ['bin/source-privacy.mjs','server/auth.mjs','tests/fixtures/catalog.json','config/relay.example.json','docs/assets/pocket-architecture.svg']) {
    assert.equal(privateSourcePathReason(path), null, path);
  }
});

test('known private markers are taken from local files and findings never reveal their values', t => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-private-markers-')); t.after(() => rmSync(root, { recursive:true, force:true }));
  mkdirSync(join(root, 'config'));
  const domain = 'private-' + randomUUID() + '.owner.net', home = '/Users/private-' + randomUUID(), account = randomUUID().replaceAll('-', '');
  writeFileSync(join(root, 'config/pages-site.json'), JSON.stringify({ domain, working_directory:home + '/project', account_id:account }));
  writeFileSync(join(root, 'config/relay.json'), JSON.stringify({ publicOrigin:'https://pocket.example.com' }));
  const markers = privateSourceMarkers(root);
  assert.ok(markers.has(domain)); assert.ok(markers.has(home.toLowerCase())); assert.ok(markers.has(account));
  assert.ok(!markers.has('pocket.example.com'));
  const findings = sourcePrivacyFindings('README.md', Buffer.from([domain, home, account].join('\n')), markers);
  assert.equal(findings.length, 3); const receipt = JSON.stringify(findings);
  for (const value of [domain,home,account]) assert.ok(!receipt.includes(value));
  assert.ok(!sourcePrivacyFindings('README.md', Buffer.from('~/.codex /Applications/Codex.app'), markers).length);
});

test('staged checks inspect the Git index rather than newer working-copy content', t => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-private-index-')); t.after(() => rmSync(root, { recursive:true, force:true }));
  const denied = randomUUID(), denyFile = join(root,'deny.private.json'); writeFileSync(denyFile,JSON.stringify({ values:[denied] }));
  execFileSync('git',['init','--quiet'],{ cwd:root });
  const file = join(root,'README.md'); writeFileSync(file,denied);
  execFileSync('git',['add','README.md'],{ cwd:root }); writeFileSync(file,'This working copy is public.');
  const result = checkSourcePrivacy({ root,staged:true,denyFile });
  assert.equal(result.ok,false); assert.equal(result.scope,'staged_files');
  assert.deepEqual(result.findings,[{path:'README.md',rule:'operator_denied_value'}]);
  assert.ok(!JSON.stringify(result).includes(denied));
  execFileSync('git',['add','README.md'],{ cwd:root }); assert.equal(checkSourcePrivacy({root,staged:true,denyFile}).ok,true);
});

test('new-install and explicitly selected private configurations register their own origins and data paths', t => {
  const root=mkdtempSync(join(tmpdir(),'pocket-private-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'.local/pocket'),{recursive:true});
  const domain='private-'+randomUUID()+'.owner.net', dataDir=join(root,'actual-private-data');
  writeFileSync(join(root,'.local/pocket/config.json'),JSON.stringify({client:{publicOrigin:'https://'+domain},deployment:{publicOrigin:'https://'+domain},dataDir}));
  const defaults=privateSourceMarkers(root);assert.ok(defaults.has(domain));assert.ok(defaults.has(dataDir.toLowerCase()));
  const customDomain='selected-'+randomUUID()+'.owner.net', custom=join(root,'custom.private.json');
  writeFileSync(custom,JSON.stringify({client:{publicOrigin:'https://'+customDomain}}));
  assert.ok(privateSourceMarkers(root,undefined,custom).has(customDomain));
  assert.throws(()=>privateSourceMarkers(root,undefined,'relative.json'),/absolute/);
});

test('staged renamed files are inspected at their new path instead of silently skipped', t => {
  const root=mkdtempSync(join(tmpdir(),'pocket-private-rename-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','--quiet'],{cwd:root});
  const before=join(root,'before.txt'), after=join(root,'after.txt');
  writeFileSync(before,Array.from({length:200},(_,i)=>'Public line '+i).join('\n')+'\n');
  execFileSync('git',['add','before.txt'],{cwd:root});
  execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Fixture baseline'],{cwd:root});
  const denied=randomUUID(),denyFile=join(root,'deny.private.json');writeFileSync(denyFile,JSON.stringify({values:[denied]}));
  renameSync(before,after);writeFileSync(after,readFileSync(after,'utf8')+denied+'\n');
  execFileSync('git',['add','before.txt','after.txt'],{cwd:root});
  assert.match(execFileSync('git',['diff','--cached','--name-status'],{cwd:root,encoding:'utf8'}),/^R\d+\s+before\.txt\s+after\.txt/);
  const result=checkSourcePrivacy({root,staged:true,denyFile});assert.equal(result.ok,false);assert.equal(result.checkedFiles,1);
  assert.deepEqual(result.findings,[{path:'after.txt',rule:'operator_denied_value'}]);
});

test('export excludes nested private files and rejects a known private byte before creating output', t => {
  const root = mkdtempSync(join(tmpdir(),'pocket-private-export-')); t.after(() => rmSync(root,{recursive:true,force:true}));
  const source = join(root,'source'); packageSource(source);
  assert.ok(existsSync(join(source,'edge/worker.mjs')),'The optional relay implementation is part of the source');
  assert.ok(existsSync(join(source,'README.zh-CN.md')));
  assert.ok(existsSync(join(source,'docs/PUBLIC_HISTORY.md')),'The public history notice follows its README link into the source package');
  assert.match(readFileSync(join(source,'README.en.md'),'utf8'), /README\.zh-CN\.md/);
  const manifestPath = join(source,'source-manifest.json'), manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  for (const path of ['bin/.env','src/web-push-keys.json','tests/private-data/query.md','tests/fake.sqlite-wal']) {
    mkdirSync(join(source,path,'..'),{recursive:true}); writeFileSync(join(source,path),'synthetic private data'); manifest.files.push({path});
  }
  const publicFile='tests/fixtures/public-note.md'; writeFileSync(join(source,publicFile),'Synthetic public fixture'); manifest.files.push({path:publicFile});
  writeFileSync(manifestPath,JSON.stringify(manifest));
  const outgoing=join(root,'outgoing'); execFileSync(process.execPath,[join(source,'bin/package-source.mjs'),'--out',outgoing],{stdio:'pipe'});
  for (const path of ['bin/.env','src/web-push-keys.json','tests/private-data/query.md','tests/fake.sqlite-wal']) assert.ok(!existsSync(join(outgoing,path)),path);
  assert.ok(existsSync(join(outgoing,publicFile)));
  const denied='private-' + randomUUID() + '.owner.net', denyFile=join(root,'deny.private.json');
  writeFileSync(denyFile,JSON.stringify({values:[denied]})); writeFileSync(join(source,publicFile),denied);
  const blocked=join(root,'blocked'), result=spawnSync(process.execPath,[join(source,'bin/package-source.mjs'),'--out',blocked],{
    encoding:'utf8',env:{...process.env,POCKET_SOURCE_PRIVACY_DENY_FILE:denyFile},
  });
  assert.equal(result.status,1); assert.ok(!existsSync(blocked));
  assert.match(result.stderr,/operator_denied_value/); assert.ok(!result.stderr.includes(denied));
});

test('export checking examines the real tree, rejects extras and verifies manifest digests', t => {
  const root = mkdtempSync(join(tmpdir(),'pocket-private-tree-')); t.after(() => rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source');packageSource(source);
  assert.equal(checkSourcePrivacy({root:source}).ok,true);
  writeFileSync(join(source,'unlisted.private.json'),'synthetic private text');
  const extra=checkSourcePrivacy({root:source});assert.equal(extra.ok,false);
  assert.ok(extra.findings.some(item=>item.path==='unlisted.private.json'&&item.rule==='unmanifested_source_file'));
  assert.ok(extra.findings.some(item=>item.path==='unlisted.private.json'&&item.rule==='private_runtime_file'));
  rmSync(join(source,'unlisted.private.json'));
  writeFileSync(join(source,'README.md'),'Changed after the export.');
  assert.ok(checkSourcePrivacy({root:source}).findings.some(item=>item.path==='README.md'&&item.rule==='source_manifest_digest_mismatch'));
});
