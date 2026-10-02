import * as csstree from 'css-tree';

/**
 * Inline-style sanitiser built on a real CSS parser.
 *
 * DOMPurify is not a CSS sanitiser (its own documentation says so), so inline
 * styles are parsed into an AST and only a small property whitelist is kept.
 * `url()`, `@import`, `@font-face`, escapes, `expression()` and anything that can
 * position an element over the whole UI are removed.
 */
const ALLOWED_PROPERTIES = new Set([
  'color',
  'background-color',
  'background',
  'font-style',
  'font-weight',
  'font-family',
  'font-size',
  'font-variant',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'text-transform',
  'text-indent',
  'vertical-align',
  'white-space',
  'word-break',
  'overflow-wrap',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-style',
  'border-width',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'display',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stop-color',
  'stop-opacity',
  'font-feature-settings',
  'list-style',
  'list-style-type',
  'caption-side',
  'table-layout',
  'flex',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-self',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'aspect-ratio',
  'box-sizing',
]);

const FORBIDDEN_VALUE_PATTERN = /(url\s*\(|expression\s*\(|javascript:|vbscript:|@import|\\|&#|\\u)/i;

/** Properties that could cover the whole reading UI when position:fixed is used. */
const DANGEROUS_POSITION = new Set(['position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index', 'transform']);

let parseFailureCount = 0;

export function sanitizeInlineStyle(css: string): string {
  const trimmed = css.trim();
  if (trimmed.length === 0 || trimmed.length > 8192) return '';
  if (FORBIDDEN_VALUE_PATTERN.test(trimmed)) return '';

  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(trimmed, { context: 'declarationList' });
  } catch {
    parseFailureCount += 1;
    return '';
  }

  const kept: string[] = [];
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node: csstree.CssNode) {
      const property = (node.property ?? '').toLowerCase();
      if (!ALLOWED_PROPERTIES.has(property)) return;
      const valueText = csstree.generate(node.value);
      if (valueText.length > 512) return;
      if (FORBIDDEN_VALUE_PATTERN.test(valueText)) return;
      let hasUrl = false;
      csstree.walk(node.value as csstree.CssNode, {
        visit: 'Url',
        enter() {
          hasUrl = true;
        },
      });
      if (hasUrl || property === 'position' || DANGEROUS_POSITION.has(property)) return;
      kept.push(`${property}: ${valueText}`);
    },
  });
  return kept.join('; ');
}

export function sanitizeStyleAttribute(element: Element): void {
  const style = element.getAttribute('style');
  if (style === null) return;
  const safe = sanitizeInlineStyle(style);
  if (safe.length > 0) {
    element.setAttribute('style', safe);
  } else {
    element.removeAttribute('style');
  }
}

export function parseFailureTotal(): number {
  return parseFailureCount;
}
