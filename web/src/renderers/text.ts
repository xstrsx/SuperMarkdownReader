import { LIMITS } from '../security/limits';
import { escapeHtml } from '../markdown/engine';

/**
 * Plain text, source code, logs and LaTeX sources.
 *
 * The text is rendered with line numbers that are *not* part of the selectable
 * text (they are marked `user-select: none`) so copying never mixes UI numbering
 * into the document. Very large files are shown in page-sized windows instead of
 * being turned into one giant DOM node.
 */
export interface TextRenderOptions {
  highlightLanguage?: string | null;
  wrap?: boolean;
  pageSize?: number;
}

export interface TextRenderResult {
  element: HTMLElement;
  lineCount: number;
  highlighted: boolean;
}

const DEFAULT_PAGE = 20_000;

export function renderText(source: string, options: TextRenderOptions = {}): TextRenderResult {
  const pageSize = options.pageSize ?? DEFAULT_PAGE;
  const lines = source.split(/\r\n|\r|\n/);
  const container = document.createElement('div');
  container.className = 'ld-text';

  const totalLines = lines.length;
  const pages = Math.max(1, Math.ceil(totalLines / pageSize));

  for (let page = 0; page < pages; page += 1) {
    const start = page * pageSize;
    const end = Math.min(totalLines, start + pageSize);
    const pre = document.createElement('pre');
    pre.className = 'ld-source';
    pre.dataset.ldPage = String(page);
    pre.dataset.ldLanguage = options.highlightLanguage ?? '';
    pre.dataset.ldTotalLines = String(totalLines);
    const slice = lines.slice(start, end).join('\n');
    pre.dataset.ldPlain = slice;
    pre.innerHTML = buildNumberedHtml(slice, start);
    container.appendChild(pre);
  }

  if (options.highlightLanguage) {
    const limited = source.length <= LIMITS.codeHighlightMax;
    container.dataset.ldHighlight = limited ? options.highlightLanguage : '';
  }

  return {
    element: container,
    lineCount: totalLines,
    highlighted: Boolean(options.highlightLanguage) && source.length <= LIMITS.codeHighlightMax,
  };
}

function buildNumberedHtml(slice: string, startLine: number): string {
  const parts: string[] = [];
  const lines = slice.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const number = startLine + i + 1;
    parts.push(
      `<span class="ld-source-line"><span class="ld-source-lineno">${number}</span>${escapeHtml(lines[i] ?? '')}</span>`,
    );
  }
  return parts.join('\n');
}
