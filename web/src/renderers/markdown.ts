import { LIMITS } from '../security/limits';
import type { HeadingEntry } from '../markdown/engine';
import { nextFrame } from '../scheduler/queue';

/**
 * Batched insertion of complete top-level blocks.
 *
 * The document is never split by byte or line count: the worker returns whole
 * syntax blocks, and each batch appends whole blocks, so lists, tables, code
 * fences and footnote sections stay intact. Insertion is chunked only to keep the
 * main thread responsive, and every batch re-checks the generation so a replaced
 * document can never be half-overwritten by an old one.
 */
export interface InsertHooks {
  sanitize: (html: string) => string;
  onBatchInserted: (nodes: HTMLElement[], generation: number) => void;
  isActive: (generation: number) => boolean;
  resolveResources: (nodes: HTMLElement[], generation: number) => void;
  onProgress?: (inserted: number, total: number) => void;
}

export async function insertBlocks(
  root: HTMLElement,
  blocks: string[],
  generation: number,
  hooks: InsertHooks,
): Promise<number> {
  let inserted = 0;
  let batch: HTMLElement[] = [];

  for (const html of blocks) {
    if (!hooks.isActive(generation)) return inserted;
    const fragment = document.createRange().createContextualFragment(hooks.sanitize(html));
    const nodes: HTMLElement[] = [];
    for (const node of Array.from(fragment.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        nodes.push(node as HTMLElement);
      } else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0) {
        const paragraph = document.createElement('p');
        paragraph.textContent = node.textContent;
        nodes.push(paragraph);
      }
    }
    for (const node of nodes) {
      root.appendChild(node);
      batch.push(node);
      inserted += 1;
    }

    if (batch.length >= LIMITS.markdownBlocksPerFrame) {
      hooks.onBatchInserted(batch, generation);
      hooks.resolveResources(batch, generation);
      hooks.onProgress?.(inserted, blocks.length);
      batch = [];
      await nextFrame();
    }
  }

  if (batch.length > 0) {
    hooks.onBatchInserted(batch, generation);
    hooks.resolveResources(batch, generation);
  }
  hooks.onProgress?.(inserted, blocks.length);
  return inserted;
}

/** Builds the list used by both the in-page `[TOC]` marker and the native menu. */
export function buildTocList(headings: HeadingEntry[], compact: boolean): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'ld-toc-list';
  for (const heading of headings.slice(0, LIMITS.tocMaxEntries)) {
    const item = document.createElement('li');
    item.className = `ld-toc-level-${heading.level}`;
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.text.length > 0 ? heading.text : heading.id;
    item.appendChild(link);
    list.appendChild(item);
  }
  if (headings.length > LIMITS.tocMaxEntries) {
    const note = document.createElement('li');
    note.className = 'ld-notice';
    note.textContent = `目录过长，仅显示前 ${LIMITS.tocMaxEntries} 项`;
    list.appendChild(note);
  }
  if (compact) list.dataset.ldCompact = '1';
  return list;
}

export function fillTocMarkers(root: HTMLElement, headings: HeadingEntry[]): number {
  const markers = Array.from(root.querySelectorAll<HTMLElement>('[data-ld-toc]'));
  for (const marker of markers) {
    marker.textContent = '';
    marker.appendChild(buildTocList(headings, true));
  }
  return markers.length;
}

/**
 * Footnote definitions must keep their back links working after sanitisation: the
 * links stay in-page anchors, so they are already handled, but the footnote block is
 * moved to the end of the reading area if it is not already last.
 */
export function normaliseFootnotes(root: HTMLElement): void {
  const footnotes = root.querySelector('.footnotes');
  if (footnotes && footnotes !== root.lastElementChild) {
    root.appendChild(footnotes);
  }
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a.footnote-backref, a[href^="#fnref"]'))) {
    link.classList.add('ld-anchor');
  }
}
