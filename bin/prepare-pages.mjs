import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClientConfig, normalizeClientConfig, serializeClientConfig } from "../shared/client-config.mjs";
import { isMain } from './is-main.mjs';
import { htmlPreviewShellPath, htmlPreviewShellAlias, interactiveHtmlPolicy } from '../shared/html-runtime-policy.mjs';
export function buildWorkerSource(profile=defaultClientConfig) {
  profile=normalizeClientConfig(profile);
  const source = readFileSync(new URL('../edge/worker.mjs',import.meta.url),'utf8');
  const policyImport = 'import { htmlPreviewShellPath, htmlPreviewShellAlias, interactiveHtmlPolicy } from "../shared/html-runtime-policy.mjs";';
  if (!source.includes(policyImport)) throw new Error('Worker HTML policy contract changed');
  return source.replace(policyImport, `const htmlPreviewShellPath = ${JSON.stringify(htmlPreviewShellPath)};\nconst htmlPreviewShellAlias = ${JSON.stringify(htmlPreviewShellAlias)};\nconst interactiveHtmlPolicy = ${JSON.stringify(interactiveHtmlPolicy)};`)
    .replace('const defaultMachine = "local";',`const defaultMachine = ${JSON.stringify(profile.defaultMachine)};`)
    .replace('const publicEntryOrigin = null;',`const publicEntryOrigin = ${JSON.stringify(profile.publicOrigin)};`);
}
export function preparePages({ directory=fileURLToPath(new URL('../dist',import.meta.url)), profile=defaultClientConfig }={}) {
  writeFileSync(resolve(directory,'_worker.js'),buildWorkerSource(profile));
  writeFileSync(resolve(directory,'client-config.js'),serializeClientConfig(profile));
  writeFileSync(resolve(directory,'_routes.json'),JSON.stringify({version:1,include:['/api/*',htmlPreviewShellPath,htmlPreviewShellAlias],exclude:[]}));
}
if(isMain(import.meta.url)) {
  const profile=process.env.POCKET_CLIENT_CONFIG ? JSON.parse(readFileSync(process.env.POCKET_CLIENT_CONFIG,'utf8')) : defaultClientConfig;
  preparePages({profile});
}
