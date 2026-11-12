#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isMain } from './is-main.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const inventoryName = 'THIRD_PARTY_DEPENDENCIES.json';
const noticesName = 'THIRD_PARTY_LICENSES.txt';
const separator = '='.repeat(72);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packageName = (path, value) => value.name || path.split('node_modules/').at(-1);

export function noticeTexts(bytes) {
  const result = new Map();
  const marker = Buffer.from(`\n${separator}\nPackages: `);
  let start = bytes.indexOf(marker);
  while (start >= 0) {
    const bodyAt = bytes.indexOf('\n\n', start) + 2;
    if (bodyAt < 2) throw new Error('Incomplete third-party notice header');
    const header = bytes.subarray(start, bodyAt).toString('utf8');
    const hash = /Text SHA256: ([a-f0-9]{64})/.exec(header)?.[1];
    const next = bytes.indexOf(marker, bodyAt);
    const length = /Text bytes: (\d+)/.exec(header)?.[1];
    let body;
    if (length !== undefined) {
      body = bytes.subarray(bodyAt, bodyAt + Number(length));
      if (body.length !== Number(length) || digest(body) !== hash) throw new Error('Third-party notice digest mismatch');
    } else {
      // Read older inventories only when their original bytes can be recovered.
      const candidate = bytes.subarray(bodyAt, next < 0 ? bytes.length : next);
      for (let cut = 0; cut <= 4 && cut <= candidate.length; cut++) {
        const trial = candidate.subarray(0, candidate.length - cut);
        if (digest(trial) === hash) { body = trial; break; }
      }
    }
    if (body && hash) result.set(hash, body);
    start = next;
  }
  return result;
}

export function checkDependencyNotices(root = defaultRoot) {
  const lockBytes = readFileSync(join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes), inventory = JSON.parse(readFileSync(join(root, inventoryName)));
  const texts = noticeTexts(readFileSync(join(root, noticesName)));
  const issues = [];
  if (inventory.lockfileSha256 !== digest(lockBytes)) issues.push({ rule: 'lockfile_digest_changed' });
  const recorded = new Map();
  for (const entry of inventory.packages || []) {
    if (recorded.has(entry.path)) issues.push({ rule: 'duplicate_dependency_path', path: entry.path });
    recorded.set(entry.path, entry);
  }
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path) continue;
    const entry = recorded.get(path);
    if (!entry) { issues.push({ rule: 'missing_dependency_path', path }); continue; }
    if (!Array.isArray(entry.licenseTexts)) issues.push({ rule: 'invalid_license_text_inventory', path });
    for (const [field, expected] of Object.entries({ name: packageName(path, value), version: value.version,
      source: value.resolved || null, integrity: value.integrity || null, dev: !!value.dev, optional: !!value.optional }))
      if (entry[field] !== expected) issues.push({ rule: 'dependency_metadata_changed', path, field });
    if (value.license && entry.licenseDeclared !== value.license) issues.push({ rule: 'declared_license_changed', path });
    for (const text of entry.licenseTexts || []) if (!texts.has(text.sha256))
      issues.push({ rule: 'missing_or_invalid_license_text', path });
    recorded.delete(path);
  }
  for (const path of recorded.keys()) issues.push({ rule: 'obsolete_dependency_path', path });
  return { ok: !issues.length, dependencyPaths: Object.keys(lock.packages).length - 1,
    licenseTexts: texts.size, unresolvedInstalledTexts: inventory.installedPackagesWithoutLicenseText || [], issues };
}

export function updateDependencyNotices(root = defaultRoot, generatedOn = new Date().toISOString().slice(0, 10)) {
  const lockBytes = readFileSync(join(root, 'package-lock.json')), lock = JSON.parse(lockBytes);
  const old = existsSync(join(root, inventoryName)) ? JSON.parse(readFileSync(join(root, inventoryName))) : { packages: [] };
  const previous = new Map(old.packages.map(entry => [entry.path, entry]));
  const oldTexts = existsSync(join(root, noticesName)) ? noticeTexts(readFileSync(join(root, noticesName))) : new Map();
  const evidencePath = join(root, 'vendor/license-evidence/manifest.json');
  const retained = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath)).packages : [];
  const texts = new Map(), entries = [], unresolved = [];
  for (const [path, value] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsupported dependency path');
    const directory = join(root, path), manifest = join(directory, 'package.json');
    let installed;
    if (existsSync(manifest)) {
      installed = JSON.parse(readFileSync(manifest));
      if (installed.version !== value.version || installed.name !== packageName(path, value))
        throw new Error(`Installed package does not match lockfile: ${path}`);
    }
    const entry = { path, name: packageName(path, value), version: value.version,
      licenseDeclared: value.license || installed?.license || previous.get(path)?.licenseDeclared || null,
      dev: !!value.dev, optional: !!value.optional, source: value.resolved || null,
      integrity: value.integrity || null, licenseTexts: [] };
    const add = (bytes, evidence) => {
      const hash = digest(bytes); texts.set(hash, bytes);
      if (!entry.licenseTexts.some(text => text.sha256 === hash)) entry.licenseTexts.push({ sha256: hash, evidence });
    };
    if (installed) {
      for (const name of readdirSync(directory).sort()) {
        if (!/^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i.test(name)) continue;
        const file = join(directory, name);
        if (!lstatSync(file).isFile()) continue;
        add(readFileSync(file), { kind: 'installed package; exact version checked', file: name });
      }
    }
    const earlier = previous.get(path);
    if (!entry.licenseTexts.length && earlier?.version === entry.version && earlier?.source === entry.source && earlier?.integrity === entry.integrity)
      for (const text of earlier.licenseTexts || []) if (oldTexts.has(text.sha256)) add(oldTexts.get(text.sha256), text.evidence);
    for (const proof of retained.filter(proof => proof.name === entry.name && proof.version === entry.version)) {
      if (!proof.file.startsWith('vendor/license-evidence/') || proof.file.split('/').includes('..')) throw new Error('Invalid retained license path');
      const bytes = readFileSync(join(root, proof.file));
      if (digest(bytes) !== proof.sha256) throw new Error('Retained license evidence digest mismatch');
      add(bytes, proof.evidence);
    }
    if (installed && !entry.licenseTexts.length) unresolved.push({ name: entry.name, version: entry.version,
      licenseDeclared: entry.licenseDeclared, dev: entry.dev,
      reason: 'Installed exact version has no standalone notice; immutable upstream text remains unverified.' });
    entries.push(entry);
  }
  const inventory = { generatedOn, lockfileSha256: digest(lockBytes), packages: entries,
    installedPackagesWithoutLicenseText: unresolved,
    note: 'Current lockfile inventory. Installed versions are checked; original notice bytes are preserved. Other-platform archives are listed without claiming they were installed. SPDX declarations and notice availability are separate from a complete license review.' };
  const blocks = [Buffer.from(`Third-party license texts\n\nGenerated for the current public lockfile on ${generatedOn}. Original license and copyright bytes are retained. Installed package versions were checked; archives were not independently re-downloaded by this command. Unresolved notices and other-platform packages are recorded in ${inventoryName}.\n`)];
  for (const [hash, bytes] of [...texts].sort(([a], [b]) => a.localeCompare(b))) {
    const packages = [...new Set(entries.filter(entry => entry.licenseTexts.some(text => text.sha256 === hash)).map(entry => `${entry.name}@${entry.version}`))].sort();
    blocks.push(Buffer.from(`\n${separator}\nPackages: ${packages.join(', ')}\nText SHA256: ${hash}\nText bytes: ${bytes.length}\n\n`), bytes, Buffer.from('\n'));
  }
  writeFileSync(join(root, inventoryName), JSON.stringify(inventory, null, 2) + '\n');
  writeFileSync(join(root, noticesName), Buffer.concat(blocks));
  return checkDependencyNotices(root);
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2), mode = args.shift() || '--check';
    if (!['--check', '--update'].includes(mode) || args.length) throw new Error('Use --check or --update');
    const result = mode === '--update' ? updateDependencyNotices(resolve(defaultRoot)) : checkDependencyNotices(resolve(defaultRoot));
    console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
