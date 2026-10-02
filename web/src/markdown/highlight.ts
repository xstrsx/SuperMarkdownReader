import { LIMITS } from '../security/limits';

/**
 * Code highlighting with a fixed, curated language set. Automatic language
 * detection is deliberately off (the plan forbids it): an unknown fence language is
 * shown as plain code, and copying stays complete because the original text is what
 * the element contains.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  rs: 'rust',
  go: 'go',
  objc: 'objectivec',
  md: 'markdown',
  tex: 'latex',
  latex: 'latex',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gradle: 'groovy',
};

const LOADABLE = new Set([
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile', 'go', 'graphql',
  'groovy', 'ini', 'java', 'javascript', 'json', 'kotlin', 'latex', 'less',
  'lua', 'makefile', 'markdown', 'nginx', 'objectivec', 'perl', 'php', 'plaintext',
  'powershell', 'properties', 'python', 'r', 'ruby', 'rust', 'scala', 'scss',
  'sql', 'swift', 'typescript', 'xml', 'yaml',
]);

type HighlightApi = {
  getLanguage(name: string): unknown;
  registerLanguage(name: string, language: unknown): void;
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
  registerAliases(alias: Record<string, string | string[]>): void;
};

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  properties: () => import('highlight.js/lib/languages/properties'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

export class HighlightService {
  private core: HighlightApi | null = null;
  private readonly registered = new Set<string>();

  static normalise(language: string): string | null {
    const cleaned = language.trim().toLowerCase();
    if (cleaned.length === 0) return null;
    const mapped = LANGUAGE_ALIASES[cleaned] ?? cleaned;
    return LOADABLE.has(mapped) ? mapped : null;
  }

  /** True when the language can be highlighted (used to keep the UI honest). */
  static supports(language: string): boolean {
    return HighlightService.normalise(language) !== null;
  }

  private async ensureCore(): Promise<HighlightApi> {
    if (this.core) return this.core;
    const module = (await import('highlight.js/lib/core')) as unknown as { default: HighlightApi };
    const core = module.default;
    core.registerAliases(LANGUAGE_ALIASES as unknown as Record<string, string>);
    this.core = core;
    return core;
  }

  private async ensureLanguage(language: string): Promise<boolean> {
    const core = await this.ensureCore();
    if (this.registered.has(language)) return true;
    const loader = LANGUAGE_LOADERS[language];
    if (!loader) return false;
    try {
      const module = await loader();
      core.registerLanguage(language, module.default);
      this.registered.add(language);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns highlighted HTML, or null when the block must stay plain. */
  async highlight(code: string, language: string): Promise<string | null> {
    if (code.length > LIMITS.codeHighlightMax) return null;
    const normalised = HighlightService.normalise(language);
    if (!normalised) return null;
    if (!(await this.ensureLanguage(normalised))) return null;
    try {
      const core = await this.ensureCore();
      return core.highlight(code, { language: normalised, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }
}
