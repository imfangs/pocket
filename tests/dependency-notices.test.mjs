import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkDependencyNotices, updateDependencyNotices, noticeTexts } from '../bin/dependency-notices.mjs';

const grant = Buffer.from('Copyright Fixture\r\nPermission fixture\r\n\r\n');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pocket-dependency-notices-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules/fixture'), { recursive: true });
  writeFileSync(join(root, 'node_modules/fixture/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }));
  writeFileSync(join(root, 'node_modules/fixture/LICENSE'), grant);
  const lock = { packages: { '': {}, 'node_modules/fixture': {
    version: '1.0.0', license: 'MIT', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'fixture-integrity',
  } } };
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  return { root, lock };
}

test('a refresh preserves original CRLF and trailing bytes and checks the exact lock inventory', t => {
  const { root } = fixture(t);
  const result = updateDependencyNotices(root, '2026-11-12');
  assert.equal(result.ok, true);
  assert.equal(result.dependencyPaths, 1);
  const texts = noticeTexts(readFileSync(join(root, 'THIRD_PARTY_LICENSES.txt')));
  assert.deepEqual(texts.get(createHash('sha256').update(grant).digest('hex')), grant);
  const before = readFileSync(join(root, 'THIRD_PARTY_LICENSES.txt'));
  assert.equal(updateDependencyNotices(root, '2026-11-12').ok, true);
  assert.deepEqual(readFileSync(join(root, 'THIRD_PARTY_LICENSES.txt')), before);
});

test('a changed lockfile and newly added paths cannot pass an old inventory', t => {
  const { root, lock } = fixture(t);
  updateDependencyNotices(root, '2026-11-12');
  lock.packages['node_modules/new-package'] = { version: '2.0.0', license: 'ISC' };
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  const result = checkDependencyNotices(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.rule === 'lockfile_digest_changed'));
  assert.ok(result.issues.some(issue => issue.rule === 'missing_dependency_path'));
});

test('inventory metadata, duplicate paths and removed license arrays are detected', t => {
  const { root } = fixture(t);
  updateDependencyNotices(root, '2026-11-12');
  const path = join(root, 'THIRD_PARTY_DEPENDENCIES.json');
  const inventory = JSON.parse(readFileSync(path));
  inventory.packages[0].version = '0.0.0';
  delete inventory.packages[0].licenseTexts;
  inventory.packages.push({ ...inventory.packages[0] });
  writeFileSync(path, JSON.stringify(inventory));
  const issues = checkDependencyNotices(root).issues;
  assert.ok(issues.some(issue => issue.rule === 'duplicate_dependency_path'));
  assert.ok(issues.some(issue => issue.rule === 'dependency_metadata_changed'));
  assert.ok(issues.some(issue => issue.rule === 'invalid_license_text_inventory'));
});

test('tampering with an original notice fails its recorded digest', t => {
  const { root } = fixture(t);
  updateDependencyNotices(root, '2026-11-12');
  const path = join(root, 'THIRD_PARTY_LICENSES.txt');
  writeFileSync(path, readFileSync(path).toString().replace('Permission fixture', 'Permission changed'));
  assert.throws(() => checkDependencyNotices(root), /digest mismatch/);
});

test('other-platform packages remain inventoried and missing installed notices remain explicit', t => {
  const { root, lock } = fixture(t);
  rmSync(join(root, 'node_modules/fixture/LICENSE'));
  lock.packages['node_modules/other-platform'] = { version: '1.0.0', license: 'MIT', optional: true, dev: true };
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  const result = updateDependencyNotices(root, '2026-11-12');
  assert.equal(result.ok, true);
  assert.equal(result.dependencyPaths, 2);
  assert.equal(result.unresolvedInstalledTexts.length, 1);
  assert.equal(result.unresolvedInstalledTexts[0].name, 'fixture');
});

test('an installed version mismatch is refused before writing a new inventory', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'node_modules/fixture/package.json'), JSON.stringify({ name: 'fixture', version: '2.0.0' }));
  assert.throws(() => updateDependencyNotices(root, '2026-11-12'), /does not match lockfile/);
});
