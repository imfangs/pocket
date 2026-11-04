#!/usr/bin/env node
import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { privateSourceMarkers, sourcePrivacyFindings } from './source-privacy.mjs';
import { isMain } from './is-main.mjs';

const scriptRoot = fileURLToPath(new URL('..', import.meta.url));
export function checkSourcePrivacy({ root = scriptRoot, staged = false, denyFile } = {}) {
  root = resolve(root);
  const markers = privateSourceMarkers(scriptRoot, denyFile);
  const git = existsSync(join(root, '.git'));
  if (staged && !git) throw new Error('Staged privacy checking requires a Git checkout');
  let paths, manifestFiles;
  const findings = [];
  if (git) {
    const args = staged ? ['diff','--cached','--name-only','--diff-filter=ACMRT','-z'] : ['ls-files','--cached','--others','--exclude-standard','-z'];
    paths = execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } else {
    const manifest = JSON.parse(readFileSync(join(root, 'source-manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.files)) throw new Error('Source privacy checking requires Git or a source manifest');
    manifestFiles = new Map();
    for (const file of manifest.files) {
      if (typeof file?.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || manifestFiles.has(file.path)) throw new Error('Invalid source privacy manifest');
      manifestFiles.set(file.path, file.sha256);
    }
    paths = [];
    const walk = (directory, prefix = '') => {
      for (const name of readdirSync(directory)) {
        const path = prefix + name, absolute = join(directory, name), info = lstatSync(absolute);
        if (info.isDirectory()) {
          if (['node_modules','dist','.git','.wrangler','__pycache__'].includes(name)) continue;
          if (['.local','.codex','private-data','pocket-data','feedback-assets'].includes(name)) { findings.push({ path, rule:'private_directory_present' }); continue; }
          walk(absolute, path + '/');
        } else if (path !== 'source-manifest.json') paths.push(path);
      }
    };
    walk(root);
    for (const path of manifestFiles.keys()) if (!paths.includes(path)) findings.push({path,rule:'missing_manifest_file'});
  }
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('\\') || /[\p{Cc}]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid source-check path');
    let bytes;
    if (staged) bytes = execFileSync('git', ['show', `:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    else {
      const absolute = join(root, path);
      if (!existsSync(absolute) || !lstatSync(absolute).isFile()) { findings.push({ path, rule: 'missing_or_nonregular_source_file' }); continue; }
      bytes = readFileSync(absolute);
    }
    if (manifestFiles) {
      const expected = manifestFiles.get(path);
      if (!expected) findings.push({path,rule:'unmanifested_source_file'});
      else if (createHash('sha256').update(bytes).digest('hex') !== expected) findings.push({path,rule:'source_manifest_digest_mismatch'});
    }
    findings.push(...sourcePrivacyFindings(path, bytes, markers));
  }
  return { ok: findings.length === 0, scope: staged ? 'staged_files' : git ? 'working_source_files' : 'exported_manifest_files', checkedFiles: paths.length,
    findings, limitations: ['File paths and known local private values only; unknown operator values and Git history require separate review.'] };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--staged') options.staged = true;
      else if (['--root','--deny-file'].includes(args[i]) && args[i + 1]) options[args[i++] === '--root' ? 'root' : 'denyFile'] = args[i];
      else throw new Error('Use [--root /absolute/source] [--staged] [--deny-file /absolute/private.json]');
    }
    const result = checkSourcePrivacy(options); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
