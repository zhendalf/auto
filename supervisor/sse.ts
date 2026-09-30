// Server-Sent Events broadcaster.
//
// Tracks a set of subscribers (each backed by a ReadableStream controller),
// fans out events as `event: <name>\ndata: <json>\n\n` framed messages,
// emits a `: ping\n\n` heartbeat at a configurable interval (default 15s)
// so proxies don't time out idle connections, and cleanly closes all
// subscribers on stop().
//
// Backpressure: the number of subscribers is capped, and a subscriber that
// stops reading (its queue grows past `maxQueuedChunks`) is dropped instead
// of letting its backlog grow without bound.

const ENCODER = new TextEncoder();

type Controller = ReadableStreamDefaultController<Uint8Array>;

export type SSEBroadcasterOptions = {
  /** Heartbeat interval in ms. Default 15_000. Tests may set this small. */
  heartbeatMs?: number;
  /** Maximum concurrent subscribers; further subscribes get 503. Default 64. */
  maxSubscribers?: number;
  /** Drop a subscriber once this many chunks are queued unread. Default 100. */
  maxQueuedChunks?: number;
};

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_MAX_SUBSCRIBERS = 64;
const DEFAULT_MAX_QUEUED_CHUNKS = 100;

export class SSEBroadcaster {
  private readonly subs = new Set<Controller>();
  private readonly heartbeatMs: number;
  private readonly maxSubscribers: number;
  private readonly maxQueuedChunks: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts?: SSEBroadcasterOptions) {
    this.heartbeatMs = opts?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxSubscribers = opts?.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
    this.maxQueuedChunks = opts?.maxQueuedChunks ?? DEFAULT_MAX_QUEUED_CHUNKS;
    this.startHeartbeat();
  }

  subscriberCount(): number {
    return this.subs.size;
  }

  /**
   * Add a subscriber. Returns a Response with `text/event-stream` body that
   * streams events to the client. The subscriber is removed when the client
   * disconnects (cancel) or on `stop()`. Returns 503 when the broadcaster is
   * stopped or the subscriber cap is reached.
   */
  subscribe(_req: Request): Response {
    if (this.stopped) {
      return new Response("broadcaster stopped", { status: 503 });
    }
    if (this.subs.size >= this.maxSubscribers) {
      return new Response(JSON.stringify({ error: "too_many_subscribers" }), {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "5",
        },
      });
    }
    const self = this;
    let registered: Controller | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self.subs.add(controller);
        registered = controller;
        // Initial connected comment so the client knows the stream is live.
        try {
          controller.enqueue(ENCODER.encode(`: connected\n\n`));
        } catch {
          // If even the first write fails, drop immediately.
          self.subs.delete(controller);
        }
      },
      cancel() {
        if (registered) self.subs.delete(registered);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /**
   * Fan out an event to all current subscribers. Drops failed writes from
   * the subscriber set; never throws to callers.
   */
  emit(event: string, data: unknown): void {
    if (this.stopped) return;
    if (this.subs.size === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch {
      // Non-serializable payload — emit a placeholder rather than crashing.
      payload = JSON.stringify({ error: "serialize_failed" });
    }
    this.broadcast(ENCODER.encode(`event: ${event}\ndata: ${payload}\n\n`));
  }

  /**
   * Close every subscriber but keep accepting new ones. Used when the API
   * token is rotated so streams authenticated with the old credential end.
   */
  disconnectAll(): void {
    for (const controller of [...this.subs]) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
    this.subs.clear();
  }

  /** Cleanly close all subscribers and stop the heartbeat. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.disconnectAll();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private broadcast(frame: Uint8Array): void {
    for (const controller of [...this.subs]) {
      try {
        // desiredSize goes negative once a subscriber's queue exceeds its
        // high-water mark; a very negative value means it stopped reading.
        const backlog = controller.desiredSize;
        if (backlog !== null && backlog <= -this.maxQueuedChunks) {
          this.subs.delete(controller);
          try {
            controller.close();
          } catch {
            // already closed
          }
          continue;
        }
        controller.enqueue(frame);
      } catch {
        // Subscriber closed under us — drop it.
        this.subs.delete(controller);
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const beat = ENCODER.encode(`: ping\n\n`);
    this.heartbeatTimer = setInterval(() => {
      if (this.subs.size === 0) return;
      this.broadcast(beat);
    }, this.heartbeatMs);
    // Don't keep the event loop alive just for the heartbeat.
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }
}
