import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { makeApp } from '../server/index.mjs';

test('both serving paths allow only the required PostHog connections while preserving script and frame restrictions', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'pocket-csp-'));
  const { server } = makeApp({ dataDir: temp, codexHome: temp, readSource: () => ({ threads: [], projects: [], sourceInfo: {} }), openThread: async () => { throw new Error('CSP check must not open a task'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  const local = response.headers.get('content-security-policy');
  const pages = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').match(/Content-Security-Policy: (.+)/)[1];
  assert.equal(local, pages, 'a .local document must not silently use a stricter, incompatible policy');
  for (const policy of [local, pages]) {
    const directives = new Map(policy.split(';').map(item => item.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    assert.deepEqual(new Set(directives.get('connect-src')), new Set(["'self'", 'https://us.i.posthog.com', 'https://us-assets.i.posthog.com']));
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
    assert.deepEqual(directives.get('default-src'), ["'self'"]);
  }
});
