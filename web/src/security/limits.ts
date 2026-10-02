/**
 * Client-side mirrors of the native budgets. Every limit is enforced here as well,
 * because the document text is untrusted input and the renderer must not rely on
 * the native side alone.
 */
export const LIMITS = {
  richMaxBytes: 8 * 1024 * 1024,
  sourceMaxBytes: 32 * 1024 * 1024,
  htmlMaxBytes: 8 * 1024 * 1024,
  svgMaxBytes: 8 * 1024 * 1024,
  csvMaxBytes: 32 * 1024 * 1024,
  csvMaxRows: 100_000,
  csvMaxCols: 200,
  csvMaxCells: 2_000_000,
  csvInitialRows: 200,
  csvRowOverscan: 12,
  csvRowHeightPx: 22,
  mermaidMaxSource: 128 * 1024,
  mermaidMaxDiagrams: 200,
  mathMaxSource: 64 * 1024,
  mathMaxExpressions: 4000,
  smilesMaxSource: 16 * 1024,
  smilesMaxRecords: 5_000,
  codeHighlightMax: 200 * 1024,
  frontMatterMax: 64 * 1024,
  bridgeMessageMax: 64 * 1024,
  bridgeRequestTimeoutMs: 20_000,
  exportMaxBytes: 24 * 1024 * 1024,
  exportChunkChars: 16 * 1024,
  exportBudgetMs: 60_000,
  exportPngMaxEdge: 8192,
  exportPngMaxPixels: 16_000_000,
  imageRegistrationMax: 512,
  imagePrefetchMarginPx: 800,
  svgMaxNodes: 60_000,
  svgMaxPaths: 20_000,
  svgMaxDepth: 64,
  markdownBlocksPerFrame: 24,
  tocMaxEntries: 2_000,
} as const;

export type Limits = typeof LIMITS;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
