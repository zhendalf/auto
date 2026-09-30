// Shared "watch a run until it finishes" logic for `auto run` and
// `auto log --follow`.
//
// The log endpoint is the source of truth: every poll reads new bytes from a
// byte offset and reports the run's state in X-Run-State, so a run that
// finished before the event stream was live is still noticed on the next
// poll. The SSE stream is only a wake-up call: after every (re)connect, and
// when a `run.finished` event for this run arrives, the run is re-fetched
// through the API immediately. If the supervisor stays unreachable for longer
// than the grace period the follower gives up (the caller exits 3).

import { ApiError, SupervisorTimeout, SupervisorUnreachable, TokenMissing, type ApiClient } from "./client.ts";
import { SSEClient } from "./sse.ts";
import { TERMINAL_STATES, globals, printJson, writeOut } from "./runtime.ts";

export type FollowResult =
  | { kind: "finished"; state: string; exitCode: number | null; durationMs: number | null }
  | { kind: "detached" }
  | { kind: "unreachable" };

export type FollowOptions = {
  /** Full run id. */
  runId: string;
  /** Bytes of the log the caller has already printed. */
  offset?: number;
  /** Receives decoded log text as it arrives. */
  out: (text: string) => void;
  /** Log poll interval. Default 300 ms. */
  pollMs?: number;
  /** Give up after the supervisor has been unreachable this long. Default 8 s. */
  unreachableGraceMs?: number;
  /** Aborting stops the follow with `detached` (Ctrl-C). */
  signal?: AbortSignal;
  /** Set to false to skip the event stream (polling only). */
  useSse?: boolean;
};

const DEFAULT_POLL_MS = 300;
const DEFAULT_UNREACHABLE_GRACE_MS = 8_000;
/** Extra reads after a terminal state, in case the last bytes land just after it. */
const FINAL_DRAIN_READS = 3;

export async function followRun(client: ApiClient, opts: FollowOptions): Promise<FollowResult> {
  const { runId, out } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const grace = opts.unreachableGraceMs ?? DEFAULT_UNREACHABLE_GRACE_MS;
  const decoder = new TextDecoder("utf-8");
  let offset = opts.offset ?? 0;

  // Wake-ups from the event stream.
  let recheck = true; // verify through the API on the first pass, too
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    recheck = true;
    wake?.();
  };

  let sse: SSEClient | null = null;
  if (opts.useSse !== false) {
    sse = new SSEClient({
      url: client.eventsUrl(),
      origin: client.baseUrl,
      // Re-read the token file on every attempt so a rotated token is picked up.
      token: () => client.refreshToken(),
      // Anything may have happened while disconnected: re-fetch the run.
      onOpen: nudge,
      onEvent: (ev) => {
        if (ev.event !== "run.finished" && ev.event !== "run.skipped") return;
        try {
          const obj = JSON.parse(ev.data) as { run_id?: string };
          if (obj.run_id === runId) nudge();
        } catch {
          // ignore malformed payloads
        }
      },
      onError: () => {
        // Reconnects happen on their own; polling keeps working meanwhile.
      },
    });
    void sse.start();
  }

  const onAbort = (): void => wake?.();
  opts.signal?.addEventListener("abort", onAbort);

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = null;
    });

  const drain = async (): Promise<{ size: number; state: string | null; grew: boolean }> => {
    const chunk = await client.runLogFrom(runId, offset);
    if (chunk.outOfRange) {
      // The log shrank (replaced or truncated); carry on from its new end.
      offset = chunk.size;
      return { size: chunk.size, state: chunk.state, grew: false };
    }
    if (chunk.bytes.length > 0) {
      offset += chunk.bytes.length;
      out(decoder.decode(chunk.bytes, { stream: true }));
    }
    return { size: chunk.size, state: chunk.state, grew: chunk.bytes.length > 0 };
  };

  let downSince: number | null = null;
  try {
    while (!opts.signal?.aborted) {
      try {
        const first = await drain();
        let state = first.state;
        if (recheck || state === null) {
          recheck = false;
          state = (await client.run(runId)).state;
        }
        downSince = null;

        if (TERMINAL_STATES.has(state)) {
          // Terminal: pick up anything written just before the state changed.
          for (let i = 0; i < FINAL_DRAIN_READS; i++) {
            const more = await drain();
            if (!more.grew) break;
          }
          const tail = decoder.decode();
          if (tail) out(tail);
          const detail = await client.run(runId);
          return {
            kind: "finished",
            state: detail.state,
            exitCode: detail.exit_code,
            durationMs: detail.duration_ms,
          };
        }
      } catch (err) {
        // A supervisor that is restarting can also leave the token file missing for a moment.
        const transient =
          err instanceof SupervisorUnreachable ||
          err instanceof SupervisorTimeout ||
          err instanceof TokenMissing ||
          (err instanceof ApiError && err.status >= 500);
        if (!transient) throw err;
        const now = Date.now();
        downSince ??= now;
        if (now - downSince >= grace) return { kind: "unreachable" };
      }
      await sleep(pollMs);
    }
    return { kind: "detached" };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    sse?.close();
  }
}

/**
 * Where followed log text goes. Text mode writes it to stdout as-is; --json
 * mode writes one `{"run_id", "line"}` object per complete line, so stdout
 * stays machine-readable.
 */
export function createLogSink(runId: string): { write: (text: string) => void; end: () => void } {
  let partial = "";
  let lastChar = "\n";
  const json = globals().json;
  return {
    write(text: string): void {
      if (text.length === 0) return;
      if (!json) {
        writeOut(text);
        lastChar = text[text.length - 1]!;
        return;
      }
      partial += text;
      let idx: number;
      while ((idx = partial.indexOf("\n")) !== -1) {
        printJson({ run_id: runId, line: partial.slice(0, idx).replace(/\r$/, "") });
        partial = partial.slice(idx + 1);
      }
    },
    end(): void {
      if (json) {
        if (partial.length > 0) printJson({ run_id: runId, line: partial });
        partial = "";
      } else if (lastChar !== "\n") {
        // Keep the next status line from being glued to the worker's last line.
        writeOut("\n");
        lastChar = "\n";
      }
    },
  };
}
