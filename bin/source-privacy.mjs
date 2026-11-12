import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Public installation documentation is shared with the source exporter.
// Operator notes stay local, even when they have no obvious secret pattern.
export const publicSourceDocumentationPaths = new Set([
  'docs/SELF_HOSTING.md', 'docs/SELF_HOSTING.zh-CN.md', 'docs/COMPATIBILITY.md',
  'docs/UPGRADING.md', 'docs/PUBLIC_HISTORY.md',
  'docs/OPEN_SOURCE_READINESS.md', 'docs/DEVELOPMENT.md', 'docs/ALTERNATIVES.md',
  'docs/assets/pocket-architecture.svg', 'docs/assets/pocket-architecture.html',
  'docs/assets/pocket-architecture.json', 'docs/assets/README.md',
  'docs/assets/pocket-preview.png',
  ...['zh', 'en'].flatMap(locale => ['overview', 'workspace', 'reading', 'decisions'].map(view => `docs/assets/pocket-${view}-${locale}.png`)),
  'docs/assets/ARCHIFY-LICENSE.txt', 'docs/assets/JetBrainsMono-OFL.txt',
]);

const validPrivateMarker = value => typeof value === 'string' && value.length <= 2048 &&
  (value.length >= 6 || /^\p{Script=Han}{2,16}$/u.test(value));

// This is a file/known-value release guard, not a general secrets detector.
export function privateSourcePathReason(path) {
  const parts = path.split('/'), name = parts.at(-1);
  if (parts.some(part => ['.git','.local','.codex','.impeccable','node_modules','dist','__pycache__','private-data','pocket-data','feedback-assets'].includes(part))) return 'private_or_generated_directory';
  if (['CURRENT.md', 'HISTORY.md', 'design/brand/README.md'].includes(path) ||
      (parts[0] === 'docs' && !publicSourceDocumentationPaths.has(path))) return 'private_maintenance_document';
  if (/^\.env(?:\.|$)/.test(name) || /^\.dev\.vars/.test(name)) return 'environment_credentials';
  if (/\.(?:sqlite[^/]*|db(?:-[^/]*)?|log|pyc|key|p12|pfx)$/.test(name) || /^(?:id_rsa|id_ed25519)(?:\.|$)/.test(name)) return 'database_log_or_private_key';
  if (/^(?:initial-passphrase\.txt|web-push-keys\.json|feedback-config\.json|relay-credentials\.json|relay-registration\.json|connection\.json(?:\.tmp)?|.*\.(?:private|local)\.json|(?:codex-)?navigator-\d[^/]*\.json)$/.test(name)) return 'private_runtime_file';
  if (parts.length > 1 && ['data','backups','attachments','logs','screenshots','exports'].includes(parts[0])) return 'private_data_directory';
  if (['config/local-service.json','config/tunnel-service.json','config/pages-site.json','config/relay.json','wrangler.jsonc'].includes(path)) return 'personal_operations_config';
  return null;
}

function regularJson(path) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error('Privacy guard input must be a regular file');
  const bytes = readFileSync(path);
  if (bytes.length > 65536) throw new Error('Privacy guard input is too large');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid privacy guard input'); }
}

export function privateSourceMarkers(root, denyFile = process.env.POCKET_SOURCE_PRIVACY_DENY_FILE, pocketConfigFile = process.env.POCKET_CONFIG) {
  const markers = new Map();
  const add = (value, kind) => { if (validPrivateMarker(value)) markers.set(value.toLowerCase(), kind); };
  const domain = value => {
    if (typeof value !== 'string') return;
    let host = value;
    if (value.includes('://')) { try { host = new URL(value).hostname; } catch { return; } }
    if (/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(host) && !/(?:^|\.)(?:localhost|local|invalid|test|example|example\.com|example\.org|example\.net)$/i.test(host)) add(host, 'personal_deployment_domain');
  };
  if (pocketConfigFile && (typeof pocketConfigFile !== 'string' || !pocketConfigFile.startsWith('/'))) throw new Error('POCKET_CONFIG must use an absolute file path');
  const inputs = ['config/pages-site.json','config/relay.json','config/local-service.json','config/desktop-bridge.json','.local/pocket/config.json'].map(name => join(root, name));
  if (pocketConfigFile) inputs.push(pocketConfigFile);
  for (const path of new Set(inputs)) {
    const value = regularJson(path);
    if (!value) continue;
    for (const key of ['domain','dns_zone','publicOrigin']) domain(value[key]);
    for (const key of ['account_id','accountId','namespaceId']) add(value[key], 'personal_infrastructure_identifier');
    const visit = item => {
      if (typeof item === 'string') { const home = /^\/Users\/[^/]+(?=\/|$)/.exec(item); if (home) add(home[0], 'personal_home_path'); }
      else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object') for (const [key,child] of Object.entries(item)) {
        if (['domain','dns_zone','publicOrigin'].includes(key)) domain(child);
        if (['dataDir','codexHome'].includes(key) && typeof child === 'string' && child.startsWith('/')) add(child,'personal_data_path');
        visit(child);
      }
    };
    visit(value);
  }
  const localDenyFile = join(root, '.local/privacy/deny.private.json');
  const selectedDenyFile = denyFile || (existsSync(localDenyFile) ? localDenyFile : null);
  if (selectedDenyFile) {
    if (typeof selectedDenyFile !== 'string' || !selectedDenyFile.startsWith('/')) throw new Error('Privacy deny file must use an absolute path');
    const value = regularJson(resolve(selectedDenyFile));
    if (!value || !Array.isArray(value.values) || value.values.some(item => !validPrivateMarker(item))) throw new Error('Privacy deny file needs a values array');
    value.values.forEach(item => add(item, 'operator_denied_value'));
  }
  return markers;
}

export function sourcePrivacyFindings(path, bytes, markers = new Map()) {
  const findings = [];
  const reason = privateSourcePathReason(path);
  if (reason) findings.push({ path, rule: reason });
  if (path === 'config/desktop-bridge.json') {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { /* Invalid public configuration also fails. */ }
    if (!value || Object.keys(value).length !== 1 || value.python !== 'python3') findings.push({ path, rule: 'private_bridge_configuration' });
  }
  if (path === 'config/usage-analytics.json') {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { /* Invalid public configuration also fails. */ }
    if (!value || value.enabled !== false || value.projectKey !== '' || !Array.isArray(value.origins) || value.origins.length) findings.push({ path, rule: 'enabled_or_personal_telemetry' });
  }
  const text = bytes.toString('utf8').toLowerCase(), kinds = new Set();
  for (const [value, kind] of markers) if (text.includes(value)) kinds.add(kind);
  for (const rule of kinds) findings.push({ path, rule });
  return findings;
}
