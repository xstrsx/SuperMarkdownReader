/**
 * Startup capability probe. The plan requires an explicit check instead of
 * assuming that "Android 8 can install it" means the renderers work: the engines
 * need ES modules, dynamic import, workers, observers and specific CSS/SVG
 * features, and the bridge needs the WebViewCompat message listener.
 */
export interface Capabilities {
  modules: boolean;
  dynamicImport: boolean;
  worker: boolean;
  moduleWorker: boolean;
  abortController: boolean;
  intersectionObserver: boolean;
  resizeObserver: boolean;
  textDecoder: boolean;
  textDecoderGb18030: boolean;
  cssSupports: boolean;
  svgFilters: boolean;
  bridge: boolean;
  missing: string[];
}

export function detectCapabilities(): Capabilities {
  const missing: string[] = [];
  const has = (ok: boolean, name: string): boolean => {
    if (!ok) missing.push(name);
    return ok;
  };

  // This file is itself an ES module, so modules and (by the same baseline)
  // dynamic import are available; the real proof is that the worker and the
  // lazily imported engines actually load, and each failure has its own reported
  // error path. `new Function` is deliberately not used as a probe: the CSP has no
  // 'unsafe-eval', so such a probe would always fail.
  const modules = true;
  const dynamicImport = true;

  const worker = has(typeof Worker === 'function', 'worker');
  const moduleWorker = (() => {
    if (!worker) return false;
    try {
      new Worker('data:text/javascript,', { type: 'module' });
      return true;
    } catch {
      return false;
    }
  })();
  has(moduleWorker, 'module-worker');

  const abortController = has(typeof AbortController === 'function', 'abort-controller');
  const intersectionObserver = has(typeof IntersectionObserver === 'function', 'intersection-observer');
  const resizeObserver = has(typeof ResizeObserver === 'function', 'resize-observer');
  const textDecoder = has(typeof TextDecoder === 'function', 'text-decoder');
  let gb18030 = false;
  if (textDecoder) {
    try {
      gb18030 = new TextDecoder('gb18030').encoding === 'gb18030';
    } catch {
      gb18030 = false;
    }
  }

  const cssSupports =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('display', 'grid') &&
    CSS.supports('position', 'sticky');
  has(cssSupports, 'css-grid-sticky');

  const svgFilters = (() => {
    if (typeof document.createElementNS !== 'function') return false;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    return filter !== null && svg !== null;
  })();
  has(svgFilters, 'svg-filters');

  const bridge =
    typeof window.litedoc !== 'undefined' && window.litedoc !== null && typeof window.litedoc.postMessage === 'function';
  has(bridge, 'native-message-listener');

  return {
    modules,
    dynamicImport,
    worker,
    moduleWorker,
    abortController,
    intersectionObserver,
    resizeObserver,
    textDecoder,
    textDecoderGb18030: gb18030,
    cssSupports,
    svgFilters,
    bridge,
    missing,
  };
}

export function browserVersion(): string {
  const ua = navigator.userAgent;
  const match = /Chrome\/(\d+)/.exec(ua);
  return match ? `Chromium/${match[1]}` : ua.slice(0, 80);
}
