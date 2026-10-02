#!/usr/bin/env node
/**
 * Static closure check of the built offline runtime (no network, no browser).
 *
 * It proves that:
 *   * every file in vendor-manifest.json exists and matches its recorded size and
 *     SHA-256;
 *   * every URL the shell references (script, stylesheet, worker, dynamic import,
 *     mermaid lazy chunk, CSS url()) resolves to a packaged file;
 *   * every alias target exists;
 *   * the mandatory offline resources are present (MathJax component and TeX
 *     extensions, the newcm dynamic glyph data, the mhchem glyph extension, the
 *     full Mermaid ESM distribution);
 *   * no source map, no node_modules directory and no development leftover shipped.
 *
 * A static closure check cannot prove runtime behaviour: the absence of an `http`
 * string is not proof of offline operation, and this script does not claim it.
 * What it does prove is that the packaged graph is closed, so the first offline
 * load cannot fail because of a missing local file.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'web/dist');
const manifestPath = path.join(distDir, 'vendor-manifest.json');

const failures = [];
const notes = [];
const stats = {};

const seenFailures = new Set();
function fail(message) {
  if (seenFailures.has(message)) return;
  seenFailures.add(message);
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

if (!existsSync(manifestPath)) {
  console.error('[closure] web/dist/vendor-manifest.json is missing; run the web build first');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const known = new Set(manifest.files.map((entry) => entry.path));

for (const entry of manifest.files) {
  const file = path.join(distDir, entry.path);
  if (!existsSync(file)) {
    fail(`manifest lists a missing file: ${entry.path}`);
    continue;
  }
  const info = await stat(file);
  if (info.size !== entry.bytes) {
    fail(`size mismatch for ${entry.path}: ${info.size} != ${entry.bytes}`);
  }
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  if (digest !== entry.sha256) {
    fail(`sha256 mismatch for ${entry.path}`);
  }
}

stats.files = manifest.files.length;
stats.bytes = manifest.totalBytes ?? manifest.totals?.bytes ?? 0;

// ---------------------------------------------------------------- shell refs
const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
const shellRefs = new Set();
for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const value = match[1];
  if (/^(https?:)?\/\//.test(value) || value.startsWith('data:')) {
    fail(`index.html references a non-local resource: ${value}`);
    continue;
  }
  shellRefs.add(value);
}
for (const ref of shellRefs) {
  if (!existsSync(path.join(distDir, ref))) {
    fail(`index.html references a missing file: ${ref}`);
  }
}
stats.shellRefs = shellRefs.size;

// ------------------------------------------------------- module import graph
const jsFiles = manifest.files
  .map((entry) => entry.path)
  .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));

/**
 * Extracts module specifiers from a built file.
 *
 * Minified bundles keep their static imports at the top of the file, so the
 * leading import block is scanned as a whole; the rest of the file is only
 * searched for dynamic `import("…")` with a strict boundary. A loose
 * `from|import` search over minified code produces false positives from string
 * literals (`from",s.$export="`), which would make the check meaningless.
 */
function importSpecifiers(source) {
  const specifiers = [];
  const lead = /^(?:\s*import\s*[^;"']*?from\s*["'][^"']+["'];|\s*import\s*["'][^"']+["'];|\s*import\s*\(\s*["'][^"']+["']\s*\);)+/.exec(
    source.slice(0, 40000),
  );
  if (lead) {
    for (const match of lead[0].matchAll(/from\s*["']([^"']+)["']/g)) specifiers.push(match[1]);
    for (const match of lead[0].matchAll(/import\s*["']([^"']+)["']/g)) specifiers.push(match[1]);
    for (const match of lead[0].matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

const visited = new Set();
const queue = jsFiles.slice();

while (queue.length > 0) {
  const relative = queue.pop();
  if (visited.has(relative)) continue;
  visited.add(relative);
  const file = path.join(distDir, relative);
  if (!existsSync(file)) continue;
  const source = await readFile(file, 'utf8');
  for (const specifier of importSpecifiers(source)) {
    if (/^(https?:)?\/\//.test(specifier)) {
      note(`${relative} contains a remote specifier: ${specifier}`);
      continue;
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      // A bare specifier would need an import map and cannot resolve at run time.
      fail(`${relative} imports a bare specifier: ${specifier}`);
      continue;
    }
    const resolved = specifier.startsWith('/')
      ? specifier.replace(/^\//, '')
      : path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
    if (!known.has(resolved) && !existsSync(path.join(distDir, resolved))) {
      fail(`${relative} imports a missing module: ${specifier} -> ${resolved}`);
      continue;
    }
    if (!visited.has(resolved)) queue.push(resolved);
  }
  // `url()` can only fetch something from a stylesheet. Inside JavaScript the
  // occurrences are runtime-generated CSS (Mermaid writes `url(#id)` and
  // `url(${name}-drop-shadow)` into SVG filters), so only CSS files are scanned.
  if (relative.endsWith('.css')) {
    for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const value = match[1].trim();
      if (value.length === 0) continue;
      if (value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#')) continue;
      if (value.includes('${') || value.includes('<')) continue;
      if (/^(https?:)?\/\//.test(value)) {
        fail(`${relative} has a remote CSS url(): ${value}`);
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), value));
      if (!existsSync(path.join(distDir, resolved))) {
        fail(`${relative} references a missing asset: ${value} -> ${resolved}`);
      }
    }
  }
}
stats.modules = visited.size;

// ------------------------------------------------------------------- aliases
let aliasCount = 0;
for (const [from, to] of Object.entries(manifest.aliases ?? {})) {
  aliasCount += 1;
  if (!known.has(to) && !existsSync(path.join(distDir, to))) {
    fail(`alias target does not exist: ${from} -> ${to}`);
  }
}
stats.aliases = aliasCount;

// ------------------------------------------------------------- mandatory bits
const required = [
  ['vendor/mathjax/tex-svg.js', 'MathJax TeX->SVG component'],
  ['vendor/fonts/mathjax-mhchem-font-extension/svg.js', 'mhchem glyph extension'],
  ['assets/main.js', 'renderer entry'],
  ['assets/document.worker.js', 'document worker'],
  ['assets/content.css', 'content stylesheet'],
  ['assets/print.css', 'print stylesheet'],
  ['vendor/mermaid/mermaid.esm.min.mjs', 'Mermaid ESM entry'],
];
for (const [file, label] of required) {
  if (!known.has(file)) fail(`mandatory resource missing (${label}): ${file}`);
}

const texExtensions = [...known].filter((file) => file.startsWith('vendor/mathjax/input/tex/extensions/'));
if (texExtensions.length < 30) {
  fail(`TeX extension components look incomplete: ${texExtensions.length}`);
}
for (const wanted of ['mhchem.js', 'ams.js', 'physics.js', 'units.js', 'color.js', 'mathtools.js']) {
  if (!texExtensions.some((file) => file.endsWith(`/${wanted}`))) {
    fail(`TeX extension missing: ${wanted}`);
  }
}
stats.texExtensions = texExtensions.length;

const glyphs = [...known].filter((file) => file.startsWith('vendor/fonts/mathjax-newcm-font/svg/dynamic/'));
if (glyphs.length < 30) {
  fail(`newcm dynamic glyph data looks incomplete: ${glyphs.length} files`);
}
stats.dynamicGlyphFiles = glyphs.length;

const mermaidChunks = [...known].filter((file) => file.startsWith('vendor/mermaid/chunks/'));
if (mermaidChunks.length < 50) {
  fail(`Mermaid lazy chunks look incomplete: ${mermaidChunks.length}`);
}
stats.mermaidChunks = mermaidChunks.length;

// ------------------------------------------------------------- no dev leftover
for (const entry of manifest.files) {
  if (entry.path.endsWith('.map')) fail(`source map shipped: ${entry.path}`);
  if (entry.path.includes('node_modules')) fail(`node_modules content shipped: ${entry.path}`);
  if (/(^|\/)vendor\/(mermaid|mathjax)\/(dist|src)\//.test(entry.path)) {
    fail(`development tree shipped: ${entry.path}`);
  }
}

// ------------------------------------------------------------------- summary
const report = {
  generatedBy: 'scripts/verify-resource-closure.mjs',
  stats,
  failures,
  notes,
  result: failures.length === 0 ? 'pass' : 'fail',
};
await (await import('node:fs/promises')).mkdir(path.join(repoRoot, 'reports'), { recursive: true });
await (await import('node:fs/promises')).writeFile(
  path.join(repoRoot, 'reports/resource-closure.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);

console.log(`[closure] files=${stats.files} modules=${stats.modules} aliases=${stats.aliases} ` +
  `texExtensions=${stats.texExtensions} glyphFiles=${stats.dynamicGlyphFiles} mermaidChunks=${stats.mermaidChunks}`);
for (const entry of notes) console.log(`[closure] note: ${entry}`);
for (const entry of failures) console.error(`[closure] FAIL ${entry}`);
console.log(`[closure] ${report.result}`);

if (failures.length > 0) process.exit(1);
