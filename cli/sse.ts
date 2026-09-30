// Minimal SSE client used by `auto log --follow` and `auto run --follow`.
//
// Connects to `${url}` with `Accept: text/event-stream` and an
// `Authorization: Bearer` header (the token never travels in the URL), parses
// chunks into `event:`/`data:` frames, and invokes a per-event callback.
//
// Reliability:
//   - reconnects with backoff (250ms initial, doubling, capped at 5s); the
//     backoff resets as soon as a connection opens, not only on a clean end.
//   - stall detection: if no bytes (events or the supervisor's 15s `: ping`
//     comments) arrive for three heartbeats the connection is dropped and
//     re-established.
//   - `onOpen` fires after every (re)connect so callers can re-check state
//     that they may have missed while disconnected (e.g. a run that finished).
//   - a 401/403 stops the client unless the token is supplied as a function
//     (re-read on every attempt, so a rotated token is picked up).
//
// Closing is cooperative: callers invoke `.close()`. The internal fetch is
// abort-driven so close is immediate.

export type SSEEvent = {
  /** Event name (defaults to "message" if `event:` is absent). */
  event: string;
  /** Raw data payload (multi-line `data:` joined with `\n`). */
  data: string;
};

export type SSEClientOpts = {
  /** Events URL, e.g. `${baseUrl}/events`. A legacy `?token=` query is moved into the header. */
  url: string;
  /** Origin to send (must match supervisor's allowed loopback). */
  origin: string;
  /** API token, or a function re-evaluated on every connection attempt. */
  token?: string | (() => string);
  onEvent: (ev: SSEEvent) => void;
  /** Called when the connection becomes open (initial + each reconnect). */
  onOpen?: () => void;
  /** Called for each connection-level error. Backoff happens automatically. */
  onError?: (err: unknown) => void;
  /** Supervisor heartbeat interval; the stall limit is three of these. Default 15_000. */
  heartbeatMs?: number;
};

export type SSEState = "idle" | "connecting" | "open" | "retrying" | "unauthorized" | "closed";

/** Thrown to `onError` when the supervisor answers the stream request with a non-2xx status. */
export class SSEHttpError extends Error {
  constructor(public readonly status: number) {
    super(`SSE bad status ${status}`);
    this.name = "SSEHttpError";
  }
}

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const STALL_HEARTBEATS = 3;
const START_TIMEOUT_MS = 5_000;

export class SSEClient {
  private readonly opts: SSEClientOpts;
  private readonly url: string;
  private readonly legacyToken: string | null;
  private readonly stallMs: number;
  private abort: AbortController | null = null;
  private closed = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private current: SSEState = "idle";
  private firstAttempt: ((opened: boolean) => void) | null = null;
  private wake: (() => void) | null = null;

  constructor(opts: SSEClientOpts) {
    this.opts = opts;
    const parsed = splitLegacyToken(opts.url);
    this.url = parsed.url;
    this.legacyToken = parsed.token;
    this.stallMs = (opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS) * STALL_HEARTBEATS;
  }

  get state(): SSEState {
    return this.current;
  }

  /**
   * Begin connecting and wait for the first attempt to settle: resolves `true`
   * once the stream is open, `false` if the first attempt failed or did not
   * open within `timeoutMs`. Reconnects continue in the background either way.
   */
  async start(timeoutMs = START_TIMEOUT_MS): Promise<boolean> {
    if (this.closed) return false;
    const first = new Promise<boolean>((res) => {
      this.firstAttempt = res;
    });
    void this.connectLoop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((res) => {
      timer = setTimeout(() => res(false), timeoutMs);
    });
    try {
      return await Promise.race([first, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.closed = true;
    this.current = "closed";
    this.settleFirst(false);
    this.wake?.();
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        // ignore
      }
      this.abort = null;
    }
  }

  private settleFirst(opened: boolean): void {
    const fn = this.firstAttempt;
    this.firstAttempt = null;
    fn?.(opened);
  }

  private token(): string | null {
    const t = this.opts.token;
    if (typeof t === "function") return t();
    return t ?? this.legacyToken;
  }

  private async connectLoop(): Promise<void> {
    while (!this.closed) {
      this.current = "connecting";
      try {
        await this.connectOnce();
        // The stream ended cleanly (server restart or shutdown); reconnect.
      } catch (err) {
        if (this.closed) return;
        this.settleFirst(false);
        this.opts.onError?.(err);
        if (
          err instanceof SSEHttpError &&
          (err.status === 401 || err.status === 403) &&
          typeof this.opts.token !== "function"
        ) {
          // The same credential will be refused again.
          this.current = "unauthorized";
          return;
        }
      }
      if (this.closed) return;
      this.current = "retrying";
      await new Promise<void>((res) => {
        const timer = setTimeout(res, this.backoffMs);
        this.wake = () => {
          clearTimeout(timer);
          res();
        };
      });
      this.wake = null;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private async connectOnce(): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        ac.abort();
      }, this.stallMs);
    };
    arm();
    try {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        origin: this.opts.origin,
      };
      const token = this.token();
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(this.url, { method: "GET", headers, signal: ac.signal });
      if (!res.ok || !res.body) {
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        throw new SSEHttpError(res.status);
      }
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.current = "open";
      this.settleFirst(true);
      this.opts.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) return;
        arm();
        buffer += decoder.decode(value, { stream: true });
        // Split on the SSE record delimiter "\n\n". Any partial trailing
        // record stays in `buffer` for the next read.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseFrame(raw);
          if (ev) this.opts.onEvent(ev);
        }
      }
    } catch (err) {
      if (stalled) throw new Error("SSE stream stalled (no data for three heartbeats)");
      throw err;
    } finally {
      clearTimeout(stallTimer);
    }
  }
}

/** Pull a legacy `?token=` query parameter out of the URL so it is sent as a header instead. */
function splitLegacyToken(raw: string): { url: string; token: string | null } {
  try {
    const u = new URL(raw);
    const token = u.searchParams.get("token");
    if (token === null) return { url: raw, token: null };
    u.searchParams.delete("token");
    return { url: u.toString(), token };
  } catch {
    return { url: raw, token: null };
  }
}

function parseFrame(raw: string): SSEEvent | null {
  // Comment lines (start with `:`) are heartbeats; ignore.
  // SSE spec allows multiple `data:` lines per record (joined with \n).
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // Trim a single leading space per spec.
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      // We ignore `id:` and `retry:` for now — supervisor doesn't send them.
    }
  }
  if (dataLines.length === 0 && event === "message") return null;
  return { event, data: dataLines.join("\n") };
}
