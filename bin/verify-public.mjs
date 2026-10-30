import { readFileSync } from 'node:fs';
import { publicCheckGet } from './public-check-http.mjs';
const base = process.argv[2];
if (!base) throw new Error("URL required");
const page = await publicCheckGet(base, '/');
const policy = page.headers.get('content-security-policy');
const expectedPolicy = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').match(/Content-Security-Policy: (.+)/)?.[1];
if (page.status !== 200 || !expectedPolicy || policy !== expectedPolicy) throw new Error('Published document CSP does not match the application policy');
const connects = policy.split(';').map(value => value.trim()).find(value => value.startsWith('connect-src '))?.split(/\s+/).slice(1) ?? [];
const analytics = JSON.parse(readFileSync(new URL('../config/usage-analytics.json', import.meta.url), 'utf8'));
if (analytics.enabled && (!connects.includes(new URL(analytics.apiHost).origin) || !connects.includes('https://us-assets.i.posthog.com')))
  throw new Error('Published CSP blocks the configured PostHog ingestion or remote configuration');
for (const path of ["/api/catalog", "/api/export"]) {
  const r = await publicCheckGet(base, path);
  if (r.status !== 401)
    throw new Error(`${path} must require authentication: ${r.status}`);
}
const manifestResponse = await publicCheckGet(base, '/manifest.webmanifest');
if (manifestResponse.status !== 200) throw new Error(`Manifest must return HTTP 200: ${manifestResponse.status}`);
let manifest;
try { manifest = await manifestResponse.json(); }
catch { throw new Error('Manifest response is not valid JSON'); }
if (manifest?.display !== "standalone") throw new Error("Manifest unavailable");
console.log(
  JSON.stringify({ ok: true, anonymousProtected: true, manifest: true, documentCsp: true, analyticsConnections: analytics.enabled ? 'allowed' : 'disabled' }),
);
