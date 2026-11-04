import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const installedDesktopContracts = new Set([
  'archive-thread.test.mjs',
  'create-thread-protocol.test.mjs',
]);
const files = readdirSync(resolve(root, 'tests')).filter(name => name.endsWith('.test.mjs') && !installedDesktopContracts.has(name)).sort();
if (!files.length) throw new Error('No synthetic tests were selected');

// These two suites start the installed desktop app's bundled CLI in isolated
// homes. A CI machine without that app must not claim those protocol results.
process.stdout.write(`Synthetic suites: ${files.length}. Separate installed-desktop contracts: ${[...installedDesktopContracts].join(', ')}.\n`);
const result = spawnSync(process.execPath, [
  '--import', './tests/helpers/client-profile.mjs',
  '--import', './tests/helpers/block-native-open.mjs',
  '--test', '--test-concurrency=4', ...files.map(name => `tests/${name}`),
], { cwd: root, env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
