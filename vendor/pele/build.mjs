import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately uses the repository's existing build dependencies. No install or network access.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../package.json'));
const tools = { esbuild: require('esbuild/package.json').version, typescript: require('typescript/package.json').version };
if (tools.esbuild !== '0.28.2' || tools.typescript !== '5.9.3') {
  throw new Error(`Reproduction requires esbuild 0.28.2 and TypeScript 5.9.3; found ${JSON.stringify(tools)}`);
}
const { build } = require('esbuild');
const sourceManifest = JSON.parse(readFileSync(join(here, 'source-manifest.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const archive = join(here, 'source-44da152.tar.gz');
if (hash(readFileSync(archive)) !== sourceManifest.archiveSha256) throw new Error('Source archive checksum mismatch');
const staging = mkdtempSync(join(tmpdir(), 'pocket-pele-'));
const source = join(staging, 'source');
const pkg = join(staging, 'package');
const version = '1.6.0-pocket.44da152';
try {
  mkdirSync(source);
  mkdirSync(pkg);
  execFileSync('tar', ['-xzf', archive, '-C', source]);
  for (const [path, expected] of Object.entries(sourceManifest.files)) {
    if (hash(readFileSync(join(source, path))) !== expected) throw new Error(`Upstream source mismatch: ${path}`);
  }
  const result = await build({
    absWorkingDir: source,
    entryPoints: {
      core: 'src/core.ts',
      'diagrams/flowchart': 'src/entries/flowchart.ts',
      'diagrams/sequence': 'src/entries/sequence.ts',
      'diagrams/state': 'src/entries/state.ts',
    },
    outdir: join(pkg, 'dist/esm'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'warning',
    splitting: true,
    chunkNames: 'chunks/[hash]',
    metafile: true,
  });
  execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'), '-p', join(source, 'tsconfig.json'),
    '--lib', 'ES2022,DOM,DOM.Iterable', '--outDir', join(pkg, 'dist'),
  ], { cwd: source, stdio: 'inherit' });
  // TypeScript 5.9 needs DOM.Iterable for FontFaceSet.size; source code stays byte-for-byte upstream.
  const entry = (js, types) => ({ types, import: js, default: js });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'pele', version,
    description: 'Pocket build of Pele: core plus flowchart, sequence and state renderers.',
    license: 'MIT', type: 'module',
    repository: { type: 'git', url: 'git+https://github.com/obsidianmd/pele.git' },
    main: './dist/esm/core.js', module: './dist/esm/core.js', types: './dist/core.d.ts',
    exports: {
      '.': entry('./dist/esm/core.js', './dist/core.d.ts'),
      './core': entry('./dist/esm/core.js', './dist/core.d.ts'),
      ...Object.fromEntries(['flowchart', 'sequence', 'state'].map(type => [
        `./diagrams/${type}`, entry(`./dist/esm/diagrams/${type}.js`, `./dist/entries/${type}.d.ts`),
      ])),
      './package.json': './package.json',
    },
    sideEffects: false,
    files: ['dist', 'LICENSE', 'README.md', 'UPSTREAM-README.md', 'PROVENANCE.json'],
    engines: { node: '>=20' },
  }, null, 2) + '\n');
  cpSync(join(source, 'LICENSE'), join(pkg, 'LICENSE'));
  cpSync(join(source, 'README.md'), join(pkg, 'UPSTREAM-README.md'));
  writeFileSync(join(pkg, 'README.md'), [
    '# Pele for Pocket', '',
    `Local build ${version}, from https://github.com/obsidianmd/pele/tree/${sourceManifest.commit}.`,
    'Includes the upstream CJK line-wrapping fix after 1.6.0. No upstream runtime source was modified.',
    'Only core, flowchart, sequence and state runtime entry points are included. Root import is core;',
    'register the selected diagram types explicitly. No lazy/all-diagrams entry is provided.',
    'Build recipe, source checksums and provenance are maintained in Pocket vendor/pele/.',
    'MIT license and original upstream README are included. This is not an official npm release.', '',
  ].join('\n'));
  const provenance = {
    name: 'pele', version,
    upstreamRepository: sourceManifest.upstream,
    upstreamCommit: sourceManifest.commit,
    sourceArchiveSha256: sourceManifest.archiveSha256,
    runtimeSourceModified: false,
    runtimeTypes: ['flowchart', 'sequence', 'state'],
    buildTools: tools,
    typecheckLibraries: ['ES2022', 'DOM', 'DOM.Iterable'],
  };
  writeFileSync(join(pkg, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', here], {
    cwd: pkg, encoding: 'utf8',
  }))[0];
  const receipt = {
    ...provenance,
    archive: packed.filename,
    sha256: hash(readFileSync(join(here, packed.filename))),
    integrity: packed.integrity,
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    runtimeFiles: Object.entries(result.metafile.outputs).map(([path, meta]) => ({
      path: path.slice(path.indexOf('dist/esm/')), bytes: meta.bytes,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(join(here, 'package-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
