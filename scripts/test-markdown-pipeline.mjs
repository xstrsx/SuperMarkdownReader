#!/usr/bin/env node
/**
 * Source-level check of the Markdown pipeline.
 *
 * The engine is TypeScript; this script bundles it once into a temporary ESM module
 * (with esbuild, outside the repository) and then exercises it in Node against the
 * committed fixtures. Nothing here is a substitute for on-device rendering: it
 * verifies the parser rules that are easy to get wrong and that the plan calls out
 * explicitly (dollar signs in code, prices, code fences, footnote definitions,
 * heading anchors, block splitting, callout markup and the size limits).
 */
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
// esbuild is resolved from web/node_modules so the check also works when it is
// invoked from the repository root.
const require = createRequire(path.join(repoRoot, 'web/package.json'));
const { build } = require('esbuild');

const failures = [];
const checks = [];

function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const workDir = await mkdtemp(path.join(tmpdir(), 'litedoc-mdcheck-'));
const entry = path.join(workDir, 'entry.mjs');
await writeFile(
  entry,
  `export { createMarkdown, parseDocument, slugify } from ${JSON.stringify(
    path.join(repoRoot, 'web/src/markdown/engine.ts'),
  )};\n`,
  'utf8',
);
const outFile = path.join(workDir, 'engine.mjs');
await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'error',
});

const engine = await import(outFile);
const md = engine.createMarkdown();

function render(source) {
  return engine.parseDocument(md, source);
}

// 1. Dollar signs inside code must never become math.
{
  const result = render('`$a$`\n\n```text\n$b$\n```\n');
  const html = result.blocks.join('');
  check('inline code dollars stay literal', html.includes('$a$') && !html.includes('ld-math'));
  check('fenced dollars stay literal', html.includes('$b$'));
}

// 2. Prices stay literal.
{
  const result = render('单价 $5 元，总价 $10 元。\n');
  const html = result.blocks.join('');
  check('prices are not math', !html.includes('ld-math'), html.slice(0, 120));
}

// 3. Real math is parsed, with the escaped delimiters preserved for MathJax.
{
  const result = render('行内 $a^2+b^2=c^2$ 与 \\(x\\) 与\n\n$$\n\\int_0^1 x\\,dx\n$$\n');
  const html = result.blocks.join('');
  check('inline math produced', html.includes('ld-math') && html.includes('\\(a^2+b^2=c^2\\)'));
  check('paren math produced', html.includes('\\(x\\)'));
  check('display math produced', html.includes('ld-math-display') && html.includes('\\['));
}

// 4. Escaped dollars are not math.
{
  const result = render('\\$99 与 \\$100\n');
  const html = result.blocks.join('');
  check('escaped dollars are literal', !html.includes('ld-math'), html.slice(0, 160));
}

// 5. GitHub alerts and Obsidian callouts.
{
  const result = render('> [!NOTE]\n> 内容\n\n> [!tip]- 折叠标题\n> 折叠内容\n\n> [!whatever] 未知\n> 内容\n');
  const html = result.blocks.join('');
  check('alert class emitted', html.includes('ld-alert-note'));
  check('collapsible callout emitted', html.includes('<details') && html.includes('ld-alert-tip'));
  check('unknown callout degrades to a blockquote-like alert', html.includes('ld-alert-quote'));
}

// 6. Front matter is captured and rendered as collapsed metadata.
{
  const result = render('---\ntitle: 示例\ntags:\n  - a\n---\n\n# 标题\n');
  const html = result.blocks.join('');
  check('front matter captured', typeof result.frontMatter === 'string' && result.frontMatter.includes('title'));
  check('front matter rendered collapsed', html.includes('ld-frontmatter') && html.includes('<details'));
  check('front matter is not parsed as content', !html.includes('<h2>title'));
}

// 7. Heading ids: Chinese, duplicates and inline markup.
{
  const result = render('# 中文标题\n\n## 中文标题\n\n## 中文标题\n\n## `代码` 与 **粗体**\n');
  const ids = result.headings.map((heading) => heading.id);
  check('heading ids are stable and unique', new Set(ids).size === ids.length, ids.join(','));
  check('chinese heading keeps a readable slug', ids[0] === '中文标题', ids[0]);
  check('duplicate headings get a suffix', ids[1] === '中文标题-1', ids[1]);
  check('inline markup stripped from the slug', !ids[3].includes('`') && !ids[3].includes('*'), ids[3]);
}

// 8. Block splitting keeps structures intact.
{
  const result = render('- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n');
  const joined = result.blocks.join('');
  check('list is one block', result.blocks.filter((block) => block.includes('<li>')).length === 1);
  check('table is one block', result.blocks.filter((block) => block.includes('<table>')).length === 1);
  check('fence is one block', result.blocks.filter((block) => block.includes('language-js')).length === 1);
  check('block count is small', result.blocks.length <= 6, String(result.blocks.length));
  check('joined output keeps the list', joined.includes('<li>a</li>'));
}

// 9. Reference definitions at the end of the file still resolve.
{
  const result = render('使用 [引用][ref] 与脚注[^n]。\n\n[ref]: https://example.invalid/x\n[^n]: 脚注内容\n');
  const html = result.blocks.join('');
  check('reference link resolved', html.includes('example.invalid/x'));
  check('footnote section rendered', html.includes('footnotes') || html.includes('fn1'));
}

// 10. Special fences become LiteDoc blocks with an index.
{
  const result = render('```mermaid\ngraph TD\nA-->B\n```\n\n```csv\na,b\n1,2\n```\n\n```smiles\nCCO 乙醇\n```\n');
  const html = result.blocks.join('');
  check('mermaid block emitted', html.includes('data-ld-kind="mermaid"') && html.includes('data-ld-index="0"'));
  check('csv block emitted', html.includes('data-ld-kind="csv"'));
  check('smiles block emitted', html.includes('data-ld-kind="smiles"'));
  check('mermaid feature counted', result.features.mermaid === 1, String(result.features.mermaid));
}

// 11. Unknown languages are reported, not auto-detected.
{
  const result = render('```notareallanguage\nx\n```\n');
  check('unknown language reported', result.features.unknownLanguages.includes('notareallanguage'));
  const html = result.blocks.join('');
  check('unknown language is not marked for highlighting', !html.includes('data-ld-code="notareallanguage"'));
}

// 12. TOC marker and emoji shortcodes.
{
  const result = render('[TOC]\n\n# 一\n\n:smile: :rocket: :not_a_shortcode:\n');
  const html = result.blocks.join('');
  check('toc marker rendered', html.includes('data-ld-toc'));
  check('toc marker recorded', result.features.hasTocMarker === true);
  check('known emoji converted', html.includes('😄'));
  check('unknown shortcode preserved', html.includes(':not_a_shortcode:'));
}

// 13. Size limits: an oversized mermaid block falls back to source.
{
  const huge = '```mermaid\ngraph TD\n' + 'A-->B\n'.repeat(30000) + '```\n';
  const result = render(huge);
  const html = result.blocks.join('');
  check('oversized mermaid keeps the source', html.includes('ld-block-source') && html.includes('超过该类型的处理上限'));
}

// 14. Committed fixtures parse without throwing and produce blocks.
for (const fixture of ['fixtures/markdown/extensions.md', 'fixtures/markdown/edge-cases.md', 'fixtures/math/expressions.md', 'fixtures/security/injection.md']) {
  const source = await readFile(path.join(repoRoot, fixture), 'utf8');
  try {
    const result = render(source);
    check(`fixture parses: ${fixture}`, result.blocks.length > 0, `${result.blocks.length} blocks`);
  } catch (error) {
    check(`fixture parses: ${fixture}`, false, error.message);
  }
}

// 15. The parser output is untrusted input for the sanitiser: it is verified to
//     still contain the hostile constructs, so removing them is the sanitiser's
//     responsibility (see scripts/test-sanitizers.mjs, which runs in a real DOM).
{
  const source = await readFile(path.join(repoRoot, 'fixtures/security/injection.md'), 'utf8');
  const html = engine.parseDocument(md, source).blocks.join('');
  check(
    'hostile markup reaches the sanitiser boundary',
    /<script/i.test(html) || /onerror/i.test(html),
    'fixture must exercise the sanitiser',
  );
}

await rm(workDir, { recursive: true, force: true });

const passed = checks.filter((entry) => entry.pass).length;
console.log(`[markdown-check] ${passed}/${checks.length} checks passed`);
for (const entry of checks) {
  if (!entry.pass) console.error(`[markdown-check] FAIL ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
}

const { mkdir } = await import('node:fs/promises');
await mkdir(path.join(repoRoot, 'reports'), { recursive: true });
await writeFile(
  path.join(repoRoot, 'reports/markdown-pipeline.json'),
  `${JSON.stringify({ generatedBy: 'scripts/test-markdown-pipeline.mjs', passed, total: checks.length, checks }, null, 2)}\n`,
  'utf8',
);

if (failures.length > 0) process.exit(1);
