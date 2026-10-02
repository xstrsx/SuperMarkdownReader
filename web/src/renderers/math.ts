import { LIMITS } from '../security/limits';

/**
 * MathJax (SVG output, mhchem included).
 *
 * The whole document is typeset in one call, in source order. That is deliberate:
 * equation numbers, `\label`/`\ref`/`\eqref`, tags and macros defined earlier in
 * the document must keep their document-wide meaning, and a viewport-driven lazy
 * pass would reorder them. The engine is only loaded when the document actually
 * contains math, and its loader paths point exclusively at the packaged copy.
 */
export interface MathResult {
  expressions: number;
  failed: number;
  skipped: string | null;
}

export class MathRenderer {
  private loading: Promise<void> | null = null;
  private loaded = false;
  private version = 'unknown';

  isLoaded(): boolean {
    return this.loaded;
  }

  engineVersion(): string {
    return this.version;
  }

  hasMath(root: ParentNode): boolean {
    return root.querySelector('.ld-math, .ld-math-display') !== null;
  }

  async ensureLoaded(vendorBase: string): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const scriptUrl = new URL('vendor/mathjax/tex-svg.js', vendorBase).href;
    const fontsUrl = new URL('vendor/fonts/', vendorBase).href;
    const mathjaxUrl = new URL('vendor/mathjax/', vendorBase).href;

    window.MathJax = {
      loader: {
        paths: {
          mathjax: mathjaxUrl,
          fonts: fontsUrl,
        },
        load: [
          '[tex]/mhchem',
          '[tex]/ams',
          '[tex]/newcommand',
          '[tex]/configmacros',
          '[tex]/boldsymbol',
          '[tex]/cancel',
          '[tex]/cases',
          '[tex]/color',
          '[tex]/enclose',
          '[tex]/mathtools',
          '[tex]/physics',
          '[tex]/units',
          '[tex]/textmacros',
        ],
      },
      tex: {
        packages: {
          '[+]': [
            'mhchem',
            'ams',
            'newcommand',
            'configmacros',
            'boldsymbol',
            'cancel',
            'cases',
            'color',
            'enclose',
            'mathtools',
            'physics',
            'units',
            'textmacros',
          ],
        },
        // Delimiters are produced by the Markdown math rules, so MathJax itself
        // only has to recognise the escaped forms.
        inlineMath: [['\\(', '\\)']],
        displayMath: [['\\[', '\\]']],
        processEscapes: true,
        tags: 'ams',
        tagSide: 'right',
        maxBuffer: LIMITS.mathMaxSource,
        maxMacros: 10000,
      },
      options: {
        // The accessibility menu and the speech engine are disabled: they would
        // pull extra components (and a speech-rule-engine maths map) that this
        // offline build does not ship.
        enableMenu: false,
        enableEnrichment: false,
        enableExplorer: false,
        enableAssistiveMml: false,
        renderErrors: true,
        ignoreHtmlClass: 'ld-no-math',
        processHtmlClass: 'ld-math|ld-math-display',
      },
      svg: {
        fontCache: 'local',
        scale: 1,
        displayAlign: 'center',
        displayIndent: '0',
        linebreaks: { automatic: false },
      },
      startup: { typeset: false },
    };

    this.loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onload = () => {
        const mathjax = window.MathJax;
        if (!mathjax || !mathjax.typesetPromise) {
          reject(new Error('mathjax-missing-api'));
          return;
        }
        this.loaded = true;
        this.version = mathjax.version ?? 'unknown';
        resolve();
      };
      script.onerror = () => reject(new Error('mathjax-load-failed'));
      document.head.appendChild(script);
    }).finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  async typeset(root: HTMLElement): Promise<MathResult> {
    const mathjax = window.MathJax;
    if (!mathjax || !mathjax.typesetPromise) {
      return { expressions: 0, failed: 0, skipped: 'engine-unavailable' };
    }
    const elements = Array.from(root.querySelectorAll<HTMLElement>('.ld-math, .ld-math-display'));
    if (elements.length === 0) return { expressions: 0, failed: 0, skipped: null };
    if (elements.length > LIMITS.mathMaxExpressions) {
      return { expressions: 0, failed: 0, skipped: 'too-many-expressions' };
    }
    await mathjax.startup?.promise;
    await mathjax.typesetPromise(elements);
    const failed = root.querySelectorAll('mjx-merror, .ld-math-error').length;
    return { expressions: elements.length, failed, skipped: null };
  }

  /** Single-expression typeset, used when exporting one formula. */
  async typesetOne(element: HTMLElement): Promise<void> {
    const mathjax = window.MathJax;
    if (!mathjax || !mathjax.typesetPromise) return;
    await mathjax.startup?.promise;
    await mathjax.typesetPromise([element]);
  }

  clear(root: HTMLElement): void {
    window.MathJax?.typesetClear?.(Array.from(root.querySelectorAll('.ld-math, .ld-math-display')));
  }
}
