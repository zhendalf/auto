import { createSseParser } from "./sseParse.ts";

/**
 * The supervisor's `/events` stream read with `fetch` so the request can carry
 * `Authorization: Bearer` (an EventSource cannot set headers, and a token in a
 * URL would end up in logs) and so the HTTP status is visible. Free of the DOM
 * so it can be tested with a fake `fetch`; `api/sse.ts` wires it to the page.
 */

export type SSEEvent = { name: string; data: unknown };

/** Where the event stream is right now; drive a status indicator from this. */
export type ConnectionState = "connecting" | "open" | "retrying" | "unauthorized";

export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "run.queued",
  "run.started",
  "run.finished",
  "run.skipped",
  "config.reloaded",
  "config.error",
  "degraded.exited",
]);

export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 30_000;
/** The supervisor pings every 15 s; three missed pings means the stream is dead. */
export const STALL_MS = 45_000;

/** Exponential backoff with a cap and jitter: ~0.5s, 1s, 2s, ... up to ~30s. */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  base: number = BASE_BACKOFF_MS,
  max: number = MAX_BACKOFF_MS,
): number {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return ceiling * (0.5 + random() * 0.5);
}

export type EventStreamOptions = {
  url: string;
  /** Read on every (re)connect, so the current token is always the one sent. */
  getToken: () => string;
  onEvent: (ev: SSEEvent) => void;
  /**
   * Called every time the stream (re)opens. Events emitted while the browser
   * was disconnected are gone, so use it to invalidate every cached query.
   */
  onOpen?: () => void;
  onState?: (state: ConnectionState) => void;
  fetchImpl?: typeof fetch;
  /** Subscribe to "worth retrying now" signals (the browser's `online`); returns the unsubscribe. */
  wakeOn?: (wake: () => void) => () => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  stallMs?: number;
  random?: () => number;
};

export type EventStream = {
  close: () => void;
  /** Reconnect immediately, including after `unauthorized`. */
  reconnect: () => void;
};

/**
 * Connects and keeps reconnecting: exponential backoff (capped near 30 s, with
 * jitter) after any failure or stall, `onOpen` on every open. A 401 stops the
 * loop and reports `unauthorized`, because retrying cannot help until the page
 * (which embeds the token) is reloaded.
 */
export function createEventStream(opts: EventStreamOptions): EventStream {
  const doFetch = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const stallMs = opts.stallMs ?? STALL_MS;
  let closed = false;
  let generation = 0;
  let abort: AbortController | null = null;
  let wake: (() => void) | null = null;

  const emit = (gen: number, state: ConnectionState) => {
    if (!closed && gen === generation) opts.onState?.(state);
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const done = () => {
        clearTimeout(timer);
        unsubscribe?.();
        wake = null;
        resolve();
      };
      timer = setTimeout(done, ms);
      unsubscribe = opts.wakeOn?.(done);
      wake = done;
    });

  const run = async (gen: number): Promise<void> => {
    let attempt = 0;
    while (!closed && gen === generation) {
      emit(gen, attempt === 0 ? "connecting" : "retrying");
      const ac = new AbortController();
      abort = ac;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ac.abort(), stallMs);
      };
      arm();
      try {
        const res = await doFetch(opts.url, {
          method: "GET",
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${opts.getToken()}` },
          credentials: "omit",
          cache: "no-store",
          signal: ac.signal,
        });
        if (res.status === 401) {
          emit(gen, "unauthorized");
          void res.body?.cancel().catch(() => {});
          return;
        }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        if (closed || gen !== generation) return;
        arm();
        attempt = 0;
        emit(gen, "open");
        opts.onOpen?.();

        const parser = createSseParser((frame) => {
          if (!KNOWN_EVENTS.has(frame.event)) return;
          let data: unknown;
          try {
            data = JSON.parse(frame.data);
          } catch {
            return; // malformed frame: skip it, keep the stream
          }
          opts.onEvent({ name: frame.event, data });
        });
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm(); // any bytes, heartbeat comments included, prove the stream is alive
          parser.push(value);
        }
        parser.end();
      } catch {
        // Network error, stall abort or close(): handled below.
      } finally {
        clearTimeout(stallTimer);
      }
      if (closed || gen !== generation) return;
      attempt += 1;
      emit(gen, "retrying");
      await pause(backoffDelay(attempt, opts.random, opts.baseBackoffMs, opts.maxBackoffMs));
    }
  };

  const start = () => {
    generation += 1;
    void run(generation);
  };
  start();

  return {
    close: () => {
      closed = true;
      abort?.abort();
      wake?.();
    },
    reconnect: () => {
      if (closed) return;
      abort?.abort();
      wake?.();
      start();
    },
  };
}
