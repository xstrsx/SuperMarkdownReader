import DOMPurify from 'dompurify';
import { LIMITS } from './limits';
import { sanitizeStyleAttribute } from './css';
import { sanitizeSvg } from './svg';

/**
 * HTML sanitiser for rendered Markdown and for local HTML documents.
 *
 * Whitelists are explicit (never a string replace), script/event/iframe/form
 * payloads are removed, and every link is turned into a copy-only element: the
 * `href` is stored in `data-ld-href` and no navigation is possible at all. In-page
 * anchors keep their fragment so the table of contents still works.
 */
const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'section', 'small', 'source',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr', 'input', 'svg', 'use',
  'defs', 'symbol', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'text', 'tspan', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'pattern', 'filter', 'feblend', 'fecolormatrix',
  'fegaussianblur', 'feoffset', 'femerge', 'femergenode', 'title', 'desc',
];

const ALLOWED_ATTR = [
  // `href` and `src` are allowed only so the hooks below can read them; the hooks
  // then remove them and keep the value in a `data-ld-*` attribute instead, so no
  // element in the reading document can navigate or fetch anything.
  'href', 'src',
  'alt', 'title', 'class', 'id', 'dir', 'lang', 'start', 'reversed', 'type',
  'checked', 'disabled', 'colspan', 'rowspan', 'align', 'open', 'value', 'style',
  'width', 'height', 'viewbox', 'preserveaspectratio', 'fill', 'fill-rule',
  'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'transform',
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'd',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'patternunits', 'clippathunits', 'maskunits', 'filterunits', 'stddeviation',
  'dx', 'dy', 'text-anchor', 'dominant-baseline', 'font-size', 'font-family',
  'font-weight', 'font-style', 'data-ld-href', 'data-ld-ref', 'data-ld-kind',
  'data-ld-lang', 'data-ld-index', 'marker-end', 'marker-start', 'marker-mid',
  'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
];

let configured = false;
let inlineSvgRemoved = 0;

export interface SanitizeStats {
  inlineSvgRemoved: number;
}

export function consumeSanitizeStats(): SanitizeStats {
  const stats = { inlineSvgRemoved };
  inlineSvgRemoved = 0;
  return stats;
}

function configure(): void {
  if (configured) return;
  configured = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element;
    const tag = element.tagName.toLowerCase();

    if (tag === 'a') {
      const href = element.getAttribute('href') ?? '';
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
      if (href.startsWith('#')) {
        element.setAttribute('href', href);
        element.setAttribute('class', appendClass(element, 'ld-anchor'));
      } else if (/^(https?|mailto):/i.test(href)) {
        element.setAttribute('data-ld-href', href);
        element.setAttribute('class', appendClass(element, 'ld-link'));
      }
    }

    if (tag === 'img' || tag === 'source') {
      const src = element.getAttribute('src') ?? element.getAttribute('srcset') ?? '';
      element.removeAttribute('srcset');
      element.removeAttribute('sizes');
      if (src.length > 0) {
        // Resolution to a local session URL happens after insertion, because it
        // needs an asynchronous registration round-trip with native code.
        element.setAttribute('data-ld-ref', src);
      }
      element.removeAttribute('src');
      element.setAttribute('class', appendClass(element, 'ld-pending-image'));
    }

    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      if (type !== 'checkbox') {
        element.remove();
        return;
      }
      element.setAttribute('disabled', 'disabled');
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name !== 'type' && name !== 'checked' && name !== 'disabled' && name !== 'class') {
          element.removeAttribute(attribute.name);
        }
      }
    }

    if (element.hasAttribute('style')) {
      sanitizeStyleAttribute(element);
    }

    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    const tag = (data.tagName ?? '').toLowerCase();
    if (tag === 'svg') {
      // Inline SVG inside Markdown is not inlined into the live document: the
      // dedicated image-mode viewer handles SVG after a full pre-scan. The
      // occurrence is counted and reported instead of disappearing silently.
      inlineSvgRemoved += 1;
      const parent = (node as Element).parentNode;
      if (parent) parent.removeChild(node as Element);
    }
  });
}

function appendClass(element: Element, name: string): string {
  const current = element.getAttribute('class') ?? '';
  return current.length > 0 ? `${current} ${name}` : name;
}

export interface SanitizeOptions {
  maxBytes?: number;
  allowImages?: boolean;
}

export function sanitizeFragment(html: string, options: SanitizeOptions = {}): string {
  configure();
  const maxBytes = options.maxBytes ?? LIMITS.htmlMaxBytes;
  const slice = html.length > maxBytes ? html.slice(0, maxBytes) : html;
  const result = DOMPurify.sanitize(slice, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'meta', 'base', 'link', 'math'],
    // `href` is not forbidden here: the hook above rewrites every link into a
    // copy-only element while keeping in-page anchors working.
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'ping', 'srcdoc', 'xlink:href'],
    KEEP_CONTENT: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });
  return typeof result === 'string' ? result : '';
}

export interface SanitizedDocument {
  html: string;
  title: string | null;
  bodyClass: string | null;
}

/**
 * Local HTML documents go through the same static pipeline: scripts, external
 * stylesheets, frames and forms disappear, and only sanitised inline styles and
 * authorised images survive. A document can never become an active page.
 */
export function sanitizeHtmlDocument(source: string): SanitizedDocument {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const title = parsed.title && parsed.title.trim().length > 0 ? parsed.title.trim() : null;
  for (const element of Array.from(parsed.querySelectorAll('script, style, link, meta, base, iframe, object, embed, form, noscript, template'))) {
    element.remove();
  }
  const body = parsed.body;
  const inner = body ? body.innerHTML : source;
  const cleaned = sanitizeFragment(inner, { maxBytes: LIMITS.htmlMaxBytes });
  return {
    html: cleaned,
    title,
    bodyClass: body?.getAttribute('class') ?? null,
  };
}

/** Extracts the fragment part of an anchor for the in-page table of contents. */
export function anchorTarget(element: Element): string | null {
  const href = element.getAttribute('href') ?? '';
  return href.startsWith('#') ? href.slice(1) : null;
}

export interface ResourceResolution {
  url: string;
  kind: 'remote-image' | 'local-resource' | 'inline';
}

export interface ResourceHost {
  registerRemoteImages(
    urls: string[],
  ): Promise<{ registered: Array<{ url: string; localUrl: string }>; rejected: Array<{ url: string; reason: string }> }>;
  registerLocalResources(
    refs: string[],
  ): Promise<{ registered: Array<{ ref: string; localUrl: string }>; missing: string[] }>;
  reportResourceNotice(message: string): void;
}

/**
 * Resolves `data-ld-ref` placeholders into local session URLs. Nothing here can
 * reach the network: remote images are registered with native code, which owns the
 * only HTTP client, and local references are resolved inside the authorised tree.
 */
export async function resolveResources(root: ParentNode, host: ResourceHost): Promise<void> {
  const pending = Array.from(root.querySelectorAll('[data-ld-ref]')) as HTMLElement[];
  if (pending.length === 0) return;

  const remote: string[] = [];
  const local: string[] = [];
  for (const element of pending) {
    const ref = element.getAttribute('data-ld-ref') ?? '';
    if (ref.length === 0) {
      element.removeAttribute('data-ld-ref');
      continue;
    }
    if (/^https?:\/\//i.test(ref)) {
      remote.push(ref);
    } else if (/^data:/i.test(ref)) {
      element.setAttribute('src', ref);
      element.removeAttribute('data-ld-ref');
      element.classList.remove('ld-pending-image');
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      // Unknown scheme (javascript:, file:, content:, ...) is dropped.
      element.setAttribute('class', appendClass(element, 'ld-image-rejected'));
      element.removeAttribute('data-ld-ref');
    } else {
      local.push(ref);
    }
  }

  if (local.length > 0) {
    try {
      const result = await host.registerLocalResources(unique(local).slice(0, LIMITS.imageRegistrationMax));
      const map = new Map(result.registered.map((entry) => [entry.ref, entry.localUrl]));
      for (const element of Array.from(root.querySelectorAll('[data-ld-ref]')) as HTMLElement[]) {
        const ref = element.getAttribute('data-ld-ref') ?? '';
        const url = map.get(ref);
        if (url) {
          element.setAttribute('src', url);
          element.removeAttribute('data-ld-ref');
          element.classList.remove('ld-pending-image');
        }
      }
      if (result.missing.length > 0) {
        host.reportResourceNotice(
          `${result.missing.length} 个本地附件未能解析（需要授权附件目录）`,
        );
      }
    } catch {
      host.reportResourceNotice('本地附件解析失败');
    }
  }

  if (remote.length > 0) {
    try {
      const result = await host.registerRemoteImages(unique(remote).slice(0, LIMITS.imageRegistrationMax));
      const map = new Map(result.registered.map((entry) => [entry.url, entry.localUrl]));
      for (const element of Array.from(root.querySelectorAll('[data-ld-ref]')) as HTMLElement[]) {
        const ref = element.getAttribute('data-ld-ref') ?? '';
        const url = map.get(ref);
        if (url) {
          element.setAttribute('src', url);
          element.setAttribute('loading', 'lazy');
          element.setAttribute('decoding', 'async');
          element.removeAttribute('data-ld-ref');
          element.classList.remove('ld-pending-image');
        }
      }
      if (result.rejected.length > 0 && result.registered.length === 0) {
        host.reportResourceNotice('文档中的网络图片已被拒绝（策略或设置）');
      }
    } catch {
      host.reportResourceNotice('网络图片登记失败');
    }
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export { sanitizeSvg };
