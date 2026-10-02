import { LIMITS } from '../security/limits';

/**
 * Mermaid.
 *
 * The full ESM distribution is packaged locally (entry plus its lazy chunks); the
 * engine is imported on first use, never fetched. `securityLevel: 'strict'` locks
 * the security settings so a document cannot raise them, HTML labels are disabled
 * (no foreignObject in the output), and rendering is serialised by the scheduler.
 */
export interface MermaidTheme {
  theme: 'default' | 'dark' | 'base';
  fontFamily: string;
  fontSize: number;
}

export interface MermaidResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string, container?: Element): Promise<MermaidResult>;
  parse(text: string, options?: Record<string, unknown>): Promise<unknown> | boolean;
  detectType?(text: string, options?: Record<string, unknown>): string;
  version?: string;
}

export class MermaidRenderer {
  private api: MermaidApi | null = null;
  private loading: Promise<MermaidApi> | null = null;
  private counter = 0;
  private readonly cache = new Map<string, string>();
  private version = 'unknown';

  isLoaded(): boolean {
    return this.api !== null;
  }

  engineVersion(): string {
    return this.version;
  }

  async ensureLoaded(vendorBase: string): Promise<MermaidApi> {
    if (this.api) return this.api;
    if (this.loading) return this.loading;
    const url = new URL('vendor/mermaid/mermaid.esm.min.mjs', vendorBase).href;
    this.loading = (async () => {
      const module = (await import(/* @vite-ignore */ url)) as { default: MermaidApi };
      const api = module.default;
      if (!api || typeof api.render !== 'function') throw new Error('mermaid-load-failed');
      this.api = api;
      this.version = api.version ?? 'unknown';
      return api;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  initialize(theme: MermaidTheme): void {
    if (!this.api) return;
    this.api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Strict HTML sanitisation on labels; SVG text keeps the drawing free of
      // foreignObject so PNG export and printing behave predictably.
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      class: { htmlLabels: false },
      theme: theme.theme === 'dark' ? 'dark' : 'default',
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      deterministicIds: true,
      deterministicIDSeed: 'litedoc',
      maxTextSize: LIMITS.mermaidMaxSource,
      maxEdges: 2000,
      logLevel: 'fatal',
      suppressErrorRendering: false,
    });
  }

  /** Renders one diagram, reusing a cache keyed by source, theme and version. */
  async renderDiagram(
    source: string,
    theme: MermaidTheme,
    seed: string,
  ): Promise<MermaidResult> {
    const api = this.api;
    if (!api) throw new Error('mermaid-not-loaded');
    if (source.length > LIMITS.mermaidMaxSource) throw new Error('mermaid-source-too-large');
    const key = `${seed}|${theme.theme}|${theme.fontSize}|${this.version}`;
    const cached = this.cache.get(key);
    if (cached) return { svg: cached };

    this.counter += 1;
    const id = `ld-mermaid-${this.counter}`;
    const result = await api.render(id, source);
    if (result && typeof result.svg === 'string') {
      this.cache.set(key, result.svg);
      if (this.cache.size > 60) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
    }
    return result;
  }

  async validate(source: string): Promise<string | null> {
    const api = this.api;
    if (!api || typeof api.parse !== 'function') return null;
    try {
      await api.parse(source, { suppressErrors: true });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'parse-error';
    }
  }

  invalidate(): void {
    this.cache.clear();
  }
}
