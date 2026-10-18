import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { after } from 'node:test';
import assert from 'node:assert/strict';

// Load before server/index.mjs captures execFile. Synthetic thread IDs must
// never reach the user's desktop, even when recovery catches the launch error.
const attempts = [];
for (const method of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[method];
  const check = (file, args) => {
    if (file === '/usr/bin/open' || file === 'open') {
      attempts.push({ method, file, args });
      throw new Error('Native open blocked in tests; inject an openThread stub');
    }
  };
  const guarded = function (file, ...args) {
    check(file, args[0]);
    return original.call(this, file, ...args);
  };
  // execFile's custom promisifier returns { stdout, stderr }. Keep that
  // contract while checking the launch before calling the original function.
  if (original[promisify.custom]) {
    guarded[promisify.custom] = function (file, ...args) {
      check(file, args[0]);
      return original[promisify.custom].call(this, file, ...args);
    };
  }
  childProcess[method] = guarded;
}
syncBuiltinESMExports();

after(() => {
  assert.deepEqual(attempts, [], 'Tests attempted to open the real desktop');
});
