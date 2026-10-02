#!/usr/bin/env node
/**
 * Bootstrap-time fixture generator (run by a maintainer, not by CI).
 *
 * Mermaid fixtures: the registered diagram-type list is read from the *shipped*
 * mermaid distribution (`getRegisteredDiagramsMetadata()`), which is the real
 * registry of the locked version, and each sample is taken from that version's own
 * documentation and then validated with the shipped `detectType()`. A sample that
 * cannot be taken from the docs is synthesised from the shipped detector and marked
 * `synthetic` in diagram-support.json, so nothing is presented as documentation
 * based when it is not.
 *
 * Performance fixtures: generated deterministically from a fixed seed so the
 * committed sizes match the documented manual-verification set.
 *
 * Usage: node scripts/generate-fixtures.mjs [--mermaid] [--performance] [--all]
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const mermaidFixtureDir = path.join(fixturesDir, 'mermaid');
const MERMAID_TAG = 'mermaid@12.0.0';
const DOC_BASE = `https://raw.githubusercontent.com/mermaid-js/mermaid/${MERMAID_TAG}/packages/mermaid/src/docs/syntax`;

const args = process.argv.slice(2);
const doAll = args.includes('--all') || args.length === 0;
const doMermaid = doAll || args.includes('--mermaid');
const doPerformance = doAll || args.includes('--performance');

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.text();
}

async function loadMermaid() {
  const module = await import(
    path.join(repoRoot, 'web/node_modules/mermaid/dist/mermaid.esm.min.mjs')
  );
  const api = module.default;
  api.initialize({ startOnLoad: false, securityLevel: 'strict' });
  return api;
}

function fencedBlocks(markdown) {
  const blocks = [];
  // The documentation source uses `mermaid-example` fences for the diagram
  // source (the rendered copies are injected during the docs build).
  const pattern = /```mermaid(?:-example)?\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/** Doc page that documents each registered diagram type. */
const DOC_PAGE_BY_TYPE = {
  'flowchart-v2': 'flowchart',
  'flowchart-elk': 'flowchart',
  sequence: 'sequenceDiagram',
  classDiagram: 'classDiagram',
  stateDiagram: 'stateDiagram',
  er: 'entityRelationshipDiagram',
  journey: 'userJourney',
  gantt: 'gantt',
  pie: 'pie',
  quadrantChart: 'quadrantChart',
  requirement: 'requirementDiagram',
  gitGraph: 'gitgraph',
  c4: 'c4',
  mindmap: 'mindmap',
  timeline: 'timeline',
  kanban: 'kanban',
  sankey: 'sankey',
  packet: 'packet',
  block: 'block',
  architecture: 'architecture',
  radar: 'radar',
  treemap: 'treemap',
  venn: 'venn',
  ishikawa: 'ishikawa',
  wardley: 'wardley',
  cynefin: 'cynefin',
  railroad: 'railroad',
  railroadAbnf: 'railroad',
  railroadEbnf: 'railroad',
  railroadPeg: 'railroad',
  treeView: 'treeView',
  usecase: 'usecase',
  eventmodeling: 'eventmodeling',
  swimlane: 'swimlanes',
  agentflow: 'agentflow',
  info: 'info',
  error: 'error',
  '---': null,
};

/** Detector-derived minimal samples for types the docs do not show directly. */
const SYNTHETIC = {
  'flowchart-elk': 'flowchart-elk\n  A[开始] --> B[结束]',
  railroadAbnf: 'railroad-abnf\n  rule = "a" "b"',
  railroadEbnf: 'railroad-ebnf\n  rule = "a" , "b" ;',
  railroadPeg: 'railroad-peg\n  rule = "a" "b"',
  error: 'error',
  info: 'info',
  xychart:
    'xychart-beta\n  title "销量"\n  x-axis [一月, 二月, 三月]\n  y-axis "数量" 0 --> 100\n  bar [30, 60, 90]\n  line [40, 70, 80]',
  '---': '---\ntitle: 该输入必须报错\n---',
};

/**
 * Layout engine reachable from each fixture. Mermaid 12 selects ELK through the
 * dedicated `flowchart-elk` diagram type; the dagre layout is the default for the
 * other graph-like types.
 */
const LAYOUTS_BY_TYPE = {
  'flowchart-v2': ['dagre'],
  'flowchart-elk': ['elk'],
  stateDiagram: ['dagre'],
  classDiagram: ['dagre'],
  er: ['dagre'],
  gitGraph: ['dagre'],
};

async function generateMermaid() {
  const api = await loadMermaid();
  const registered = api.getRegisteredDiagramsMetadata().map((entry) => entry.id);
  await mkdir(mermaidFixtureDir, { recursive: true });

  const pageCache = new Map();
  const support = [];
  const errors = [];

  for (const id of registered) {
    const page = DOC_PAGE_BY_TYPE[id] ?? null;
    let sample = null;
    let source = null;

    if (page) {
      if (!pageCache.has(page)) {
        pageCache.set(page, await fetchText(`${DOC_BASE}/${page}.md`));
      }
      const markdown = pageCache.get(page);
      if (markdown) {
        for (const block of fencedBlocks(markdown)) {
          if (block.trim().length === 0) continue;
          try {
            if (api.detectType(block) === id) {
              sample = block;
              source = `${DOC_BASE}/${page}.md`;
              break;
            }
          } catch {
            // Not this type; keep looking.
          }
        }
      }
    }

    if (sample === null && SYNTHETIC[id]) {
      sample = SYNTHETIC[id];
      source = 'synthetic: shipped detector';
    }
    if (sample === null) {
      errors.push(`no sample for registered type '${id}'`);
      continue;
    }

    const relative = `fixtures/mermaid/${id === '---' ? 'front-matter-dashes' : id}.mmd`;
    const fileName = id === '---' ? 'front-matter-dashes' : id;
    await writeFile(path.join(mermaidFixtureDir, `${fileName}.mmd`), `${sample}\n`, 'utf8');
    support.push({
      id,
      fixture: relative,
      layouts: LAYOUTS_BY_TYPE[id] ?? [],
      source,
      negative: id === '---',
      note: id === '---'
        ? 'Front-matter guard: this input must produce a clear parse error, never a silent blank diagram.'
        : null,
    });
    console.log(`[fixtures] mermaid ${id} -> ${relative}`);
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`[fixtures] ${error}`);
    process.exitCode = 1;
  }

  const supportFile = {
    generatedBy: 'scripts/generate-fixtures.mjs',
    engine: 'mermaid',
    engineVersionTag: MERMAID_TAG,
    registrySource:
      'mermaid.getRegisteredDiagramsMetadata() from the shipped dist/mermaid.esm.min.mjs',
    docSource: DOC_BASE,
    registeredTypes: registered,
    fixtureCoverage: support,
  };
  await writeFile(
    path.join(mermaidFixtureDir, 'diagram-support.json'),
    `${JSON.stringify(supportFile, null, 2)}\n`,
    'utf8',
  );
  console.log(`[fixtures] registered mermaid types: ${registered.length}`);
}

/** Trims generated text to a target byte size at the last line break. */
function trimToBytes(text, targetBytes) {
  if (Buffer.byteLength(text) <= targetBytes) return text;
  // Slice by encoded length, not by character count: the fixtures contain CJK
  // text, which is three bytes per character in UTF-8.
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > targetBytes) break;
    index += character.length;
  }
  let cut = text.slice(0, index);
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > cut.length * 0.8) cut = cut.slice(0, lastBreak);
  return `${cut}\n`;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function generatePerformance() {
  const dir = path.join(fixturesDir, 'performance');
  await mkdir(dir, { recursive: true });
  const random = mulberry32(20261002);

  // 1. ~100 KiB plain Markdown
  const plain = [];
  for (let i = 0; plain.join('\n').length < 100 * 1024; i += 1) {
    plain.push(`## 小节 ${i + 1}\n`);
    plain.push(
      '这是用于手动性能观察的段落文本，包含**粗体**、*斜体*、`行内代码` 与[链接](https://example.invalid/doc)。\n',
    );
    plain.push(`- 要点 A${i}\n- 要点 B${i}\n- 要点 C${i}\n`);
  }
  await writeFile(path.join(dir, '100kib.md'), trimToBytes(plain.join('\n'), 100 * 1024), 'utf8');

  // 2. ~1 MiB complex Markdown: tables, code, lists, math and diagrams
  const complex = [];
  let index = 0;
  while (complex.join('\n').length < 1024 * 1024) {
    index += 1;
    complex.push(`# 第 ${index} 章\n`);
    complex.push('| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n');
    complex.push('```js\nfunction f(x) { return x * 2; }\n```\n');
    complex.push(`行内公式 $a_${index}^2 + b^2 = c^2$ 与块公式：\n\n$$\n\\int_0^1 x^{${index}}\\,dx\n$$\n`);
    complex.push('> [!NOTE]\n> 这是一个提醒块。\n');
    complex.push('- [ ] 未完成项\n- [x] 已完成项\n');
  }
  await writeFile(
    path.join(dir, '1mib-complex.md'),
    trimToBytes(complex.join('\n'), 1024 * 1024),
    'utf8',
  );

  // 3. 200 formulas
  const formulas = ['# 200 个公式\n'];
  for (let i = 0; i < 200; i += 1) {
    formulas.push(`$$f_{${i}}(x) = \\sum_{k=0}^{${i}} \\frac{x^k}{k!} + \\sqrt{${i + 1}}$$\n`);
  }
  await writeFile(path.join(dir, 'math-200.md'), formulas.join('\n'), 'utf8');

  // 4. Every registered mermaid type in one document
  const support = JSON.parse(
    await readFile(path.join(mermaidFixtureDir, 'diagram-support.json'), 'utf8'),
  );
  const diagramDoc = ['# 全部内置图表类型\n'];
  const readme = ['# Mermaid 逐类型样例', '', '每个文件对应锁定版本注册表中的一个类型。', ''];
  for (const entry of support.fixtureCoverage) {
    const content = await readFile(path.join(repoRoot, entry.fixture), 'utf8');
    diagramDoc.push(`## ${entry.id}\n\n\`\`\`mermaid\n${content.trim()}\n\`\`\`\n`);
    readme.push(`- \`${entry.fixture}\`${entry.negative ? '（应报错）' : ''}${entry.note ? ` - ${entry.note}` : ''}`);
  }
  await writeFile(path.join(dir, 'mermaid-all-types.md'), diagramDoc.join('\n'), 'utf8');
  await writeFile(path.join(mermaidFixtureDir, 'README.md'), `${readme.join('\n')}\n`, 'utf8');

  // 5. 50 mixed diagrams
  const mixed = ['# 50 个图表\n'];
  const ids = support.fixtureCoverage.filter((entry) => !entry.negative);
  for (let i = 0; i < 50; i += 1) {
    const entry = ids[i % ids.length];
    const content = await readFile(path.join(repoRoot, entry.fixture), 'utf8');
    mixed.push(`## 图表 ${i + 1} (${entry.id})\n\n\`\`\`mermaid\n${content.trim()}\n\`\`\`\n`);
  }
  await writeFile(path.join(dir, 'mermaid-50-mixed.md'), mixed.join('\n'), 'utf8');

  // 6. ~5 MiB SVG with many paths
  const paths = [];
  for (let i = 0; paths.join('').length < 5 * 1024 * 1024; i += 1) {
    const x = Math.round(random() * 1000);
    const y = Math.round(random() * 1000);
    paths.push(`<path d="M${x} ${y} l${(i % 37) + 1} ${(i % 53) + 1} z" fill="hsl(${i % 360}, 60%, 50%)"/>`);
  }
  const body = trimToBytes(paths.join('\n'), 5 * 1024 * 1024 - 200);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">\n${body}</svg>\n`;
  await writeFile(path.join(dir, 'large-5mib.svg'), svg, 'utf8');

  // 7. 100k-row CSV with quoting, embedded newlines and empty cells
  const rows = ['id,name,notes,value,empty'];
  for (let i = 0; i < 100000; i += 1) {
    const notes = i % 997 === 0 ? `"包含引号 "" 与换行的备注\n第 ${i} 行"` : `"备注 ${i}"`;
    rows.push(`${i},"名称 ${i}",${notes},${(i * 37) % 100000},`);
  }
  await writeFile(path.join(dir, 'rows-100k.csv'), rows.join('\n'), 'utf8');

  for (const file of await readdir(dir)) {
    const stats = await readFile(path.join(dir, file));
    console.log(`[fixtures] performance/${file}: ${stats.length} bytes`);
  }
}

if (doMermaid) await generateMermaid();
if (doPerformance) await generatePerformance();
