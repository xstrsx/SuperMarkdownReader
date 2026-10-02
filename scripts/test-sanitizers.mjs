#!/usr/bin/env node
/**
 * Source-level check of the sanitising layer, executed in a real DOM (jsdom).
 *
 * This is the part of the pipeline that decides what may be inserted into the
 * reading document, so it is verified with the committed hostile fixtures rather
 * than by inspection: scripts, event handlers, frames, forms, remote stylesheets,
 * `url()` payloads, DOCTYPE/entity tricks and remote SVG references must all be
 * gone, while the static drawing features documents actually use must survive.
 *
 * The modules under test are bundled once into a temporary ESM file (esbuild, outside
 * the repository) and imported with the jsdom globals installed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(path.join(repoRoot, 'web/package.json'));
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');

const failures = [];
const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition), detail: detail || '' });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>', {
  url: 'https://appassets.androidplatform.net/assets/web/index.html',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Blob = dom.window.Blob;
globalThis.URL = dom.window.URL;

const workDir = await mkdtemp(path.join(tmpdir(), 'litedoc-sanitizers-'));
const entry = path.join(workDir, 'entry.ts');
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(path.join(repoRoot, 'web/src/security/sanitize.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'web/src/security/css.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'web/src/security/svg.ts'))};`,
    '',
  ].join('\n'),
  'utf8',
);
const outFile = path.join(workDir, 'sanitizers.mjs');
await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  logLevel: 'error',
});

console.log('[sanitizer-check] bundled modules, running checks');
const sanitizers = await import(outFile);
const { sanitizeFragment, sanitizeInlineStyle, sanitizeHtmlDocument, sanitizeSvg } = sanitizers;

// ---------------------------------------------------------------- CSS sanitiser
{
  check('keeps allowed declarations', sanitizeInlineStyle('color: red; font-size: 14px') === 'color: red; font-size: 14px');
  check('drops position/inset/z-index', sanitizeInlineStyle('position: fixed; inset: 0; z-index: 9') === '');
  check('drops url() values', sanitizeInlineStyle('background: url("https://example.invalid/x.png")') === '');
  check('drops @import', sanitizeInlineStyle('@import url("https://example.invalid/x.css");') === '');
  check('drops expression()', sanitizeInlineStyle('width: expression(alert(1))') === '');
  check('drops unknown properties', sanitizeInlineStyle('behavior: url(#default#time2)') === '');
  check('keeps svg painting properties', sanitizeInlineStyle('fill: #fff; stroke-width: 2') === 'fill: #fff; stroke-width: 2');
  check('drops css escapes', sanitizeInlineStyle('content: "\\75 rl(https://example.invalid)"') === '');
}

// ------------------------------------------------------------ fragment sanitiser
{
  const source = await readFile(path.join(repoRoot, 'fixtures/security/injection.md'), 'utf8');
  const engine = await import(
    (await bundleOnce('engine', path.join(repoRoot, 'web/src/markdown/engine.ts'), workDir)).outFile
  );
  const md = engine.createMarkdown();
  const parsed = engine.parseDocument(md, source);
  const raw = parsed.blocks.join('\n');
  const clean = sanitizeFragment(raw);

  check('raw parse still contains hostile markup', /<script/i.test(raw) || /onerror/i.test(raw));
  check('no script element survives', !/<script/i.test(clean));
  check('no event attribute survives', !/\son[a-z]+\s*=/i.test(clean));
  check('no iframe/object/embed survives', !/<(iframe|object|embed)/i.test(clean));
  check('no form survives', !/<form/i.test(clean));
  check('no meta refresh survives', !/<meta/i.test(clean));
  check('no base element survives', !/<base/i.test(clean));
  check('no style element survives', !/<style/i.test(clean));
  check('no inline svg survives', !/<svg/i.test(clean));
  check('javascript: link is not an href', !/href\s*=\s*["']javascript:/i.test(clean));
  check(
    'external link became copy-only',
    clean.includes('data-ld-href="https://example.invalid/ok"') && !/<a[^>]*\shref=/i.test(clean),
  );
  check('images are queued for resource resolution', clean.includes('data-ld-ref='));
  check('inline overlay style was stripped', !clean.includes('position:fixed') && !clean.includes('position: fixed'));

  const host = document.getElementById('host');
  host.innerHTML = clean;
  const overlay = host.querySelector('div[style*="9999"]');
  check('no element keeps a full-screen overlay style', overlay === null);
  const figure = Array.from(host.querySelectorAll('div')).find((element) => (element.getAttribute('style') ?? '').includes('margin'));
  check('safe inline style kept', figure !== undefined && (figure.getAttribute('style') ?? '').includes('color'));
}

// ---------------------------------------------------------- HTML document sanitiser
{
  const source = await readFile(path.join(repoRoot, 'fixtures/security/injection.html'), 'utf8');
  const result = sanitizeHtmlDocument(source);
  check('html: script removed', !/<script/i.test(result.html));
  check('html: iframe removed', !/<iframe/i.test(result.html));
  check('html: form removed', !/<form/i.test(result.html));
  check('html: remote stylesheet removed', !/<link/i.test(result.html));
  check('html: title extracted', result.title === '受限静态 HTML 样例', result.title ?? 'null');
  check('html: in-page anchor kept', result.html.includes('href="#section"'));
  check('html: overlay class removed or neutralised', !/position:\s*fixed/i.test(result.html));
  check('html: safe content kept', result.html.includes('受控的内联样式与段落应保留'));
  check('html: local image queued', result.html.includes('data-ld-ref="./local-image.png"'));
}

// --------------------------------------------------------------------- SVG
{
  const hostile = await readFile(path.join(repoRoot, 'fixtures/security/svg-hostile.svg'), 'utf8');
  const rejected = sanitizeSvg(hostile);
  check('svg: DOCTYPE/entity file rejected', rejected.ok === false && rejected.reason === 'doctype-or-entity', rejected.reason ?? '');

  const features = await readFile(path.join(repoRoot, 'fixtures/svg/features.svg'), 'utf8');
  const ok = sanitizeSvg(features);
  check('svg: static features accepted', ok.ok === true, ok.reason ?? '');
  if (ok.ok && ok.svg) {
    check('svg: no script', !/<script/i.test(ok.svg));
    check('svg: no event attributes', !/\son[a-z]+\s*=/i.test(ok.svg));
    check('svg: no animate', !/<animate/i.test(ok.svg));
    check('svg: no remote reference', !/https?:\/\/example\.invalid/i.test(ok.svg));
    check('svg: gradient kept', ok.svg.includes('linearGradient'));
    check('svg: mask kept', ok.svg.includes('<mask'));
    check('svg: clipPath kept', ok.svg.includes('clipPath'));
    check('svg: filter kept', ok.svg.includes('<filter'));
    check('svg: local use kept', /xlink:href="#reusable"|href="#reusable"/.test(ok.svg));
    check('svg: static style kept', ok.svg.includes('class="label"') || ok.svg.includes('.label'));
    check('svg: foreignObject kept as static content', ok.svg.includes('foreignObject'));
  }

  const drawio = await readFile(path.join(repoRoot, 'fixtures/svg/diagramsnet-style.svg'), 'utf8');
  const drawioResult = sanitizeSvg(drawio);
  check('svg: diagrams.net style accepted', drawioResult.ok === true, drawioResult.reason ?? '');
  if (drawioResult.ok && drawioResult.svg) {
    check('svg: diagrams.net labels kept', drawioResult.svg.includes('起点节点'));
    check('svg: diagrams.net styles have no external reference', !/url\s*\(/i.test(drawioResult.svg));
    check('svg: diagrams.net shapes kept', drawioResult.svg.includes('<rect'));
  }

  const inlineScript = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10" onclick="alert(2)"/></svg>';
  const inlineResult = sanitizeSvg(inlineScript);
  check('svg: inline script removed', inlineResult.ok === true && !/<script/i.test(inlineResult.svg ?? ''));
  check('svg: inline handler removed', !/onclick/i.test(inlineResult.svg ?? ''));

  const styleUrl = '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url("http://example.invalid/x.svg#g")}</style><rect width="10" height="10"/></svg>';
  const styleResult = sanitizeSvg(styleUrl);
  check('svg: stylesheet with url() removed', styleResult.ok === true && !/example\.invalid/.test(styleResult.svg ?? ''));

  // Complexity guards are exercised with deeply nested groups (cheap to build) and
  // with a path-heavy drawing, both of which must be refused instead of rendered.
  const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(80)}<rect width="1" height="1"/>${'</g>'.repeat(80)}</svg>`;
  const deepResult = sanitizeSvg(deep);
  check('svg: depth limit enforced', deepResult.ok === false && deepResult.reason === 'too-deep', deepResult.reason ?? '');

  const manyPaths = `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0h1v1z"/>'.repeat(20001)}</svg>`;
  const manyPathsResult = sanitizeSvg(manyPaths);
  check('svg: path limit enforced', manyPathsResult.ok === false && manyPathsResult.reason === 'too-many-paths', manyPathsResult.reason ?? '');
}

async function bundleOnce(name, entryFile, dir) {
  const entryPath = path.join(dir, `${name}-entry.ts`);
  await writeFile(entryPath, `export * from ${JSON.stringify(entryFile)};\n`, 'utf8');
  const outFile = path.join(dir, `${name}.mjs`);
  await build({
    entryPoints: [entryPath],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    logLevel: 'error',
  });
  return { outFile };
}

await rm(workDir, { recursive: true, force: true });

const passed = checks.filter((entry) => entry.pass).length;
console.log(`[sanitizer-check] ${passed}/${checks.length} checks passed`);
for (const entry of checks) {
  if (!entry.pass) console.error(`[sanitizer-check] FAIL ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
}
await mkdir(path.join(repoRoot, 'reports'), { recursive: true });
await writeFile(
  path.join(repoRoot, 'reports/sanitizer-check.json'),
  `${JSON.stringify({ generatedBy: 'scripts/test-sanitizers.mjs', passed, total: checks.length, checks }, null, 2)}\n`,
  'utf8',
);
if (failures.length > 0) process.exit(1);
