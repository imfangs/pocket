import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../bin/is-main.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// These contracts deliberately retain the production bundle/CLI preflight.
// Some use synthetic IPC endpoints, but that does not remove their installed
// Codex dependency. Keep them in npm test; never replace that guard for CI.
export const installedDesktopContracts = Object.freeze({
  'archive-empty-settings.test.mjs': 'Creates real settings-only threads and archives/restores them with the installed bundled CLI in isolated homes.',
  'archive-thread.test.mjs': 'Uses the installed bundled CLI for archive/unarchive and real writer-lock contracts in isolated homes.',
  'create-thread-protocol.test.mjs': 'Starts the installed bundled CLI to verify empty-thread materialization and persistent creation receipts.',
  'desktop-protocol.test.mjs': 'Synthetic IPC peers call desktop-bridge.py through its configured installed-App identity preflight.',
  'model-settings-protocol.test.mjs': 'Synthetic model IPC calls retain desktop-bridge.py installed-App identity preflight even when the model catalog is injected.',
  'read-state-protocol.test.mjs': 'Synthetic read-state IPC calls retain read-state.py installed-App identity preflight.',
  'rename-thread-protocol.test.mjs': 'Creates and renames real threads with the installed bundled CLI in isolated homes.',
});

export function selectSyntheticTests(names) {
  const available = new Set(names.filter(name => name.endsWith('.test.mjs')));
  for (const name of Object.keys(installedDesktopContracts)) {
    if (!available.has(name)) throw new Error(`Installed desktop contract is missing or renamed: ${name}`);
  }
  const files = [...available].filter(name => !Object.hasOwn(installedDesktopContracts, name)).sort();
  if (!files.length) throw new Error('No synthetic tests were selected');
  return files;
}

export function main() {
  const files = selectSyntheticTests(readdirSync(resolve(root, 'tests')));
  process.stdout.write(`Synthetic suites: ${files.length}. Separate installed-desktop suites: ${Object.keys(installedDesktopContracts).length}.\n`);
  for (const [name, reason] of Object.entries(installedDesktopContracts)) process.stdout.write(`Installed-desktop contract: ${name} — ${reason}\n`);
  process.stdout.write('Run npm test on a supported isolated Mac for all contracts. Entire mixed suites stay there; synthetic success does not claim their helper or native coverage.\n');
  const result = spawnSync(process.execPath, [
    '--import', './tests/helpers/client-profile.mjs',
    '--import', './tests/helpers/block-native-open.mjs',
    '--test', '--test-concurrency=4', ...files.map(name => `tests/${name}`),
  ], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (isMain(import.meta.url)) main();
