import type { ParseResult } from '../markdown/engine';

/**
 * Typed request/response wrapper around the document worker. Every request carries
 * a monotonic id and the document generation; answers for a replaced document are
 * discarded rather than applied.
 */
export interface CsvMeta {
  rows: number;
  cols: number;
  truncated: boolean;
  truncatedCells: boolean;
  totalRows: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  generation: number;
}

export class DocumentWorkerClient {
  private readonly pending = new Map<number, Pending>();
  private counter = 0;
  private disposed = false;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent) => this.receive(event.data as Record<string, unknown>);
    worker.onerror = () => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error('worker crashed'));
      }
      this.pending.clear();
    };
  }

  static create(url: string): DocumentWorkerClient {
    const worker = new Worker(url, { type: 'module' });
    return new DocumentWorkerClient(worker);
  }

  parse(generation: number, source: string): Promise<ParseResult> {
    return this.send<ParseResult>({ type: 'parse', source }, generation);
  }

  csvLoad(generation: number, source: string, delimiter: string): Promise<CsvMeta> {
    return this.send<CsvMeta>({ type: 'csv-load', source, delimiter }, generation);
  }

  csvWindow(generation: number, start: number, count: number): Promise<{ start: number; rows: string[][] }> {
    return this.send<{ start: number; rows: string[][] }>({ type: 'csv-window', start, count }, generation);
  }

  csvSearch(generation: number, query: string, limit: number): Promise<{ matches: number[] }> {
    return this.send<{ matches: number[] }>({ type: 'csv-search', query, limit }, generation);
  }

  csvDispose(generation: number): void {
    this.send({ type: 'csv-dispose' }, generation).catch(() => undefined);
  }

  cancelGeneration(generation: number): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation === generation) {
        pending.reject(new Error('superseded'));
        this.pending.delete(id);
      }
    }
  }

  terminate(): void {
    this.disposed = true;
    this.pending.clear();
    this.worker.terminate();
  }

  private send<T>(payload: Record<string, unknown>, generation: number): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('worker terminated'));
    const id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        generation,
      });
      this.worker.postMessage({ ...payload, id, generation });
    });
  }

  private receive(data: Record<string, unknown>): void {
    const id = typeof data.id === 'number' ? data.id : -1;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (data.type === 'error') {
      pending.reject(new Error(typeof data.message === 'string' ? data.message : 'worker error'));
      return;
    }
    if (data.type === 'parsed') {
      pending.resolve(data.result);
      return;
    }
    if (data.type === 'csv-ready') {
      pending.resolve({
        rows: data.rows,
        cols: data.cols,
        truncated: data.truncated,
        truncatedCells: data.truncatedCells,
        totalRows: data.totalRows,
      });
      return;
    }
    if (data.type === 'csv-window') {
      pending.resolve({ start: data.start, rows: data.rows });
      return;
    }
    if (data.type === 'csv-search-result') {
      pending.resolve({ matches: data.matches });
      return;
    }
    pending.resolve({});
  }
}
