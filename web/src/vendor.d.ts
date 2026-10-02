/**
 * Ambient types for the vendored engines. Vendored code is never type-checked;
 * only the small surface LiteDoc touches is declared here.
 */
export {};

declare global {
  interface Window {
    MathJax?: MathJaxGlobal;
  }

  interface LiteDocHost {
    postMessage(message: string): void;
    onmessage: ((event: { data: string }) => void) | null;
  }

  interface Window {
    litedoc?: LiteDocHost;
  }
}

interface MathJaxGlobal {
  [key: string]: unknown;
  startup?: {
    promise?: Promise<void>;
    typeset?: boolean;
    document?: unknown;
    output?: { name?: string };
    input?: { name?: string };
    adaptor?: unknown;
  };
  config?: Record<string, unknown>;
  tex?: Record<string, unknown>;
  options?: Record<string, unknown>;
  svg?: Record<string, unknown>;
  loader?: { paths?: Record<string, string>; load?: string[] };
  tex2svgPromise?: (tex: string, options?: Record<string, unknown>) => Promise<unknown>;
  typesetPromise?: (elements?: ArrayLike<Element> | Element) => Promise<void>;
  typesetClear?: (elements?: ArrayLike<Element> | Element) => void;
  typeset?: (elements?: ArrayLike<Element> | Element) => void;
  svgStylesheet?: () => string;
  version?: string;
}
