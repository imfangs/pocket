import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
  if (existsSync(join(root, 'shared'))) walk('shared');
  for (const path of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'bin/build-version.mjs']) add(path);
  return hash.digest('hex');
}

export function versionManifest(id) {
  return {
    name: 'pocket-version', apply: 'build',
    transformIndexHtml(html) {
      return {
        // Old installed service workers cache the bare startup.css path. Their
        // existing query bypass lets a new entry use its matching startup styles.
        html: html.replace(/href=(["'])\/startup\.css(?:\?[^"']*)?\1/g,
          (_match, quote) => `href=${quote}/startup.css?v=${encodeURIComponent(id)}${quote}`),
        tags: [{ tag: 'meta', attrs: { name: 'pocket-build', content: id }, injectTo: 'head' }],
      };
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(path => /^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(path)).sort().map(path => '/' + path);
      this.emitFile({ type: 'asset', fileName: 'pocket-version.json', source: JSON.stringify({ id, assets }) });
    },
  };
}
