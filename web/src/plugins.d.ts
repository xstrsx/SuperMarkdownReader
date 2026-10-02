/**
 * The markdown-it extension packages ship no type declarations, and the bundler
 * only needs their default export. Declaring the exact surface LiteDoc uses keeps
 * the type check meaningful without an `any` at every call site.
 */
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-deflist' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-sub' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-sup' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-ins' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it';
  export const full: MarkdownIt.PluginSimple;
  export const light: MarkdownIt.PluginSimple;
  export const bare: MarkdownIt.PluginSimple;
}

declare module 'css-tree' {
  export interface CssNode {
    type: string;
    property?: string;
    value?: unknown;
    [key: string]: unknown;
  }
  export interface ParseOptions {
    context?: string;
    positions?: boolean;
    parseAtrulePrelude?: boolean;
    parseRulePrelude?: boolean;
    parseValue?: boolean;
  }
  export interface WalkOptions {
    visit?: string;
    enter?: (node: CssNode, item: unknown, list: unknown) => void;
    leave?: (node: CssNode) => void;
  }
  export function parse(css: string, options?: ParseOptions): CssNode;
  export function walk(ast: CssNode, options: WalkOptions): void;
  export function generate(node: unknown): string;
}
