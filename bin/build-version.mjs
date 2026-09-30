import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Hash only explicitly public frontend inputs. No environment, credentials,
// working history or local state enters the version file.
export function frontendVersion(root) {
  const hash = createHash('sha256');
  const add = path => { hash.update(path + '\0');hash.update(readFileSync(join(root, path)));hash.update('\0'); };
  const walk = dir => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) add(path);
    }
  };
  walk('src');walk('public');
  for (const path of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'bin/build-version.mjs']) add(path);
  return hash.digest('hex');
}

export function versionManifest(id) {
  return {
    name: 'pocket-version', apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: 'pocket-build', content: id }, injectTo: 'head' }];
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(path => /^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(path)).sort().map(path => '/' + path);
      this.emitFile({ type: 'asset', fileName: 'pocket-version.json', source: JSON.stringify({ id, assets }) });
    },
  };
}
