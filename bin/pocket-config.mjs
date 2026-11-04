import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultClientConfig, normalizeClientConfig } from '../shared/client-config.mjs';
import { normalizeDeploymentConfig } from '../server/deployment-config.mjs';
import { readBridgeConfig } from '../server/bridge-config.mjs';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const defaultConfigPath = join(projectRoot, '.local/pocket/config.json');
const absolute = value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value);
export function normalizePocketConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      Object.keys(value).some(key => !['schemaVersion','port','dataDir','codexHome','client','deployment','bridgeConfig'].includes(key))) throw new Error('Invalid Pocket configuration');
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !absolute(value.dataDir) || !absolute(value.codexHome)) throw new Error('Invalid Pocket port or data path');
  const client = normalizeClientConfig(value.client), deployment = normalizeDeploymentConfig(value.deployment);
  if (deployment.machineId !== client.defaultMachine || deployment.publicOrigin !== client.publicOrigin) throw new Error('Client and deployment identity must agree');
  if (!absolute(value.bridgeConfig)) throw new Error('The bridge configuration must use an absolute path');
  return { ...value, client, deployment: value.deployment };
}
export function readPocketConfig(path = process.env.POCKET_CONFIG || defaultConfigPath) {
  if (!absolute(path)) throw new Error('POCKET_CONFIG must be an absolute file path');
  if (!existsSync(path)) throw new Error('Pocket is not configured. Run npm run setup first.');
  const content = readFileSync(path); if (content.length > 65536) throw new Error('Pocket configuration is too large');
  let value; try { value=JSON.parse(content.toString('utf8')); } catch { throw new Error('Unable to parse Pocket configuration'); }
  return { path: resolve(path), value: normalizePocketConfig(value) };
}
export function writePrivateJson(path, value, replace = false) {
  if (!absolute(path) || existsSync(path) && !replace) throw new Error('Configuration already exists or path is invalid');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path); chmodSync(path, 0o600);
}
export function setupPocket({ path = defaultConfigPath, port = 4397, dataDir, codexHome, publicOrigin, label = 'My Mac', machineId = 'local' } = {}) {
  path = resolve(path);
  if (existsSync(path)) return { path, created: false, ...readPocketConfig(path) };
  const bridgePath = join(dirname(path), 'bridge.json');
  const client = normalizeClientConfig({ ...defaultClientConfig, defaultMachine: machineId, machines: [{ id: machineId, label }], publicOrigin: publicOrigin || null });
  const deployment = { schemaVersion: 1, machineId, minimumPassphraseLength: 12,
    ...(client.publicOrigin ? { publicOrigin: client.publicOrigin } : {}) };
  const value = normalizePocketConfig({ schemaVersion: 1, port, dataDir: dataDir || join(homedir(),'Library/Application Support/CodexNavigator'),
    codexHome: codexHome || join(homedir(),'.codex'), client, deployment, bridgeConfig: bridgePath });
  if (!existsSync(bridgePath)) writePrivateJson(bridgePath, readBridgeConfig());
  writePrivateJson(path, value);
  return { path, created: true, value };
}
