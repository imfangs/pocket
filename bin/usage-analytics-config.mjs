import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/** Preserve existing self-hosted configuration; only absence selects the template. */
export function resolveUsageAnalyticsPath(root) {
  const legacy = resolve(root, 'config/usage-analytics.json');
  try {
    lstatSync(legacy);
    return legacy;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolve(root, 'config/usage-analytics.example.json');
}

export function readUsageAnalyticsConfig(root) {
  const path = resolveUsageAnalyticsPath(root);
  const contents = readFileSync(path, 'utf8');
  let config;
  try { config = JSON.parse(contents); }
  catch {
    // JSON.parse errors may quote private input. Report the file without its contents.
    throw new SyntaxError(`Invalid usage analytics JSON (${basename(path)})`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof config.enabled !== 'boolean' ||
      !['projectKey', 'apiHost', 'uiHost', 'environment'].every(key => typeof config[key] === 'string') ||
      !Array.isArray(config.origins) || !config.origins.every(origin => typeof origin === 'string'))
    throw new Error(`Invalid usage analytics configuration (${basename(path)})`);
  return config;
}
