#!/usr/bin/env node
/**
 * Builds the offline web runtime that ships inside the APK.
 *
 * Steps:
 *   1. clean `web/dist`;
 *   2. collect the whitelisted vendor files (see collect-vendor.mjs);
 *   3. bundle the application TypeScript with esbuild (ESM, code splitting, no
 *      source maps) into `web/dist/assets`;
 *   4. copy the shell page and stylesheets;
 *   5. write `web/vendor-manifest.json` with every path, byte size, SHA-256, the
 *      upstream versions and the alias table used by the native asset router.
 *
 * This script runs in CI only. It never contacts the network and it never writes
 * outside `web/dist`.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectVendor, sha256File, listFiles } from './collect-vendor.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const webRoot = path.join(repoRoot, 'web');
const srcDir = path.join(webRoot, 'src');
const distDir = path.join(webRoot, 'dist');
// esbuild is resolved from web/node_modules so the script also works when it is
// invoked from the repository root rather than through `npm --prefix web`.
const require = createRequire(path.join(webRoot, 'package.json'));
const { build } = require('esbuild');
const nodeModules = path.join(webRoot, 'node_modules');

function fail(message) {
  console.error(`[build-web] ${message}`);
  process.exit(1);
}

if (!existsSync(nodeModules)) {
  fail('web/node_modules is missing; run `npm ci --prefix web` first');
}

console.log('[build-web] cleaning dist');
await rm(distDir, { recursive: true, force: true });
await mkdir(path.join(distDir, 'assets'), { recursive: true });

console.log('[build-web] collecting vendor files');
const vendor = await collectVendor({ nodeModules, distDir });

console.log('[build-web] bundling application code');
const buildResult = await build({
  entryPoints: {
    main: path.join(srcDir, 'main.ts'),
    'document.worker': path.join(srcDir, 'workers/document.worker.ts'),
  },
  outdir: path.join(distDir, 'assets'),
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  assetNames: 'asset-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120', 'es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  // Long-lived WebView targets: keep the output deterministic across machines.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: '/* LiteDoc offline runtime - see THIRD_PARTY_NOTICES.txt */',
  },
});

const warnings = buildResult.warnings ?? [];
if (warnings.length > 0) {
  for (const warning of warnings) {
    console.warn(`[build-web] esbuild: ${warning.text}`);
  }
}

console.log('[build-web] copying shell and styles');
await cp(path.join(srcDir, 'index.html'), path.join(distDir, 'index.html'));
await cp(path.join(srcDir, 'styles/content.css'), path.join(distDir, 'assets/content.css'));
await cp(path.join(srcDir, 'styles/print.css'), path.join(distDir, 'assets/print.css'));

// The shell must reference exactly the files that were produced.
const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
for (const required of ['assets/main.js', 'assets/content.css', 'assets/print.css']) {
  if (!indexHtml.includes(required)) {
    fail(`index.html does not reference ${required}`);
  }
}
if (!existsSync(path.join(distDir, 'assets/document.worker.js'))) {
  fail('the document worker bundle was not produced');
}

console.log('[build-web] writing vendor manifest');
const files = await listFiles(distDir, (file) => !file.endsWith('vendor-manifest.json'));
const { stat: statFile } = await import('node:fs/promises');
const entries = [];
for (const file of files) {
  const stats = await statFile(file);
  entries.push({
    path: path.relative(distDir, file).split(path.sep).join('/'),
    bytes: stats.size,
    sha256: await sha256File(file),
  });
}

const packageJson = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
const versions = {};
for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
  versions[name] = version;
}

const manifest = {
  generatedBy: 'scripts/build-web.mjs',
  schemaVersion: 1,
  node: process.version,
  versions,
  aliases: vendor.aliases,
  totals: {
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  },
  files: entries,
};
await writeFile(
  path.join(distDir, 'vendor-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const totalMiB = manifest.totals.bytes / (1024 * 1024);
console.log(
  `[build-web] done: ${manifest.totals.files} files, ${totalMiB.toFixed(2)} MiB ` +
    `(vendor ${(vendor.bytes / (1024 * 1024)).toFixed(2)} MiB, ${Object.keys(vendor.aliases).length} aliases)`,
);
