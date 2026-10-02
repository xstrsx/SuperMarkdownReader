import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import taskLists from 'markdown-it-task-lists';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import ins from 'markdown-it-ins';
import { full as emojiFull } from 'markdown-it-emoji';
import type { Env, Token } from 'markdown-it';
import { LIMITS } from '../security/limits';

/**
 * The Markdown pipeline.
 *
 * Rules that matter for correctness:
 * * math delimiters are parsed by dedicated block/inline rules, so `$` inside
 *   code spans, code fences, autolinks and link destinations is never touched;
 * * every top-level token group is rendered as one complete block, which is what
 *   lets the main thread insert whole syntax blocks in batches without splitting a
 *   list, a table or a fenced code block;
 * * GFM alerts and Obsidian-style callouts share one block rule; unknown types
 *   degrade to a plain blockquote;
 * * headings get stable, duplicate-safe ids so TOC, footnote back links and
 *   in-page anchors keep working with Chinese titles.
 *
 * markdown-it's own rule APIs are loosely typed; the rule bodies below use
 * explicit `any` for the parser state, which is deliberate and contained.
 */

export interface HeadingEntry {
  level: number;
  id: string;
  text: string;
}

export interface FeatureSet {
  math: number;
  mermaid: number;
  smiles: number;
  csv: number;
  tsv: number;
  details: number;
  callouts: number;
  footnotes: number;
  frontMatter: boolean;
  hasTocMarker: boolean;
  unknownLanguages: string[];
}

export interface ParseResult {
  blocks: string[];
  headings: HeadingEntry[];
  features: FeatureSet;
  frontMatter: string | null;
  truncated: boolean;
}

const ALERT_TYPES = new Set([
  'note', 'tip', 'important', 'warning', 'caution',
  'info', 'todo', 'abstract', 'summary', 'tldr', 'hint', 'success', 'check', 'done',
  'question', 'help', 'faq', 'attention', 'failure', 'fail', 'missing', 'danger',
  'error', 'bug', 'example', 'quote', 'cite',
]);

const GITHUB_ALERT_TITLES: Record<string, string> = {
  note: 'NOTE',
  tip: 'TIP',
  important: 'IMPORTANT',
  warning: 'WARNING',
  caution: 'CAUTION',
};

const BLOCK_LANGUAGES: Record<string, string> = {
  mermaid: 'mermaid',
  mmd: 'mermaid',
  smiles: 'smiles',
  smi: 'smiles',
  csv: 'csv',
  tsv: 'tsv',
  chem: 'math-chem',
  mhchem: 'math-chem',
};

const KNOWN_FENCE_LANGUAGES = new Set([
  'text', 'plain', 'txt', 'markdown', 'md', 'json', 'yaml', 'yml', 'toml', 'ini',
  'xml', 'html', 'css', 'scss', 'less', 'javascript', 'js', 'mjs', 'cjs', 'jsx',
  'typescript', 'ts', 'tsx', 'python', 'py', 'java', 'kotlin', 'kt', 'kts', 'scala',
  'groovy', 'gradle', 'c', 'cpp', 'c++', 'cc', 'h', 'hpp', 'cs', 'go', 'rust', 'rs',
  'ruby', 'rb', 'php', 'perl', 'pl', 'swift', 'objectivec', 'objc', 'shell', 'sh',
  'bash', 'zsh', 'powershell', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'proto',
  'diff', 'patch', 'makefile', 'dockerfile', 'nginx', 'ini', 'lua', 'r', 'dart',
  'elixir', 'erlang', 'haskell', 'clojure', 'vim', 'tex', 'latex',
]);

/** The instance type of the MarkdownIt constructor (the default export is a value). */
export type MarkdownEngine = InstanceType<typeof MarkdownIt>;

export function createMarkdown(): MarkdownEngine {
  const md = new MarkdownIt({
    html: true,
    linkify: false,
    breaks: false,
    typographer: false,
    xhtmlOut: false,
  });

  md.use(footnote);
  md.use(deflist);
  md.use(taskLists, { enabled: true, label: true, labelAfter: true });
  md.use(mark);
  md.use(sub);
  md.use(sup);
  md.use(ins);
  md.use(emojiFull);

  installFrontMatter(md);
  installAlerts(md);
  installTocMarker(md);
  installMath(md);
  installHeadingIds(md);
  installRenderers(md);

  return md;
}

// --------------------------------------------------------------------- helpers

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(text: string): string {
  const base = text
    .replace(/\u200B/g, '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    // Keep letters (including CJK), digits, hyphen and underscore; drop the rest.
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base.slice(0, 128) : 'section';
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// ------------------------------------------------------------------ front matter

function installFrontMatter(md: MarkdownEngine): void {
  md.block.ruler.before('table', 'ld_frontmatter', (state: any, startLine: number, _endLine: number, silent: boolean) => {
    if (startLine !== 0) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const marker = state.src.slice(start, start + 3);
    if (marker !== '---') return false;
    const endOfFirst = state.eMarks[startLine];
    if (state.src.slice(start, endOfFirst).trim() !== '---') return false;

    let line = startLine + 1;
    let end = -1;
    while (line < state.lineMax) {
      const lineStart = state.bMarks[line] + state.tShift[line];
      const lineEnd = state.eMarks[line];
      const text = state.src.slice(lineStart, lineEnd).trim();
      if (text === '---' || text === '...') {
        end = line;
        break;
      }
      line += 1;
    }
    if (end < 0) return false;
    if (silent) return true;

    const contentStart = state.bMarks[startLine] + state.tShift[startLine];
    const contentEnd = state.eMarks[end];
    const raw = state.src.slice(contentStart, contentEnd);
    state.line = end + 1;

    const token = state.push('ld_frontmatter', '', 0);
    token.content = raw.length > LIMITS.frontMatterMax ? raw.slice(0, LIMITS.frontMatterMax) : raw;
    token.meta = { truncated: raw.length > LIMITS.frontMatterMax };
    token.map = [startLine, end + 1];
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote'] });
}

// ------------------------------------------------------------------- callouts

function installAlerts(md: MarkdownEngine): void {
  const marker = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

  md.block.ruler.before(
    'blockquote',
    'ld_alert',
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      if (state.src.charCodeAt(start) !== 0x3e /* > */) return false;
      const firstEnd = state.eMarks[startLine];
      const firstLine = state.src.slice(start + 1, firstEnd).trim();
      const match = marker.exec(firstLine);
      if (!match) return false;
      if (silent) return true;

      const rawType = (match[1] ?? '').toLowerCase();
      const type = ALERT_TYPES.has(rawType) ? rawType : 'quote';
      const known = ALERT_TYPES.has(rawType);
      const collapsible = (match[2] ?? '').length > 0;
      const collapsed = match[2] === '-';
      const explicitTitle = (match[3] ?? '').trim();

      const lines: string[] = [];
      let line = startLine;
      while (line < endLine) {
        const lineStart = state.bMarks[line] + state.tShift[line];
        const lineEnd = state.eMarks[line];
        const raw = state.src.slice(lineStart, lineEnd);
        if (line === startLine) {
          const rest = raw.trim().slice(1);
          const afterMarker = rest.replace(marker, '').trim();
          if (afterMarker.length > 0 && explicitTitle.length === 0) {
            // Marker and body on the same line.
            lines.push(`> ${afterMarker}`);
          } else {
            lines.push('>');
          }
        } else if (/^\s*>/.test(raw)) {
          lines.push(raw.replace(/^\s*> ?/, '> '));
        } else if (raw.trim().length === 0) {
          break;
        } else {
          // Lazy continuation inside the callout.
          lines.push(`> ${raw}`);
        }
        line += 1;
      }

      const inner = lines.join('\n').replace(/^> ?/gm, '');
      const open = state.push('ld_alert_open', 'div', 1);
      open.attrSet('class', `ld-alert ld-alert-${type}`);
      open.meta = {
        type,
        known,
        collapsible,
        collapsed,
        title: explicitTitle.length > 0
          ? explicitTitle
          : (GITHUB_ALERT_TITLES[type] ?? capitalise(type)),
      };

      // The callout body is tokenised as a real child block, so nested lists,
      // code fences, tables and further callouts keep working.
      const childState = new state.md.block.State(inner, state.md, state.env, state.tokens);
      childState.md.block.tokenize(childState, 0, childState.lineMax);

      const close = state.push('ld_alert_close', 'div', -1);
      close.meta = open.meta;
      state.line = line;

      if (known) {
        state.env.ldFeatures = state.env.ldFeatures ?? {};
        state.env.ldFeatures.callouts = (state.env.ldFeatures.callouts ?? 0) + 1;
      }
      return true;
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  );
}

function capitalise(value: string): string {
  if (value.length === 0) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ------------------------------------------------------------------- [TOC]

function installTocMarker(md: MarkdownEngine): void {
  md.block.ruler.before('paragraph', 'ld_toc', (state: any, startLine: number, _endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const end = state.eMarks[startLine];
    const text = state.src.slice(start, end).trim().toLowerCase();
    if (text !== '[toc]' && text !== '[[toc]]' && text !== '[toc]{}') return false;
    if (silent) return true;
    const token = state.push('ld_toc', '', 0);
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    state.env.ldFeatures = state.env.ldFeatures ?? {};
    state.env.ldFeatures.hasTocMarker = true;
    return true;
  });
}

// ------------------------------------------------------------------- math

function installMath(md: MarkdownEngine): void {
  // Block: $$...$$ and \[...\]
  md.block.ruler.before(
    'fence',
    'ld_math_block',
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const end = state.eMarks[startLine];
      const line = state.src.slice(start, end);
      let open = '';
      let close = '';
      if (line.startsWith('$$')) {
        open = '$$';
        close = '$$';
      } else if (line.startsWith('\\[')) {
        open = '\\[';
        close = '\\]';
      } else {
        return false;
      }
      if (silent) return true;

      const body: string[] = [];
      const rest = line.slice(open.length);
      const sameLineClose = rest.indexOf(close);
      if (sameLineClose >= 0 && rest.slice(0, sameLineClose).trim().length > 0) {
        body.push(rest.slice(0, sameLineClose));
        state.line = startLine + 1;
      } else {
        if (rest.trim().length > 0) body.push(rest);
        let current = startLine + 1;
        let closed = false;
        while (current < endLine) {
          const lineStart = state.bMarks[current] + state.tShift[current];
          const lineEnd = state.eMarks[current];
          const text = state.src.slice(lineStart, lineEnd);
          const index = text.indexOf(close);
          if (index >= 0) {
            body.push(text.slice(0, index));
            closed = true;
            current += 1;
            break;
          }
          body.push(text);
          current += 1;
        }
        if (!closed) return false;
        state.line = current;
      }

      const content = body.join('\n');
      const token = state.push('ld_math_block', '', 0);
      token.content = content.length > LIMITS.mathMaxSource ? content.slice(0, LIMITS.mathMaxSource) : content;
      token.meta = { truncated: content.length > LIMITS.mathMaxSource };
      token.map = [startLine, state.line];
      return true;
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  );

  // Inline: $...$ and \(...\)
  md.inline.ruler.before('escape', 'ld_math_inline', (state: any, silent: boolean) => {
    const src: string = state.src;
    const pos: number = state.pos;
    const marker = src[pos];
    let close = '';
    let openLength = 0;
    if (marker === '$') {
      const next = src[pos + 1];
      // An opening `$` must be followed by a non-space character.
      if (next === undefined || /\s/.test(next)) return false;
      // An escaped `\$` is left to the escape rule.
      if (pos > 0 && src[pos - 1] === '\\') return false;
      close = '$';
      openLength = 1;
    } else if (marker === '\\' && src[pos + 1] === '(') {
      close = '\\)';
      openLength = 2;
    } else {
      return false;
    }

    let index = pos + openLength;
    let content = '';
    let found = false;
    while (index < src.length) {
      const char = src[index]!;
      if (char === '\\' && close === '$') {
        content += char + (src[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (close === '$' && char === '$') {
        // `$1$2` style prices and a closing `$` after a space are not math.
        if (/\d/.test(src[index + 1] ?? '')) {
          content += char;
          index += 1;
          continue;
        }
        if (/\s/.test(src[index - 1] ?? '')) {
          content += char;
          index += 1;
          continue;
        }
        found = true;
        break;
      }
      if (close === '\\)' && char === '\\' && src[index + 1] === ')') {
        found = true;
        break;
      }
      if (char === '\n') return false;
      content += char;
      index += 1;
    }
    if (!found || content.trim().length === 0) return false;

    if (!silent) {
      const token = state.push('ld_math_inline', '', 0);
      token.content =
        content.length > LIMITS.mathMaxSource ? content.slice(0, LIMITS.mathMaxSource) : content;
      token.meta = { truncated: content.length > LIMITS.mathMaxSource };
    }
    state.pos = index + close.length;
    return true;
  });
}

// ------------------------------------------------------------------- headings

function installHeadingIds(md: MarkdownEngine): void {
  md.core.ruler.push('ld_heading_ids', (state: any) => {
    const used = new Map<string, number>();
    const headings: HeadingEntry[] = [];
    const tokens = state.tokens as any[];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      const raw = (inline?.content as string) ?? '';
      const text = stripInlineMarkup(raw);
      const base = slugify(text);
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count}`;
      token.attrSet('id', id);
      const level = Number.parseInt(token.tag.slice(1), 10);
      headings.push({ level, id, text });
    }
    state.env.ldHeadings = headings;
    state.env.ldFeatures = state.env.ldFeatures ?? {};
    state.env.ldFeatures.headings = headings.length;
  });
}

// ------------------------------------------------------------------ renderers

function installRenderers(md: MarkdownEngine): void {
  const escape = escapeHtml;

  md.renderer.rules.ld_math_block = (tokens: Token[], index: number): string => {
    const token = tokens[index]!;
    const content = token.content;
    if (token.meta?.truncated) {
      return `<div class="ld-math-display ld-math-error"><pre class="ld-block-source">${escape(content)}</pre><p>公式超过单条上限，已按源码显示。</p></div>`;
    }
    return `<div class="ld-math-display">\\[${escape(content)}\\]</div>`;
  };

  md.renderer.rules.ld_math_inline = (tokens: Token[], index: number): string => {
    const token = tokens[index]!;
    const content = token.content;
    if (token.meta?.truncated) {
      return `<code class="ld-math-error">${escape(content)}</code>`;
    }
    return `<span class="ld-math">\\(${escape(content)}\\)</span>`;
  };

  md.renderer.rules.ld_toc = (): string => '<nav class="ld-toc-inline" data-ld-toc></nav>';

  md.renderer.rules.ld_frontmatter = (tokens: Token[], index: number): string => {
    const token = tokens[index]!;
    const body = renderFrontMatter(token.content);
    return `<details class="ld-frontmatter"><summary>YAML front matter</summary>${body}</details>`;
  };

  md.renderer.rules.ld_alert_open = (tokens: Token[], index: number): string => {
    const meta = tokens[index]!.meta ?? {};
    const classes = `ld-alert ld-alert-${meta.type}`;
    const title = `<div class="ld-alert-title">${escape(String(meta.title ?? ''))}</div>`;
    if (meta.collapsible) {
      return `<details class="${classes}"${meta.collapsed ? '' : ' open'}><summary class="ld-alert-title">${escape(String(meta.title ?? ''))}</summary>`;
    }
    return `<div class="${classes}">${title}`;
  };

  md.renderer.rules.ld_alert_close = (tokens: Token[], index: number): string => {
    const meta = tokens[index]!.meta ?? {};
    return meta.collapsible ? '</details>' : '</div>';
  };

  md.renderer.rules.fence = (tokens: Token[], index: number, _options: unknown, env: Env | undefined): string => {
    const token = tokens[index]!;
    const info = token.info ? token.info.trim() : '';
    const language = info.split(/\s+/)[0]?.toLowerCase() ?? '';
    const source = token.content;

    const blockKind = BLOCK_LANGUAGES[language];
    if (blockKind === 'math-chem') {
      // `chem` / `mhchem` fences are chemistry in display math form: they go through
      // the same MathJax + mhchem path as `$$\ce{...}$$`.
      const features = featureState(env);
      features.math = ((features.math as number) ?? 0) + 1;
      const overLimit = source.length > LIMITS.mathMaxSource;
      return overLimit
        ? `<div class="ld-math-display ld-math-error"><pre class="ld-block-source">${escape(source)}</pre><p>公式超过单条上限，已按源码显示。</p></div>`
        : `<div class="ld-math-display">\\[\\ce{${escape(source.trim())}}\\]</div>`;
    }
    if (blockKind === 'mermaid' || blockKind === 'smiles' || blockKind === 'csv' || blockKind === 'tsv') {
      const features = featureState(env);
      const counterKey: string = blockKind;
      const blockIndex = (features[counterKey] ?? 0) as number;
      features[counterKey] = blockIndex + 1;
      const limit = blockKind === 'mermaid'
        ? LIMITS.mermaidMaxSource
        : blockKind === 'smiles'
          ? LIMITS.smilesMaxSource
          : LIMITS.csvMaxBytes;
      const overLimit = source.length > limit;
      const label = blockKind === 'csv' ? 'CSV' : blockKind === 'tsv' ? 'TSV' : blockKind;
      return [
        `<div class="ld-block" data-ld-kind="${blockKind}" data-ld-index="${blockIndex}">`,
        `<div class="ld-block-header"><span class="ld-block-label">${escape(label)}</span>`,
        '<span class="ld-block-tools">',
        '<button type="button" data-ld-action="copy-source">复制源码</button>',
        '<button type="button" data-ld-action="fullscreen">全屏</button>',
        '</span></div>',
        `<div class="ld-block-body"${overLimit ? ' hidden' : ''}></div>`,
        overLimit
          ? '<p class="ld-notice">内容超过该类型的处理上限，已按源码显示。</p>'
          : '',
        `<pre class="ld-block-source"${overLimit ? '' : ' hidden'}>${escape(source)}</pre>`,
        '</div>',
      ].join('');
    }

    if (!KNOWN_FENCE_LANGUAGES.has(language) && language.length > 0) {
      const features = featureState(env);
      const unknown = (features.unknownLanguages as string[]) ?? [];
      if (unknown.length < 32 && !unknown.includes(language)) unknown.push(language);
      features.unknownLanguages = unknown;
    }

    const className = language.length > 0 ? ` class="language-${escape(language)}"` : '';
    // Only known languages are marked for highlighting: an unknown fence is shown
    // verbatim instead of being auto-detected.
    const highlightable =
      source.length <= LIMITS.codeHighlightMax && KNOWN_FENCE_LANGUAGES.has(language);
    return `<pre data-ld-code="${highlightable ? escape(language) : ''}"><code${className}>${escape(source)}</code></pre>\n`;
  };
}

/**
 * Feature counters live on the MarkdownIt environment. The helper keeps the
 * access typed without sprinkling casts through the renderer rules.
 */
function featureState(env: Env | undefined): Record<string, unknown> {
  if (!env) return {};
  const existing = env.ldFeatures;
  if (existing !== null && typeof existing === 'object') {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  env.ldFeatures = created;
  return created;
}

function renderFrontMatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const rows: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (line.trim() === '---') continue;
    const match = /^(\s*)([^:#][^:]*):\s*(.*)$/.exec(line);
    if (!match) {
      rows.push(`<dt>${escapeHtml(line.trim())}</dt>`);
      continue;
    }
    const key = (match[2] ?? '').trim();
    const value = (match[3] ?? '').trim();
    rows.push(
      `<dt>${escapeHtml(key)}</dt><dd>${value.length > 0 ? escapeHtml(value) : '<em>（空）</em>'}</dd>`,
    );
  }
  if (rows.length === 0) return '<dl></dl>';
  return `<dl>${rows.join('')}</dl>`;
}

// ---------------------------------------------------------------- block groups

export function parseDocument(md: MarkdownEngine, source: string): ParseResult {
  const env: Env = { ldFeatures: {} };
  const tokens = md.parse(source, env);

  const blocks: string[] = [];
  let group: typeof tokens = [];
  const flush = (): void => {
    if (group.length === 0) return;
    blocks.push(md.renderer.render(group, md.options, env));
    group = [];
  };

  for (const token of tokens) {
    const topLevel = token.level === 0;
    const opensBlock = token.nesting !== -1 && (token.type.endsWith('_open') || token.nesting === 0);
    if (topLevel && opensBlock && group.length > 0) flush();
    group.push(token);
  }
  flush();

  const features = (env.ldFeatures ?? {}) as Record<string, unknown>;
  const gathered: FeatureSet = {
    math: Number(features.math ?? 0),
    mermaid: Number(features.mermaid ?? 0),
    smiles: Number(features.smiles ?? 0),
    csv: Number(features.csv ?? 0),
    tsv: Number(features.tsv ?? 0),
    details: countOccurrences(source, /<details[\s>]/gi),
    callouts: Number(features.callouts ?? 0),
    footnotes: countOccurrences(source, /^\[\^[^\]]+\]:/gm),
    frontMatter: Boolean(env.ldFrontMatterPresent) || tokens.some((t) => t.type === 'ld_frontmatter'),
    hasTocMarker: Boolean(features.hasTocMarker),
    unknownLanguages: (features.unknownLanguages as string[]) ?? [],
  };

  const frontMatterToken = tokens.find((token) => token.type === 'ld_frontmatter');
  const truncatedBlocks = blocks.filter((block) => block.includes('data-ld-kind=')).length;

  return {
    blocks,
    headings: (env.ldHeadings as HeadingEntry[]) ?? [],
    features: gathered,
    frontMatter: frontMatterToken ? frontMatterToken.content : null,
    truncated: truncatedBlocks > 0 && source.length > LIMITS.richMaxBytes,
  };
}

function countOccurrences(source: string, pattern: RegExp): number {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}
