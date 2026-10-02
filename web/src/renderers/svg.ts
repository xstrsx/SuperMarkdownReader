import { sanitizeSvg, rasterizeSvg } from '../security/svg';
import { LIMITS } from '../security/limits';

/**
 * Standalone SVG documents.
 *
 * The drawing is pre-scanned and sanitised, then shown as an `<img>` on a local
 * blob URL inside a pan/zoom container. It is never inlined into the reading DOM
 * and it is never a top-level navigation target for the raw file, so neither
 * scripts nor external references can run.
 */
export interface SvgViewer {
  element: HTMLElement;
  svg: string;
  label: string;
}

export function renderSvgDocument(source: string, label: string): SvgViewer {
  const result = sanitizeSvg(source);
  const wrapper = document.createElement('div');
  wrapper.className = 'ld-block ld-svg-document';
  if (!result.ok || !result.svg) {
    wrapper.classList.add('ld-block-error');
    wrapper.innerHTML = [
      '<div class="ld-block-header"><span class="ld-block-label">SVG</span></div>',
      `<div class="ld-block-body">SVG 未能通过安全预检（${escapeText(result.reason ?? 'unknown')}），已按源码显示。</div>`,
      `<pre class="ld-block-source">${escapeText(source.slice(0, 200_000))}</pre>`,
    ].join('');
    return { element: wrapper, svg: '', label };
  }

  const header = document.createElement('div');
  header.className = 'ld-block-header';
  header.innerHTML =
    `<span class="ld-block-label">SVG${result.stats ? ` · ${result.stats.nodes} nodes / ${result.stats.paths} paths` : ''}</span>` +
    '<span class="ld-block-tools">' +
    '<button type="button" data-ld-action="svg-bg" data-ld-bg="white">白底</button>' +
    '<button type="button" data-ld-action="svg-bg" data-ld-bg="dark">深底</button>' +
    '<button type="button" data-ld-action="svg-bg" data-ld-bg="checker">棋盘</button>' +
    '<button type="button" data-ld-action="svg-fit">适应宽度</button>' +
    '<button type="button" data-ld-action="svg-actual">原始大小</button>' +
    '<button type="button" data-ld-action="svg-export" data-ld-format="svg">导出 SVG</button>' +
    '<button type="button" data-ld-action="svg-export" data-ld-format="png">导出 PNG</button>' +
    '</span>';

  const body = document.createElement('div');
  body.className = 'ld-block-body';
  const canvas = document.createElement('div');
  canvas.className = 'ld-canvas';
  canvas.dataset.ldBg = 'white';
  const image = document.createElement('img');
  image.alt = label;
  const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
  image.src = url;
  image.dataset.ldObjectUrl = url;
  image.style.maxWidth = '100%';
  image.style.height = 'auto';
  canvas.appendChild(image);
  body.appendChild(canvas);

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return { element: wrapper, svg: result.svg, label };
}

export async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob> {
  return rasterizeSvg(svg, {
    width,
    height,
    scale: 1,
    background: null,
  });
}

export function svgByteLength(svg: string): number {
  return new TextEncoder().encode(svg).length;
}

export const SVG_LIMIT = LIMITS.svgMaxBytes;

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
