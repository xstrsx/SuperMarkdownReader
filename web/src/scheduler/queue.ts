import { LIMITS } from '../security/limits';

/**
 * Bounded rendering queue.
 *
 * * concurrency is 1 by default: Mermaid and SmilesDrawer both mutate shared
 *   engine state, and the plan asks for a stable single-file rendering order;
 * * work is only started for blocks near the viewport (one screen of prefetch),
 *   and every task re-checks the generation before it touches the DOM, so a
 *   result from a replaced document is dropped instead of overwriting the new one;
 * * `drain()` is what export preparation uses to complete off-screen content, and
 *   it reports how much was left when its budget expired instead of pretending
 *   that everything finished.
 */
export type BlockTask = (block: HTMLElement, generation: number) => Promise<void>;

interface QueueEntry {
  block: HTMLElement;
  generation: number;
  handler: string;
}

export interface DrainResult {
  pending: number;
  completed: number;
  timedOut: boolean;
}

export class RenderScheduler {
  private readonly queue: QueueEntry[] = [];
  private readonly known = new WeakSet<HTMLElement>();
  private observer: IntersectionObserver | null = null;
  private running = 0;
  private paused = false;
  private generation = 0;
  private completed = 0;
  private readonly handlers = new Map<string, BlockTask>();

  constructor(private readonly concurrency: number = 1) {}

  register(handler: string, task: BlockTask): void {
    this.handlers.set(handler, task);
  }

  start(root: HTMLElement, generation: number): void {
    this.stop();
    this.generation = generation;
    this.paused = false;
    this.completed = 0;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const block = entry.target as HTMLElement;
          this.observer?.unobserve(block);
          this.enqueue(block);
        }
      },
      { root: null, rootMargin: `${LIMITS.imagePrefetchMarginPx}px 0px ${LIMITS.imagePrefetchMarginPx}px 0px`, threshold: 0 },
    );
    for (const block of Array.from(root.querySelectorAll<HTMLElement>('[data-ld-kind]'))) {
      if (this.known.has(block)) continue;
      block.dataset.ldScheduled = '1';
      this.observer.observe(block);
    }
  }

  /** Adds a block that was inserted after `start` (batched insertion). */
  observe(block: HTMLElement): void {
    if (!this.observer || this.known.has(block)) return;
    this.observer.observe(block);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.queue.length = 0;
    this.running = 0;
    this.paused = false;
  }

  isIdle(): boolean {
    return this.running === 0 && this.queue.length === 0;
  }

  pendingCount(): number {
    return this.queue.length + this.running;
  }

  private enqueue(block: HTMLElement): void {
    const kind = block.dataset.ldKind ?? '';
    const index = Number.parseInt(block.dataset.ldIndex ?? '-1', 10);
    this.known.add(block);
    block.dataset.ldIndex = String(index);
    this.queue.push({ block, generation: this.generation, handler: kind });
    this.pump();
  }

  private pump(): void {
    if (this.paused) return;
    while (this.running < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.generation !== this.generation) continue;
      const handler = this.handlers.get(entry.handler);
      if (!handler) continue;
      this.running += 1;
      handler(entry.block, entry.generation)
        .catch(() => undefined)
        .finally(() => {
          this.running -= 1;
          this.completed += 1;
          this.pump();
        });
    }
  }

  /** Completes every known block, up to `budgetMs`. */
  async drain(budgetMs: number): Promise<DrainResult> {
    const started = performance.now();
    const previousPause = this.paused;
    this.paused = false;
    const before = this.completed;

    while (performance.now() - started < budgetMs) {
      if (this.isIdle() && this.queue.length === 0 && this.running === 0) {
        // Give lazy loaders one more turn in case a task enqueued another.
        await nextFrame();
        if (this.isIdle() && this.queue.length === 0) break;
      }
      this.pump();
      await nextFrame();
    }

    this.paused = previousPause;
    const pending = this.pendingCount();
    return {
      pending,
      completed: this.completed - before,
      timedOut: pending > 0,
    };
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function idle(): Promise<void> {
  return new Promise((resolve) => {
    const anyWindow = window as unknown as { requestIdleCallback?: (cb: () => void) => number };
    if (typeof anyWindow.requestIdleCallback === 'function') {
      anyWindow.requestIdleCallback(() => resolve());
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}
