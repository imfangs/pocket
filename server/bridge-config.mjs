import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// A machine owns its executable paths; shared releases keep one source tree.
export function readBridgeConfig(path = process.env.NAVIGATOR_BRIDGE_CONFIG) {
  if (path && !isAbsolute(path)) throw new Error('NAVIGATOR_BRIDGE_CONFIG must be absolute');
  return JSON.parse(readFileSync(path || new URL('../config/desktop-bridge.json', import.meta.url), 'utf8'));
}
