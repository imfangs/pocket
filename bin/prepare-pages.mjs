import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClientConfig, normalizeClientConfig, serializeClientConfig } from "../shared/client-config.mjs";
import { isMain } from './is-main.mjs';
export function buildWorkerSource(profile=defaultClientConfig) {
  profile=normalizeClientConfig(profile);
  return readFileSync(new URL('../edge/worker.mjs',import.meta.url),'utf8')
    .replace('const defaultMachine = "local";',`const defaultMachine = ${JSON.stringify(profile.defaultMachine)};`)
    .replace('const publicEntryOrigin = null;',`const publicEntryOrigin = ${JSON.stringify(profile.publicOrigin)};`);
}
export function preparePages({ directory=fileURLToPath(new URL('../dist',import.meta.url)), profile=defaultClientConfig }={}) {
  writeFileSync(resolve(directory,'_worker.js'),buildWorkerSource(profile));
  writeFileSync(resolve(directory,'client-config.js'),serializeClientConfig(profile));
  writeFileSync(resolve(directory,'_routes.json'),JSON.stringify({version:1,include:['/api/*'],exclude:[]}));
}
if(isMain(import.meta.url)) {
  const profile=process.env.POCKET_CLIENT_CONFIG ? JSON.parse(readFileSync(process.env.POCKET_CLIENT_CONFIG,'utf8')) : defaultClientConfig;
  preparePages({profile});
}
