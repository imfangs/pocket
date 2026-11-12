import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';
import { readUsageAnalyticsConfig, resolveUsageAnalyticsPath } from '../bin/usage-analytics-config.mjs';
import { frontendVersion } from '../bin/build-version.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const disabled = {
  enabled: false, projectKey: '', apiHost: 'https://us.i.posthog.com',
  uiHost: 'https://us.posthog.com', origins: [], environment: 'self-hosted',
};
const legacy = {
  ...disabled, enabled: true, projectKey: 'phc_Fixture',
  origins: ['https://pocket.example.com'], environment: 'fixture', extra: 'preserve me',
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pocket-analytics-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  await copyFile(join(project, 'config/usage-analytics.example.json'), join(root, 'config/usage-analytics.example.json'));
  return root;
}

async function frontendFixture(t) {
  const root = await fixture(t);
  for (const directory of ['src', 'public', 'bin']) await mkdir(join(root, directory));
  for (const path of ['vite.config.ts', 'bin/build-version.mjs', 'bin/usage-analytics-config.mjs'])
    await copyFile(join(project, path), join(root, path));
  await writeFile(join(root, 'index.html'), '<title>Fixture</title>');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'src/entry.ts'), 'import config from "../config/usage-analytics.example.json"; export default config;');
  return root;
}

test('a missing private file selects the disabled public template without creating configuration', async t => {
  const root = await fixture(t);
  assert.equal(resolveUsageAnalyticsPath(root), join(root, 'config/usage-analytics.example.json'));
  assert.deepEqual(readUsageAnalyticsConfig(root), disabled);
  await assert.rejects(readFile(join(root, 'config/usage-analytics.json')), { code: 'ENOENT' });
});

test('legacy configuration takes precedence and preserves its contents and additional fields', async t => {
  const root = await fixture(t);
  const path = join(root, 'config/usage-analytics.json');
  const contents = `\n${JSON.stringify(legacy, null, 4)}\n`;
  await writeFile(path, contents);
  // A broken template must not replace or prevent use of a valid legacy file.
  await writeFile(join(root, 'config/usage-analytics.example.json'), 'invalid template');
  assert.equal(resolveUsageAnalyticsPath(root), path);
  assert.deepEqual(readUsageAnalyticsConfig(root), legacy);
  assert.equal(await readFile(path, 'utf8'), contents);
  await rm(join(root, 'config/usage-analytics.example.json'));
  assert.deepEqual(readUsageAnalyticsConfig(root), legacy);
});

test('invalid existing JSON and configuration shapes fail without selecting the template or quoting input', async t => {
  const root = await fixture(t);
  const path = join(root, 'config/usage-analytics.json');
  for (const contents of ['private-canary: invalid JSON', 'null', JSON.stringify({ ...legacy, enabled: 'private-canary' }), JSON.stringify({ ...legacy, origins: [123] })]) {
    await writeFile(path, contents);
    assert.equal(resolveUsageAnalyticsPath(root), path);
    assert.throws(() => readUsageAnalyticsConfig(root), error =>
      /Invalid usage analytics (JSON|configuration) \(usage-analytics\.json\)/.test(error.message) && !error.message.includes('private-canary'));
  }
});

test('an unreadable legacy path does not silently disable collection', async t => {
  const root = await fixture(t);
  const path = join(root, 'config/usage-analytics.json');
  await mkdir(path);
  assert.equal(resolveUsageAnalyticsPath(root), path);
  assert.throws(() => readUsageAnalyticsConfig(root), { code: 'EISDIR' });
  await rm(path, { recursive: true });
  await symlink(join(root, 'missing.json'), path);
  assert.equal(resolveUsageAnalyticsPath(root), path);
  assert.throws(() => readUsageAnalyticsConfig(root), { code: 'ENOENT' });
});

test('a missing or malformed template reports an error when there is no legacy configuration', async t => {
  const root = await fixture(t);
  const path = join(root, 'config/usage-analytics.example.json');
  await writeFile(path, 'private-canary: invalid JSON');
  assert.throws(() => readUsageAnalyticsConfig(root), error =>
    /Invalid usage analytics JSON \(usage-analytics\.example\.json\)/.test(error.message) && !error.message.includes('private-canary'));
  await rm(path);
  assert.throws(() => readUsageAnalyticsConfig(root), { code: 'ENOENT' });
});

test('frontend versions cover the selected analytics file and resolver, ignoring an inactive template', async t => {
  const root = await frontendFixture(t);
  const example = join(root, 'config/usage-analytics.example.json');
  const privatePath = join(root, 'config/usage-analytics.json');
  const initial = frontendVersion(root);
  await writeFile(example, JSON.stringify({ ...disabled, environment: 'template-fixture' }));
  assert.notEqual(frontendVersion(root), initial);
  const fallback = frontendVersion(root);
  await writeFile(privatePath, JSON.stringify(legacy));
  const selected = frontendVersion(root);
  assert.notEqual(selected, fallback);
  await writeFile(example, JSON.stringify(disabled));
  assert.equal(frontendVersion(root), selected);
  await writeFile(privatePath, JSON.stringify({ ...legacy, environment: 'updated-fixture' }));
  assert.notEqual(frontendVersion(root), selected);
  const beforeResolverChange = frontendVersion(root);
  await writeFile(join(root, 'bin/usage-analytics-config.mjs'), '// resolver fixture changed');
  assert.notEqual(frontendVersion(root), beforeResolverChange);
});

test('the real Vite alias bundles the selected configuration without writing build artifacts', async t => {
  for (const useLegacy of [false, true]) await t.test(useLegacy ? 'legacy file' : 'public template', async t => {
    const root = await frontendFixture(t);
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    if (useLegacy) await writeFile(join(root, 'config/usage-analytics.json'), JSON.stringify(legacy));
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(root, 'vite.config.ts'), root, 'silent');
    assert.ok(loaded);
    const output = await build({
      root, configFile: false, logLevel: 'silent', resolve: loaded.config.resolve,
      build: { write: false, minify: false, lib: { entry: join(root, 'src/entry.ts'), formats: ['es'], fileName: 'fixture' } },
    });
    const result = Array.isArray(output) ? output[0] : output;
    const chunk = result.output.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(chunk);
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
    assert.deepEqual(bundled.default, useLegacy ? legacy : disabled);
    await assert.rejects(readFile(join(root, 'dist/fixture.js')), { code: 'ENOENT' });
  });
});

test('Vite rejects invalid existing configuration before attempting a build', async t => {
  const root = await frontendFixture(t);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'config/usage-analytics.json'), 'private-canary: invalid JSON');
  await assert.rejects(
    loadConfigFromFile({ command: 'build', mode: 'production' }, join(root, 'vite.config.ts'), root, 'silent'),
    error => /Invalid usage analytics JSON \(usage-analytics\.json\)/.test(error.message) && !error.message.includes('private-canary'),
  );
});
