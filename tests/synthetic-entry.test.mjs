import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installedDesktopContracts, selectSyntheticTests } from '../.github/scripts/test-synthetic.mjs';

test('synthetic selection separates installed-App and CLI contracts while retaining mock and data coverage', () => {
  const names = readdirSync(fileURLToPath(new URL('.', import.meta.url)));
  const selected = selectSyntheticTests(names);
  const native = Object.keys(installedDesktopContracts);
  assert.equal(native.length, 7);
  for (const name of native) {
    assert.ok(!selected.includes(name), name);
    assert.ok(installedDesktopContracts[name].length > 40, 'Every separate contract records its concrete installed dependency');
  }
  for (const name of ['bundled-cli.test.mjs', 'bridge-config.test.mjs', 'task-statuses-protocol.test.mjs', 'read-state.test.mjs', 'thread-models.test.mjs', 'lifecycle.test.mjs', 'self-hosting.test.mjs', 'synthetic-entry.test.mjs']) {
    assert.ok(selected.includes(name), `${name} must retain synthetic coverage`);
  }
  assert.equal(selected.length + native.length, names.filter(name => name.endsWith('.test.mjs')).length);
  assert.deepEqual(selected, [...selected].sort());
});

test('renaming an installed contract requires an explicit classification update', () => {
  const names = [...Object.keys(installedDesktopContracts), 'mock.test.mjs'];
  assert.throws(() => selectSyntheticTests(names.filter(name => name !== 'desktop-protocol.test.mjs')), /missing or renamed: desktop-protocol/);
});
