import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundledModules = join(root, 'vendor/codex-bridge');
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const executable = path => { try { accessSync(path, constants.X_OK);return isFile(path); } catch { return false; } };
function absolute(value, field) {
  if (typeof value !== 'string' || !value || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  return value;
}
function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return resolve(candidate);
  }
  return null;
}
function python(value, automatic) {
  if (value !== undefined && value !== null && (typeof value !== 'string' || !value)) throw new Error('python must name an executable');
  if (value && isAbsolute(value)) {
    if (!automatic || executable(value)) return value;
  } else if (value) {
    if (value.includes('/') || value.includes('\\')) throw new Error('python must be absolute or an executable name');
    const found = findExecutable(value);
    if (found) return found;
    if (!automatic) throw new Error('Configured Python executable was not found');
  }
  const found = findExecutable('python3');
  if (!found) throw new Error('Python 3 was not found on PATH');
  return found;
}
function modules(value, field, required, automatic) {
  if (value === undefined || value === null) return bundledModules;
  absolute(value, field);
  return automatic && !required.every(name => isFile(join(value, name))) ? bundledModules : value;
}
function appPath(value, automatic) {
  if (value !== undefined && value !== null) {
    absolute(value, 'appPath');
    if (!automatic || isDirectory(value)) return value;
  }
  const candidates = ['/Applications/Codex.app', join(homedir(), 'Applications/Codex.app')];
  return candidates.find(isDirectory) || candidates[0];
}

// A machine owns its executable paths; shared releases keep one source tree.
export function readBridgeConfig(path = process.env.NAVIGATOR_BRIDGE_CONFIG) {
  if (path && !isAbsolute(path)) throw new Error('NAVIGATOR_BRIDGE_CONFIG must be absolute');
  const filename = path || join(root, 'config/desktop-bridge.json');
  const config = existsSync(filename) || path ? JSON.parse(readFileSync(filename, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Bridge configuration must be an object');
  const automatic = !path;
  return { ...config, python: python(config.python, automatic),
    ipcModuleDirectory: modules(config.ipcModuleDirectory, 'ipcModuleDirectory', ['app_ipc.py', 'contracts.py'], automatic),
    metadataModuleDirectory: modules(config.metadataModuleDirectory, 'metadataModuleDirectory', ['archive_cli.py', 'metadata_cli.py'], automatic),
    appPath: appPath(config.appPath, automatic) };
}
