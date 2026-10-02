import type { DocumentWorkerClient, CsvMeta } from '../workers/client';
import { LIMITS } from '../security/limits';

/**
 * CSV / TSV viewer with a virtual viewport.
 *
 * The data layer lives in the worker: the DOM only ever holds the rows that are
 * about to be visible, so a 100k-row table scrolls without mounting 100k nodes.
 * Search runs over the data (not over the rendered rows), which is why a hit
 * outside the current window can still be found and jumped to.
 */
export interface CsvViewerOptions {
  client: DocumentWorkerClient;
  generation: number;
  source: string;
  kind: 'csv' | 'tsv';
  getTheme: () => 'light' | 'dark';
}

export interface CsvViewerHandle {
  dispose(): void;
  search(query: string): Promise<number>;
  meta(): CsvMeta | null;
  refreshDelimiter(delimiter: string): Promise<void>;
}

export async function mountCsvViewer(
  body: HTMLElement,
  options: CsvViewerOptions,
): Promise<CsvViewerHandle> {
  body.textContent = '';
  const state = {
    meta: null as CsvMeta | null,
    header: true,
    delimiter: options.kind === 'tsv' ? '\t' : '',
    rowHeight: LIMITS.csvRowHeightPx,
    firstRow: 0,
    rendered: 0,
    matches: [] as number[],
    matchCursor: -1,
    loadToken: 0,
    disposed: false,
  };

  const toolbar = document.createElement('div');
  toolbar.className = 'ld-csv-toolbar';

  const delimiterSelect = document.createElement('select');
  for (const [value, label] of [
    ['', '自动分隔符'],
    [',', '逗号 ,'],
    ['\t', '制表符 Tab'],
    [';', '分号 ;'],
    ['|', '竖线 |'],
  ] as Array<[string, string]>) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    delimiterSelect.appendChild(option);
  }
  delimiterSelect.value = state.delimiter;

  const headerToggle = document.createElement('label');
  headerToggle.className = 'ld-csv-toggle';
  const headerCheckbox = document.createElement('input');
  headerCheckbox.type = 'checkbox';
  headerCheckbox.checked = true;
  headerToggle.appendChild(headerCheckbox);
  headerToggle.appendChild(document.createTextNode(' 首行作为表头'));

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = '在数据中搜索';
  searchInput.className = 'ld-csv-search';

  const status = document.createElement('span');
  status.className = 'ld-csv-status';

  toolbar.append(delimiterSelect, headerToggle, searchInput, status);

  const viewport = document.createElement('div');
  viewport.className = 'ld-csv-viewport';
  const table = document.createElement('table');
  table.className = 'ld-csv-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  viewport.appendChild(table);

  body.append(toolbar, viewport);

  const rerender = (): void => {
    if (state.disposed) return;
    const meta = state.meta;
    if (!meta) return;
    const total = meta.rows;
    const rowHeight = state.rowHeight;
    const scrollTop = viewport.scrollTop;
    const visible = Math.ceil(viewport.clientHeight / rowHeight) + LIMITS.csvRowOverscan;
    const headerRows = state.header ? 1 : 0;
    const first = Math.max(headerRows, Math.floor(scrollTop / rowHeight) + headerRows - 2);
    const count = Math.max(1, Math.min(total - first, visible));
    if (first === state.firstRow && count === state.rendered) return;
    state.firstRow = first;
    state.rendered = count;
    void loadWindow(first, count);
  };

  const loadWindow = async (start: number, count: number): Promise<void> => {
    const meta = state.meta;
    if (!meta) return;
    const token = ++state.loadToken;
    try {
      const window = await options.client.csvWindow(options.generation, start, count);
      if (state.disposed || token !== state.loadToken) return;
      paint(window.start, window.rows, meta);
    } catch {
      // Superseded or disposed: nothing to show.
    }
  };

  const paint = (start: number, rows: string[][], meta: CsvMeta): void => {
    const headerRows = state.header ? 1 : 0;
    tbody.textContent = '';
    const topSpacer = document.createElement('tr');
    topSpacer.className = 'ld-csv-spacer';
    const topCell = document.createElement('td');
    topCell.colSpan = Math.max(1, meta.cols);
    topCell.style.height = `${Math.max(0, (start - headerRows) * state.rowHeight)}px`;
    topCell.style.padding = '0';
    topCell.style.border = 'none';
    topSpacer.appendChild(topCell);
    tbody.appendChild(topSpacer);

    rows.forEach((cells, offset) => {
      const rowIndex = start + offset;
      const tr = document.createElement('tr');
      if (state.matches.includes(rowIndex)) tr.classList.add('ld-csv-hit');
      for (let col = 0; col < Math.max(1, meta.cols); col += 1) {
        const td = document.createElement('td');
        td.textContent = cells[col] ?? '';
        td.title = cells[col] ?? '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    const bottomSpacer = document.createElement('tr');
    bottomSpacer.className = 'ld-csv-spacer';
    const bottomCell = document.createElement('td');
    bottomCell.colSpan = Math.max(1, meta.cols);
    const renderedEnd = start + rows.length;
    bottomCell.style.height = `${Math.max(0, (meta.rows - renderedEnd) * state.rowHeight)}px`;
    bottomCell.style.padding = '0';
    bottomCell.style.border = 'none';
    bottomSpacer.appendChild(bottomCell);
    tbody.appendChild(bottomSpacer);
  };

  const paintHeader = (): void => {
    const meta = state.meta;
    thead.textContent = '';
    if (!meta) return;
    const row = document.createElement('tr');
    for (let col = 0; col < Math.max(1, meta.cols); col += 1) {
      const th = document.createElement('th');
      th.textContent = state.header ? `#${col + 1}` : `列 ${col + 1}`;
      row.appendChild(th);
    }
    thead.appendChild(row);
  };

  const load = async (delimiter: string): Promise<void> => {
    const meta = await options.client.csvLoad(options.generation, options.source, delimiter);
    if (state.disposed) return;
    state.meta = meta;
    state.firstRow = -1;
    state.rendered = -1;
    paintHeader();
    viewport.scrollTop = 0;
    rerender();
    status.textContent = `${meta.rows} 行 × ${meta.cols} 列${meta.truncated ? '（已达行数上限）' : ''}${meta.truncatedCells ? '（已达列/单元格上限）' : ''}`;
  };

  let scrollScheduled = false;
  viewport.addEventListener('scroll', () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    window.requestAnimationFrame(() => {
      scrollScheduled = false;
      rerender();
    });
  });

  delimiterSelect.addEventListener('change', () => {
    state.delimiter = delimiterSelect.value;
    void load(state.delimiter);
  });

  headerCheckbox.addEventListener('change', () => {
    state.header = headerCheckbox.checked;
    paintHeader();
    state.firstRow = -1;
    rerender();
  });

  let searchTimer = 0;
  const runSearch = async (query: string): Promise<number> => {
    if (query.trim().length === 0) {
      state.matches = [];
      state.matchCursor = -1;
      status.textContent = '';
      rerender();
      return 0;
    }
    const result = await options.client.csvSearch(options.generation, query, 2000);
    if (state.disposed) return 0;
    state.matches = result.matches;
    state.matchCursor = -1;
    status.textContent = `匹配 ${result.matches.length} 行`;
    return result.matches.length;
  };

  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void runSearch(searchInput.value);
    }, 220);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void jumpToMatch(event.shiftKey ? -1 : 1);
  });

  const jumpToMatch = async (direction: number): Promise<void> => {
    if (state.matches.length === 0) {
      await runSearch(searchInput.value);
      if (state.matches.length === 0) return;
    }
    state.matchCursor = (state.matchCursor + direction + state.matches.length) % state.matches.length;
    const row = state.matches[state.matchCursor] ?? 0;
    const headerRows = state.header ? 1 : 0;
    viewport.scrollTop = Math.max(0, (row - headerRows - 3) * state.rowHeight);
    state.firstRow = -1;
    rerender();
  };

  await load(state.delimiter);

  return {
    dispose(): void {
      state.disposed = true;
      options.client.csvDispose(options.generation);
      body.textContent = '';
    },
    search: runSearch,
    meta: () => state.meta,
    async refreshDelimiter(delimiter: string): Promise<void> {
      state.delimiter = delimiter;
      await load(delimiter);
    },
  };
}

export function parseDelimiterKind(kind: 'csv' | 'tsv'): string {
  return kind === 'tsv' ? '\t' : '';
}

export function csvThemeClass(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? 'ld-csv-dark' : 'ld-csv-light';
}
