import type { LogChunk } from "../api/types.ts";
import { ApiError, describeError, isClientError } from "./errors.ts";
import { LogBuffer } from "./logBuffer.ts";
import { isTerminalState } from "./runState.ts";

/** Where a follower reads from: the API's log endpoint, or a fake in tests. */
export type LogSource = {
  /** Size and run state only (HEAD). */
  info(runId: string): Promise<LogChunk>;
  /** Bytes from `offset` on. */
  chunk(runId: string, offset: number): Promise<LogChunk>;
};

export type FollowerLimits = {
  /** Logs above this size are opened at their end. */
  largeBytes: number;
  /** How much of the end of a large log is loaded first. */
  tailBytes: number;
  /** Text kept while following; older lines are dropped from the top. */
  keepChars: number;
  /** A single poll larger than this only shows its last `keepChars` bytes. */
  maxPollBytes: number;
  /** The most "Load full log" will put on the page. */
  fullMaxBytes: number;
  /** Delay between polls of an active run. */
  pollMs: number;
};

export const DEFAULT_LIMITS: FollowerLimits = {
  largeBytes: 1024 * 1024,
  tailBytes: 256 * 1024,
  keepChars: 1_000_000,
  maxPollBytes: 4 * 1024 * 1024,
  fullMaxBytes: 8 * 1024 * 1024,
  pollMs: 1000,
};

export type FollowerNotice =
  /** No log file (yet): a queued or skipped run, or one that wrote nothing. Not an error. */
  | { kind: "none"; reason: "no_log" | "log_missing" }
  | { kind: "error"; message: string; retrying: boolean }
  | null;

export type StepResult = {
  /** Wait this long, then step again. Null: stop following. */
  delayMs: number | null;
  /** The buffer or the notice changed: re-render. */
  changed: boolean;
};

/**
 * The state machine behind the log viewer, free of React so it can be tested.
 * `step` reads whatever is new since the last call: only the new bytes
 * (`?offset=`), decoded as a stream so multi-byte characters can straddle two
 * reads. It tells the caller when to poll again and when to stop (the run is
 * over, or the error can not be retried).
 */
export class LogFollower {
  buffer: LogBuffer;
  /** Total size of the log file at the last read. */
  total = 0;
  /** Byte offset the view starts at; 0 unless a large log was opened at its end. */
  tailStart = 0;
  notice: FollowerNotice = null;

  private offset = 0;
  private initialized = false;
  private dropPartial = false;
  // "Load full log" was used: a read that big is deliberate and must be kept whole.
  private full = false;
  private failures = 0;
  private decoder = new TextDecoder("utf-8");

  constructor(
    private readonly runId: string,
    private readonly source: LogSource,
    private readonly limits: FollowerLimits = DEFAULT_LIMITS,
  ) {
    this.buffer = new LogBuffer(limits.keepChars);
  }

  /** Whether "Load full log" can show the whole thing (it fits the page budget). */
  get canLoadFull(): boolean {
    return this.cutAtTop && this.total > 0 && this.total <= this.limits.fullMaxBytes;
  }

  /** Whether the start of the log is not on screen (opened at the end, or trimmed while following). */
  get cutAtTop(): boolean {
    return this.tailStart > 0 || this.buffer.dropped > 0;
  }

  /**
   * For runs that cannot have a log yet (queued) or ever (skipped): show the
   * calm "no log" notice without asking the server, which would only answer 404.
   * Returns whether the notice changed.
   */
  noLogExpected(): boolean {
    return this.setNotice({ kind: "none", reason: "no_log" });
  }

  /** Discard what is loaded and read the whole log from the start, with room for all of it. */
  loadFull(): void {
    this.buffer = new LogBuffer(this.limits.fullMaxBytes);
    this.decoder = new TextDecoder("utf-8");
    this.offset = 0;
    this.tailStart = 0;
    this.dropPartial = false;
    this.full = true;
    this.initialized = true;
  }

  /**
   * One poll. `active` is whether the run can still write (queued or running);
   * `isStale` reports that a newer poller took over, so this result must be
   * thrown away rather than applied twice.
   */
  async step(active: boolean, isStale: () => boolean = () => false): Promise<StepResult> {
    try {
      if (!this.initialized) {
        try {
          const info = await this.source.info(this.runId);
          if (isStale()) return { delayMs: null, changed: false };
          this.total = info.size;
          if (info.kind === "data" && info.size > this.limits.largeBytes) {
            this.offset = info.size - this.limits.tailBytes;
            this.tailStart = this.offset;
            this.dropPartial = true;
          }
        } catch (err) {
          // Not fatal: read from the start and let the real read report it.
          if (err instanceof ApiError && isClientError(err) && err.status !== 404) throw err;
          if (isStale()) return { delayMs: null, changed: false };
        }
        this.initialized = true;
      }

      const chunk = await this.source.chunk(this.runId, this.offset);
      if (isStale()) return { delayMs: null, changed: false };
      this.failures = 0;

      if (chunk.kind === "reset") {
        // The log shrank (rotated or rewritten): start over.
        this.buffer.clear();
        this.decoder = new TextDecoder("utf-8");
        this.offset = 0;
        this.tailStart = 0;
        return { delayMs: 0, changed: true };
      }

      if (chunk.kind === "none") {
        const changed = this.setNotice({ kind: "none", reason: chunk.reason });
        return { delayMs: active ? this.limits.pollMs + 500 : null, changed };
      }

      let changed = this.setNotice(null);
      this.total = chunk.size;
      if (chunk.bytes.length > 0) {
        this.offset += chunk.bytes.length;
        this.append(chunk.bytes);
        changed = true;
      }
      // The header carries the state at read time; it beats the caller's flag,
      // which can lag a moment behind an event.
      const stillGoing = active && !isTerminalState(chunk.state);
      return { delayMs: stillGoing ? this.limits.pollMs : null, changed };
    } catch (err) {
      if (isStale()) return { delayMs: null, changed: false };
      this.failures += 1;
      const retryable = !(err instanceof ApiError) || !isClientError(err);
      const d = describeError(err);
      const changed = this.setNotice({ kind: "error", message: d.message || d.title, retrying: retryable });
      return { delayMs: retryable ? Math.min(10_000, 1000 * 2 ** this.failures) : null, changed };
    }
  }

  private setNotice(next: FollowerNotice): boolean {
    const prev = this.notice;
    this.notice = next;
    if (prev === next) return false;
    if (prev && next && prev.kind === next.kind) {
      if (prev.kind === "none" && next.kind === "none") return prev.reason !== next.reason;
      if (prev.kind === "error" && next.kind === "error") return prev.message !== next.message;
    }
    return true;
  }

  private append(bytes: Uint8Array): void {
    let data = bytes;
    if (data.length > this.limits.maxPollBytes && !this.full) {
      // More arrived at once than the view can use (a tab left in the
      // background, say): only the end matters, so skip decoding the rest and
      // re-sync on a line start. What was on screen is not contiguous with this
      // any more, so it goes, and the view is marked as starting mid-log
      // (tailStart) so the "end of a large log" note and Load full log show.
      data = data.subarray(data.length - this.limits.keepChars);
      this.decoder = new TextDecoder("utf-8");
      this.dropPartial = true;
      this.buffer.clear();
      this.tailStart = Math.max(1, this.offset - data.length);
    }
    let text = this.decoder.decode(data, { stream: true });
    if (this.dropPartial && text) {
      const nl = text.indexOf("\n");
      if (nl === -1) text = "";
      else {
        text = text.slice(nl + 1);
        this.dropPartial = false;
      }
    }
    this.buffer.append(text);
  }
}
