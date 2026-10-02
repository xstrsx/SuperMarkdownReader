/**
 * Control channel between the trusted page and native code.
 *
 * Only bounded control messages travel here: document text is fetched from the
 * local session route and export payloads are streamed as base64 chunks. Every
 * request carries the session id and generation, and native rejects anything that
 * does not match the active document.
 */
export interface Envelope {
  v: number;
  id?: string;
  method: string;
  session?: string;
  generation?: number;
  params?: unknown;
  replyTo?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface BridgeContext {
  sessionId: string | null;
  generation: number;
}

export type PushHandler = (method: string, params: Record<string, unknown>) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class BridgeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

export class Bridge {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private pushHandler: PushHandler | null = null;

  constructor(private readonly host: LiteDocHost) {
    host.onmessage = (event: { data: string }) => this.receive(event.data);
  }

  onPush(handler: PushHandler): void {
    this.pushHandler = handler;
  }

  request<T>(method: string, params: Record<string, unknown> = {}, context?: BridgeContext): Promise<T> {
    const id = `r${++this.counter}`;
    const envelope: Envelope = { v: 1, id, method, params };
    if (context?.sessionId) envelope.session = context.sessionId;
    if (context && context.generation >= 0) envelope.generation = context.generation;

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`bridge request timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.post(envelope);
    });
  }

  /** Fire-and-forget notification; used for progress and error reporting. */
  notify(method: string, params: Record<string, unknown> = {}, context?: BridgeContext): void {
    const envelope: Envelope = { v: 1, method, params };
    if (context?.sessionId) envelope.session = context.sessionId;
    if (context && context.generation >= 0) envelope.generation = context.generation;
    this.post(envelope);
  }

  private post(envelope: Envelope): void {
    const text = JSON.stringify(envelope);
    if (text.length > 64 * 1024) {
      throw new BridgeError('bridge message exceeds the size cap');
    }
    this.host.postMessage(text);
  }

  private receive(raw: string): void {
    if (typeof raw !== 'string' || raw.length > 64 * 1024) return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (envelope.v !== 1) return;

    if (envelope.replyTo) {
      const pending = this.pending.get(envelope.replyTo);
      if (!pending) return;
      this.pending.delete(envelope.replyTo);
      window.clearTimeout(pending.timer);
      if (envelope.ok) {
        pending.resolve(envelope.result ?? {});
      } else {
        pending.reject(new BridgeError(envelope.error?.message ?? 'bridge request failed'));
      }
      return;
    }

    if (envelope.method) {
      const params = (envelope.params ?? {}) as Record<string, unknown>;
      this.pushHandler?.(envelope.method, params);
    }
  }

  dispose(): void {
    for (const [, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(new BridgeError('bridge disposed'));
    }
    this.pending.clear();
    this.pushHandler = null;
  }
}

export function ready(): boolean {
  return typeof window.litedoc !== 'undefined' && window.litedoc !== null;
}
