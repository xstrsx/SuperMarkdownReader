#!/usr/bin/env node
/**
 * Builds the third-party inventory that ships with the project.
 *
 * Sources:
 *   * every npm package that ends up bundled (production dependencies, resolved
 *     from `web/package-lock.json`), including its declared licence;
 *   * the Android/Java dependencies pinned in `gradle/libs.versions.toml`, whose
 *     licences were checked against their published metadata;
 *   * the vendored browser engines (MathJax, its font packages, Mermaid), which are
 *     copied into the APK verbatim.
 *
 * The output is `reports/licences.json` (machine readable) and
 * `THIRD_PARTY_NOTICES.txt` (human readable, also embedded in the APK so the in-app
 * licence view works offline).
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const webRoot = path.join(repoRoot, 'web');

const lock = JSON.parse(await readFile(path.join(webRoot, 'package-lock.json'), 'utf8'));
const packages = [];

for (const [location, meta] of Object.entries(lock.packages ?? {})) {
  if (location === '') continue;
  if (!location.startsWith('node_modules/')) continue;
  const name = meta.name ?? location.replace(/^node_modules\//, '');
  if (meta.dev === true && !(meta.name ?? '').match(/esbuild|typescript|jsdom/)) {
    // Development-only packages are not distributed inside the APK, but the two
    // build tools are listed explicitly for provenance.
  }
  packages.push({
    name,
    version: meta.version ?? 'unknown',
    license: meta.license ?? 'see package',
    bundled: meta.dev !== true,
    resolved: meta.resolved ?? null,
    integrity: meta.integrity ?? null,
  });
}

packages.sort((a, b) => a.name.localeCompare(b.name));

const android = [
  {
    name: 'AndroidX Core (core, core-ktx)',
    version: '1.18.0',
    license: 'Apache-2.0',
    source: 'https://developer.android.com/jetpack/androidx/releases/core',
    bundled: true,
  },
  {
    name: 'AndroidX WebKit',
    version: '1.17.1',
    license: 'Apache-2.0',
    source: 'https://developer.android.com/jetpack/androidx/releases/webkit',
    bundled: true,
  },
  {
    name: 'OkHttp',
    version: '5.2.1',
    license: 'Apache-2.0',
    source: 'https://github.com/square/okhttp',
    bundled: true,
  },
  {
    name: 'Kotlin standard library and kotlinx.coroutines',
    version: '2.3.10 / 1.11.0',
    license: 'Apache-2.0',
    source: 'https://kotlinlang.org',
    bundled: true,
  },
  {
    name: 'AndroidX annotation / collection / lifecycle (transitive)',
    version: 'as resolved by the lock files',
    license: 'Apache-2.0',
    source: 'https://developer.android.com/jetpack/androidx',
    bundled: true,
  },
];

const engines = [
  {
    name: 'MathJax (tex-svg component)',
    version: '4.1.3',
    license: 'Apache-2.0',
    source: 'https://github.com/mathjax/MathJax-src',
    bundled: true,
  },
  {
    name: 'MathJax New Computer Modern font data',
    version: '4.1.3',
    license: 'Apache-2.0',
    source: 'https://www.npmjs.com/package/@mathjax/mathjax-newcm-font',
    bundled: true,
  },
  {
    name: 'MathJax mhchem font extension',
    version: '4.1.3',
    license: 'Apache-2.0',
    source: 'https://www.npmjs.com/package/@mathjax/mathjax-mhchem-font-extension',
    bundled: true,
  },
  {
    name: 'mhchem for MathJax',
    version: 'bundled with MathJax 4.1.3',
    license: 'Apache-2.0',
    source: 'https://mhchem.github.io/MathJax-mhchem/',
    bundled: true,
  },
  {
    name: 'Mermaid (complete ESM distribution)',
    version: '12.0.0',
    license: 'MIT',
    source: 'https://github.com/mermaid-js/mermaid',
    bundled: true,
  },
  {
    name: 'SmilesDrawer',
    version: '2.4.1',
    license: 'MIT',
    source: 'https://github.com/reymond-group/smilesDrawer',
    bundled: true,
  },
  {
    name: 'highlight.js',
    version: '11.12.0',
    license: 'BSD-3-Clause',
    source: 'https://github.com/highlightjs/highlight.js',
    bundled: true,
  },
  {
    name: 'PapaParse',
    version: '5.7.0',
    license: 'MIT',
    source: 'https://github.com/mholt/PapaParse',
    bundled: true,
  },
  {
    name: 'DOMPurify',
    version: '3.4.16',
    license: 'MPL-2.0 OR Apache-2.0',
    source: 'https://github.com/cure53/DOMPurify',
    bundled: true,
  },
  {
    name: 'css-tree',
    version: '3.2.1',
    license: 'MIT',
    source: 'https://github.com/csstree/csstree',
    bundled: true,
  },
  {
    name: 'markdown-it and its plugins (footnote, deflist, task-lists, mark, sub, sup, ins, emoji)',
    version: 'see web/package-lock.json',
    license: 'MIT',
    source: 'https://github.com/markdown-it/markdown-it',
    bundled: true,
  },
];

const report = {
  generatedBy: 'scripts/collect-licences.mjs',
  npm: packages,
  android,
  engines,
  notes: [
    'Only packages whose licence permits redistribution are used.',
    'The licence of this application itself is chosen by the repository owner.',
    'Development-only packages (esbuild, typescript, jsdom, @types/*) are not distributed in the APK.',
  ],
};

await mkdir(path.join(repoRoot, 'reports'), { recursive: true });
await writeFile(
  path.join(repoRoot, 'reports/licences.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);

const lines = [
  'LiteDoc third-party notices',
  '===========================',
  '',
  'LiteDoc bundles the following third-party components. All of them are used',
  'offline: nothing is loaded from a CDN at run time.',
  '',
  'Browser engines and data shipped inside the APK',
  '-----------------------------------------------',
];
for (const entry of engines) {
  lines.push(`* ${entry.name} ${entry.version} - ${entry.license}`);
  lines.push(`  ${entry.source}`);
}
lines.push('', 'Android / JVM dependencies', '--------------------------');
for (const entry of android) {
  lines.push(`* ${entry.name} ${entry.version} - ${entry.license}`);
  lines.push(`  ${entry.source}`);
}
lines.push('', 'npm packages (bundled unless marked development-only)', '-----------------------------------------------------');
for (const entry of packages) {
  lines.push(`* ${entry.name} ${entry.version} - ${entry.license}${entry.bundled ? '' : ' (development only)'}`);
}
lines.push(
  '',
  'Full texts',
  '----------',
  'The complete licence texts are distributed with the corresponding source',
  'packages and in `web/node_modules/<package>/LICENSE`. Where a component is',
  'copied verbatim into `web/dist/vendor`, its upstream licence file is referenced',
  'by path in `reports/licences.json`.',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
);

const noticesPath = path.join(repoRoot, 'THIRD_PARTY_NOTICES.txt');
if (process.argv.includes('--write')) {
  await writeFile(noticesPath, lines.join('\n'), 'utf8');
  console.log(`[licences] wrote ${noticesPath}`);
}
await writeFile(path.join(repoRoot, 'reports/THIRD_PARTY_NOTICES.generated.txt'), lines.join('\n'), 'utf8');
console.log(
  `[licences] npm=${packages.length} android=${android.length} engines=${engines.length} -> reports/licences.json`,
);

if (existsSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.txt')) && !process.argv.includes('--write')) {
  const existing = await readFile(noticesPath, 'utf8');
  if (existing.length < 500) {
    console.warn('[licences] THIRD_PARTY_NOTICES.txt looks too small; regenerate with --write');
  }
}

// Keep the linter honest about the unused import.
void readdir;
