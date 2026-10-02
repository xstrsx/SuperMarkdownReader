import Papa from 'papaparse';
import {
  createMarkdown,
  parseDocument,
  type MarkdownEngine,
  type ParseResult,
} from '../markdown/engine';
import { LIMITS } from '../security/limits';

/**
 * Document worker: whole-document Markdown parsing and the CSV/TSV data layer.
 *
 * Reference definitions at the end of a file, fenced code blocks, footnotes and
 * cross-block structures all require a single pass over the complete source, so the
 * source is never cut into independent pieces here.
 *
 * The parsed Markdown comes back as complete top-level blocks. CSV data stays in
 * the worker and the viewport only asks for the row window it is about to show,
 * which is what keeps a 100k-row table searchable and scrollable without moving
 * millions of cells across the thread boundary.
 */
interface BaseRequest {
  type: string;
  id: number;
  generation: number;
}

interface ParseRequest extends BaseRequest {
  type: 'parse';
  source: string;
}

interface CsvLoadRequest extends BaseRequest {
  type: 'csv-load';
  source: string;
  delimiter: string;
}

interface CsvWindowRequest extends BaseRequest {
  type: 'csv-window';
  start: number;
  count: number;
}

interface CsvSearchRequest extends BaseRequest {
  type: 'csv-search';
  query: string;
  limit: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

const scope = self as unknown as WorkerScope;
let markdown: MarkdownEngine | null = null;

interface CsvStore {
  rows: string[][];
  cols: number;
  truncated: boolean;
  totalRows: number;
  truncatedCells: boolean;
}

let csv: CsvStore | null = null;

scope.onmessage = (event: MessageEvent) => {
  const data = event.data as unknown as BaseRequest & Record<string, unknown>;
  if (!data || typeof data.type !== 'string') return;
  try {
    switch (data.type) {
      case 'parse': {
        const request = data as unknown as ParseRequest;
        markdown = markdown ?? createMarkdown();
        const result: ParseResult = parseDocument(markdown, request.source ?? '');
        scope.postMessage({ type: 'parsed', id: request.id, generation: request.generation, result });
        break;
      }
      case 'csv-load': {
        const request = data as unknown as CsvLoadRequest;
        const loaded = loadCsv(request.source ?? '', request.delimiter ?? '');
        csv = loaded;
        scope.postMessage({
          type: 'csv-ready',
          id: request.id,
          generation: request.generation,
          rows: loaded.rows.length,
          cols: loaded.cols,
          truncated: loaded.truncated,
          truncatedCells: loaded.truncatedCells,
          totalRows: loaded.totalRows,
        });
        break;
      }
      case 'csv-window': {
        const request = data as unknown as CsvWindowRequest;
        const store = csv;
        if (!store) {
          scope.postMessage({ type: 'csv-window', id: request.id, generation: request.generation, start: 0, rows: [] });
          break;
        }
        const start = Math.max(0, Math.min(store.rows.length, request.start));
        const end = Math.max(start, Math.min(store.rows.length, start + request.count));
        scope.postMessage({
          type: 'csv-window',
          id: request.id,
          generation: request.generation,
          start,
          rows: store.rows.slice(start, end),
        });
        break;
      }
      case 'csv-search': {
        const request = data as unknown as CsvSearchRequest;
        const store = csv;
        const matches: number[] = [];
        if (store) {
          const needle = request.query.toLowerCase();
          const limit = Math.max(1, Math.min(request.limit || 2000, 20_000));
          for (let row = 0; row < store.rows.length && matches.length < limit; row += 1) {
            const cells = store.rows[row]!;
            for (let col = 0; col < cells.length; col += 1) {
              if ((cells[col] ?? '').toLowerCase().includes(needle)) {
                matches.push(row);
                break;
              }
            }
          }
        }
        scope.postMessage({
          type: 'csv-search-result',
          id: request.id,
          generation: request.generation,
          matches,
        });
        break;
      }
      case 'csv-dispose': {
        csv = null;
        scope.postMessage({ type: 'csv-disposed', id: data.id, generation: data.generation });
        break;
      }
      default:
        break;
    }
  } catch (error) {
    scope.postMessage({
      type: 'error',
      id: data.id,
      generation: data.generation,
      message: error instanceof Error ? error.message : 'worker failure',
    });
  }
};

function loadCsv(source: string, delimiter: string): CsvStore {
  const parsed = Papa.parse<string[]>(source, {
    delimiter: delimiter.length > 0 ? delimiter : '',
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
    comments: false,
    newline: undefined,
  });

  const raw = (parsed.data ?? []) as string[][];
  const rows: string[][] = [];
  let cols = 0;
  let truncated = false;
  let truncatedCells = false;
  let cells = 0;

  for (const row of raw) {
    if (rows.length >= LIMITS.csvMaxRows) {
      truncated = true;
      break;
    }
    const normalised = Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))) : [''];
    if (cols === 0) cols = normalised.length;
    if (normalised.length > LIMITS.csvMaxCols) {
      truncatedCells = true;
      rows.push(normalised.slice(0, LIMITS.csvMaxCols));
      cells += LIMITS.csvMaxCols;
    } else {
      rows.push(normalised);
      cells += normalised.length;
    }
    if (cells > LIMITS.csvMaxCells) {
      truncatedCells = true;
      break;
    }
  }

  return {
    rows,
    cols: Math.min(cols, LIMITS.csvMaxCols),
    truncated,
    truncatedCells,
    totalRows: raw.length,
  };
}
