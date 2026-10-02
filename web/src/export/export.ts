import type { Bridge, BridgeContext } from '../bridge/protocol';
import { LIMITS } from '../security/limits';
import { sanitizeSvg, rasterizeSvg } from '../security/svg';
import type { RenderScheduler } from '../scheduler/queue';
import { nextFrame } from '../scheduler/queue';

/**
 * Export state machine (mirrors the native coordinator):
 *
 *   IDLE -> PREPARING -> RENDERING_ALL -> WAITING_IMAGES
 *        -> STABILIZING_LAYOUT -> READY -> PRINTING/SAVING -> DONE/FAILED
 *
 * `onPageFinished` is never treated as a completion signal. Preparation is
 * cancellable and bounded: when the budget expires the remaining item count is
 * reported and the user's chosen export still happens, with placeholders, instead
 * of silently dropping content.
 */
export type ExportState =
  | 'idle'
  | 'preparing'
  | 'rendering-all'
  | 'waiting-images'
  | 'stabilizing'
  | 'ready'
  | 'streaming'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface ExportHost {
  bridge: Bridge;
  context: () => BridgeContext;
  root: () => HTMLElement;
  scheduler: RenderScheduler;
  notify: (message: string) => void;
  reportError: (code: string, message: string) => void;
  graphicSource: () => { svg: string; width: number; height: number; label: string } | null;
  baseUrl: string;
}

export interface PrepareResult {
  state: ExportState;
  pending: number;
}

export class ExportController {
  private state: ExportState = 'idle';
  private prepared = false;
  private cancelled = false;

  constructor(private readonly host: ExportHost) {}

  getState(): ExportState {
    return this.state;
  }

  isPrepared(): boolean {
    return this.prepared;
  }

  cancel(): void {
    this.cancelled = true;
    this.host.scheduler.resume();
    this.state = 'cancelled';
  }

  reset(): void {
    this.prepared = false;
    this.cancelled = false;
    this.state = 'idle';
    this.host.scheduler.resume();
  }

  /** Completes the whole document, then asks native code to start the export. */
  async prepare(kind: 'pdf' | 'svg' | 'png'): Promise<PrepareResult> {
    this.cancelled = false;
    this.prepared = false;
    this.state = 'preparing';
    this.host.notify('正在准备完整内容（屏幕外公式与图表）…');

    // 1. Expand collapsed content so the exported PDF matches what the user reads.
    for (const details of Array.from(this.host.root().querySelectorAll('details'))) {
      details.open = true;
    }

    // 2. Pause viewport-driven work and finish every known block in document order.
    this.host.scheduler.pause();
    this.state = 'rendering-all';
    const budget = LIMITS.exportBudgetMs;
    const started = performance.now();
    const drained = await this.host.scheduler.drain(Math.max(1000, budget - 8000));

    // 3. Wait for images: resolved, loaded or explicitly failed.
    this.state = 'waiting-images';
    const imagesPending = await waitForImages(this.host.root(), Math.max(1000, budget - (performance.now() - started) - 4000));

    // 4. Stabilise layout: fonts, then two animation frames with unchanged height.
    this.state = 'stabilizing';
    await waitForFonts();
    await stabiliseLayout(this.host.root(), Math.max(500, budget - (performance.now() - started)));

    if (this.cancelled) return { state: 'cancelled', pending: drained.pending };

    const pending = drained.pending + imagesPending;
    this.state = 'ready';
    this.prepared = true;

    if (drained.timedOut || imagesPending > 0) {
      this.host.notify(`导出准备超时，仍有 ${pending} 项未完成（将以占位导出）`);
    }

    // 5. Hand over to native code, which owns the system print/destination UI.
    try {
      await this.host.bridge.request('requestExport', { kind }, this.host.context());
    } catch (error) {
      this.state = 'failed';
      this.host.reportError('export-request-failed', error instanceof Error ? error.message : 'unknown');
    }
    return { state: this.state, pending };
  }

  /**
   * Streams the currently visible graphic to the destination native code opened.
   * The payload is verified by byte count and SHA-256 natively before the export is
   * reported as finished.
   */
  async streamGraphic(kind: 'svg' | 'png'): Promise<void> {
    const graphic = this.host.graphicSource();
    if (!graphic) {
      this.host.reportError('no-graphic', '没有可导出的图形');
      return;
    }

    let bytes: Uint8Array;
    let mime: string;
    let extension: string;

    if (kind === 'svg') {
      const sanitized = sanitizeSvg(graphic.svg);
      if (!sanitized.ok || !sanitized.svg) {
        this.host.reportError('svg-sanitize-failed', sanitized.reason ?? 'unknown');
        return;
      }
      bytes = new TextEncoder().encode(sanitized.svg);
      mime = 'image/svg+xml';
      extension = 'svg';
    } else {
      const sanitized = sanitizeSvg(graphic.svg);
      if (!sanitized.ok || !sanitized.svg) {
        this.host.reportError('svg-sanitize-failed', sanitized.reason ?? 'unknown');
        return;
      }
      try {
        const blob = await rasterizeSvg(sanitized.svg, {
          width: graphic.width,
          height: graphic.height,
          scale: 2,
          background: null,
        });
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch (error) {
        this.host.reportError(
          'png-failed',
          `PNG 生成失败（可在“导出图形为 SVG”中获取矢量结果）：${error instanceof Error ? error.message : 'unknown'}`,
        );
        return;
      }
      mime = 'image/png';
      extension = 'png';
    }

    if (bytes.byteLength > LIMITS.exportMaxBytes) {
      this.host.reportError('export-too-large', '导出内容超过体积上限');
      return;
    }

    this.state = 'streaming';
    const name = `${graphic.label.slice(0, 40)}.${extension}`;
    let exportId: string;
    try {
      const response = await this.host.bridge.request<{ exportId: string }>(
        'exportBegin',
        {
          kind,
          mime,
          name,
          totalBytes: bytes.byteLength,
        },
        this.host.context(),
      );
      exportId = response.exportId;
    } catch (error) {
      this.state = 'failed';
      this.host.reportError('export-begin-failed', error instanceof Error ? error.message : 'unknown');
      return;
    }

    const chunkSize = LIMITS.exportChunkChars;
    let index = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
      const base64 = toBase64(slice);
      try {
        await this.host.bridge.request('exportChunk', { exportId, index, data: base64 }, this.host.context());
      } catch (error) {
        await this.host.bridge
          .request('exportAbort', { exportId }, this.host.context())
          .catch(() => undefined);
        this.state = 'failed';
        this.host.reportError('export-chunk-failed', error instanceof Error ? error.message : 'unknown');
        return;
      }
      index += 1;
      if (index % 8 === 0) {
        this.host.notify(`正在写出导出文件… ${Math.round((offset / bytes.byteLength) * 100)}%`);
        await nextFrame();
      }
    }

    const digest = await sha256Hex(bytes);
    try {
      await this.host.bridge.request(
        'exportFinish',
        { exportId, sha256: digest, totalBytes: bytes.byteLength },
        this.host.context(),
      );
      this.state = 'done';
      this.host.notify('导出完成');
    } catch (error) {
      this.state = 'failed';
      this.host.reportError('export-finish-failed', error instanceof Error ? error.message : 'unknown');
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!crypto?.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function waitForImages(root: HTMLElement, budgetMs: number): Promise<number> {
  const images = Array.from(root.querySelectorAll('img'));
  if (images.length === 0) return 0;
  const deadline = performance.now() + budgetMs;
  const pending = images.filter((image) => !image.complete);
  if (pending.length === 0) return 0;

  await Promise.race([
    Promise.all(
      pending.map(
        (image) =>
          new Promise<void>((resolve) => {
            const done = (): void => resolve();
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
          }),
      ),
    ),
    new Promise<void>((resolve) => window.setTimeout(resolve, budgetMs)),
  ]);
  return images.filter((image) => !image.complete && performance.now() > deadline).length;
}

async function waitForFonts(): Promise<void> {
  const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    await Promise.race([fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 3000))]);
  }
}

async function stabiliseLayout(root: HTMLElement, budgetMs: number): Promise<void> {
  const deadline = performance.now() + budgetMs;
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await nextFrame();
    const height = root.scrollHeight;
    if (height === previous) return;
    previous = height;
    if (performance.now() > deadline) return;
  }
}
