import DOMPurify from 'dompurify';
import { LIMITS } from './limits';
import { sanitizeStyleAttribute, sanitizeInlineStyle } from './css';

/**
 * SVG handling in "image" mode: the markup is never inlined into the live
 * document, it is pre-scanned, sanitised and then shown through an `<img>` with a
 * local blob URL. That keeps active content (scripts, event handlers, external
 * references) out of the reading context while preserving the static drawing
 * features that documents actually use (viewBox, gradients, masks, clipPaths,
 * filters, local `use` references and static styles).
 */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'animation',
  'animate',
  'set',
  'handler',
  'listener',
  'discard',
  'cursor',
  'mpath',
  'treffunc',
  'font-face-uri',
  'font-face-name',
  'glyphref',
]);

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export interface SvgStats {
  nodes: number;
  paths: number;
  depth: number;
}

export interface SvgResult {
  ok: boolean;
  svg?: string;
  reason?: string;
  stats?: SvgStats;
}

export function sanitizeSvg(source: string, maxBytes = LIMITS.svgMaxBytes): SvgResult {
  if (source.length === 0) return { ok: false, reason: 'empty' };
  if (source.length > maxBytes) return { ok: false, reason: 'too-large' };

  const head = source.slice(0, 2048).toUpperCase();
  if (head.includes('<!DOCTYPE') || head.includes('<!ENTITY')) {
    return { ok: false, reason: 'doctype-or-entity' };
  }
  if (/<\?xml-stylesheet/i.test(source.slice(0, 1024))) {
    return { ok: false, reason: 'xml-stylesheet' };
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(source, 'image/svg+xml');
  const parserError = parsed.querySelector('parsererror');
  if (parserError) return { ok: false, reason: 'xml-parse-error' };

  const root = parsed.documentElement;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    return { ok: false, reason: 'not-svg-root' };
  }

  const stats = cleanElement(root, 1, { nodes: 0, paths: 0, depth: 1 });
  if (stats.nodes > LIMITS.svgMaxNodes) return { ok: false, reason: 'too-many-nodes', stats };
  if (stats.paths > LIMITS.svgMaxPaths) return { ok: false, reason: 'too-many-paths', stats };
  if (stats.depth > LIMITS.svgMaxDepth) return { ok: false, reason: 'too-deep', stats };

  const serialized = new XMLSerializer().serializeToString(root);
  return { ok: true, svg: serialized, stats };
}

function cleanElement(
  element: Element,
  depth: number,
  stats: SvgStats,
): SvgStats {
  stats.nodes += 1;
  stats.depth = Math.max(stats.depth, depth);
  if (element.localName === 'path') stats.paths += 1;

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'style') {
      const safe = sanitizeInlineStyle(value);
      if (safe.length > 0) element.setAttribute('style', safe);
      else element.removeAttribute('style');
      continue;
    }
    if (name === 'href' || name === 'xlink:href' || attribute.namespaceURI === XLINK_NS) {
      const trimmed = value.trim();
      const isFragment = trimmed.startsWith('#');
      const isInlineImage = /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/i.test(trimmed);
      if (!isFragment && !isInlineImage) {
        // Cross-file `use`, remote images and every other external reference are
        // dropped: a remote SVG must not be able to fetch anything itself.
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (name === 'src' || name === 'data' || name === 'poster') {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'begin' || name === 'dur' || name === 'repeatcount') {
      element.removeAttribute(attribute.name);
    }
  }

  for (const child of Array.from(element.children)) {
    const tag = child.localName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      child.remove();
      continue;
    }
    if (tag === 'foreignobject') {
      sanitizeForeignObject(child);
      continue;
    }
    if (tag === 'style') {
      // A drawing's own stylesheet is kept only when it cannot reference an
      // external resource; CSS cannot execute script, but `url()`/`@import` would
      // leak a request when the exported file is opened elsewhere.
      const css = child.textContent ?? '';
      if (/url\s*\(|@import|expression\s*\(|javascript:/i.test(css)) {
        child.remove();
      }
      stats.nodes += 1;
      continue;
    }
    if (child.namespaceURI !== SVG_NS && tag !== 'foreignobject') {
      // Foreign markup inside a drawing is only tolerated inside foreignObject.
      child.remove();
      continue;
    }
    cleanElement(child, depth + 1, stats);
  }

  // Text nodes cannot carry active content, but a style attribute on a descendant
  // was already handled. Nothing else to do here.
  return stats;
}

/**
 * `foreignObject` is not removed outright (diagrams.net style files label shapes
 * with it), but its XHTML subtree is sanitised with DOMPurify and its inline CSS
 * goes through the CSS AST whitelist, so no script, event handler or remote
 * resource can survive.
 */
function sanitizeForeignObject(node: Element): void {
  const inner = node.innerHTML;
  if (inner.length === 0) return;
  const cleaned = DOMPurify.sanitize(inner, {
    ALLOWED_TAGS: [
      'div', 'span', 'p', 'br', 'b', 'i', 'em', 'strong', 'u', 's', 'sub', 'sup',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'code', 'pre',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'small', 'center', 'font',
    ],
    ALLOWED_ATTR: ['style', 'class', 'align', 'color', 'size', 'face', 'colspan', 'rowspan'],
    FORBID_TAGS: ['a', 'img', 'svg', 'math', 'iframe', 'object', 'embed', 'link', 'meta'],
    ALLOW_DATA_ATTR: false,
  });

  const container = document.createElementNS(SVG_NS, 'foreignObject');
  for (const attribute of Array.from(node.attributes)) {
    container.setAttribute(attribute.name, attribute.value);
  }
  const parsed = new DOMParser().parseFromString(
    `<body xmlns="http://www.w3.org/1999/xhtml">${cleaned}</body>`,
    'application/xhtml+xml',
  );
  const body = parsed.documentElement;
  if (body) {
    for (const child of Array.from(body.childNodes)) {
      container.appendChild(document.importNode(child, true));
    }
  }
  for (const element of Array.from(container.querySelectorAll('*'))) {
    sanitizeStyleAttribute(element);
  }
  node.replaceWith(container);
}

export function svgBlobUrl(svg: string): string {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  return URL.createObjectURL(blob);
}

export interface RasterizeOptions {
  width: number;
  height: number;
  scale: number;
  background: string | null;
}

/**
 * Rasterises a sanitised SVG for PNG export. The canvas size is bounded by the
 * pixel budget before allocation, so a huge drawing is scaled down instead of
 * allocating an unbounded bitmap.
 */
export async function rasterizeSvg(svg: string, options: RasterizeOptions): Promise<Blob> {
  const url = svgBlobUrl(svg);
  try {
    const image = await loadImage(url);
    const intrinsicWidth = image.naturalWidth || options.width || 1;
    const intrinsicHeight = image.naturalHeight || options.height || 1;

    let scale = options.scale;
    const maxEdge = LIMITS.exportPngMaxEdge;
    const maxPixels = LIMITS.exportPngMaxPixels;
    scale = Math.min(
      scale,
      maxEdge / Math.max(intrinsicWidth, intrinsicHeight),
      Math.sqrt(maxPixels / (intrinsicWidth * intrinsicHeight)),
    );
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;

    const targetWidth = Math.max(1, Math.round(intrinsicWidth * scale));
    const targetHeight = Math.max(1, Math.round(intrinsicHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas-unavailable');
    if (options.background) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, targetWidth, targetHeight);
    }
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/png');
    });
    if (!blob) throw new Error('png-encode-failed');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('svg-decode-failed'));
    image.src = url;
  });
}
