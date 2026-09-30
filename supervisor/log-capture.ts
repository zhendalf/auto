import { closeSync, existsSync, chmodSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

export type Secret = { name: string; value: string };

export type CaptureOptions = {
  /** Absolute path; parent dirs are created (mode 0700) on construction. */
  filePath: string;
  /** Hard cap on bytes written to disk (excluding the truncation marker). */
  maxBytes: number;
  /** Called once per chunk so callers can rotate the secret list. */
  secrets: () => Secret[];
  /**
   * Optional directory the log tree hangs off (the runs/ directory). Every
   * directory from here down to the file's parent is forced to 0700, which
   * also tightens directories an older version created with looser modes.
   * Without it only directories created by this capture are 0700.
   */
  dirRoot?: string;
};

const TRUNC_MARKER_PREFIX = "\n[truncated: ";
const TRUNC_MARKER_SUFFIX = " bytes elided]\n";

/**
 * Secrets shorter than this many characters are never redacted. A 1-3
 * character "secret" would match all over ordinary output and turn the log
 * into confetti while protecting nothing real; use a longer value if it needs
 * to be scrubbed. (Length is counted in characters, matching is on UTF-8 bytes.)
 */
const MIN_SECRET_CHARS = 4;

/** Stream label used when a caller does not say which stream a chunk is from. */
const DEFAULT_STREAM = "stdout";

type PreparedSecret = { name: string; bytes: Buffer; replacement: Buffer };

/**
 * Turn the configured secrets into byte patterns: drop values under the
 * minimum length, encode as UTF-8 (so non-ASCII secrets match the bytes the
 * worker actually wrote) and sort longest first so a longer value wins over a
 * shorter one that is its prefix.
 */
function prepareSecrets(secrets: Secret[]): PreparedSecret[] {
  const out: PreparedSecret[] = [];
  for (const s of secrets) {
    if (!s.value || s.value.length < MIN_SECRET_CHARS) continue;
    out.push({
      name: s.name,
      bytes: Buffer.from(s.value, "utf8"),
      replacement: Buffer.from(`[redacted:${s.name}]`, "utf8"),
    });
  }
  out.sort((a, b) => b.bytes.length - a.bytes.length);
  return out;
}

/**
 * Replace every occurrence of every secret in `data` in one left-to-right
 * pass (earliest match wins; at the same position the longest secret wins).
 * Working on bytes keeps non-ASCII secrets exact.
 *
 * `rest` is the unemitted suffix: when `holdTail` is set, the longest suffix of
 * the output that could still turn out to be the beginning of a secret (a
 * proper prefix of one, so at most maxSecretLen - 1 bytes) is withheld so the
 * next chunk can complete the match. With `holdTail` off everything is emitted.
 */
function redactBytes(
  data: Buffer,
  secrets: PreparedSecret[],
  holdTail: boolean,
): { out: Buffer; rest: Buffer } {
  if (secrets.length === 0) return { out: data, rest: EMPTY };

  // Everything from `limit` on might still be the beginning of a secret that
  // the next chunk completes, so no match may be committed at or after it (a
  // short secret matching there could be about to lose to a longer one).
  const limit = holdTail ? data.length - longestPartialPrefix(data, secrets) : data.length;

  const parts: Buffer[] = [];
  const nextAt = new Array<number>(secrets.length).fill(-2);
  let pos = 0;
  while (pos < data.length) {
    let best = -1;
    let bestIdx = Number.POSITIVE_INFINITY;
    for (let i = 0; i < secrets.length; i++) {
      if (nextAt[i] === -1) continue;
      if (nextAt[i]! < pos) nextAt[i] = data.indexOf(secrets[i]!.bytes, pos);
      const idx = nextAt[i]!;
      if (idx !== -1 && idx < bestIdx) {
        bestIdx = idx;
        best = i;
      }
    }
    if (best < 0 || bestIdx >= limit) break;
    parts.push(data.subarray(pos, bestIdx), secrets[best]!.replacement);
    pos = bestIdx + secrets[best]!.bytes.length;
  }

  let tail = data.subarray(pos);
  let rest: Buffer = EMPTY;
  if (holdTail) {
    const keep = longestPartialPrefix(tail, secrets);
    if (keep > 0) {
      rest = Buffer.from(tail.subarray(tail.length - keep));
      tail = tail.subarray(0, tail.length - keep);
    }
  }
  parts.push(tail);
  return { out: parts.length === 1 ? parts[0]! : Buffer.concat(parts), rest };
}

const EMPTY = Buffer.alloc(0);

/** Length of the longest suffix of `data` that is a proper prefix of some secret. */
function longestPartialPrefix(data: Buffer, secrets: PreparedSecret[]): number {
  let best = 0;
  for (const sec of secrets) {
    const max = Math.min(sec.bytes.length - 1, data.length);
    for (let k = max; k > best; k--) {
      if (data[data.length - k] !== sec.bytes[0]) continue;
      if (data.subarray(data.length - k).equals(sec.bytes.subarray(0, k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}

/**
 * Pure helper. Replaces every byte-exact occurrence of each secret value with
 * the literal `[redacted:<NAME>]` token.
 *
 * Skips secrets shorter than 4 characters or empty (see MIN_SECRET_CHARS).
 * Longer values take precedence over shorter ones at the same position.
 *
 * This is stateless: it only sees the one buffer it is given. LogCapture
 * layers a per-stream carry-over on top so secrets split across writes are
 * caught too.
 */
export function redactBuffer(buf: Buffer, secrets: Secret[]): Buffer {
  const prepared = prepareSecrets(secrets);
  if (prepared.length === 0) return buf;
  return redactBytes(buf, prepared, false).out;
}

/**
 * Bounded, serialized, redacting sink for one run's stdout/stderr.
 *
 * Single writer per file. Concurrent `write()` calls chain off a shared
 * promise so on-disk byte order matches call order. Once the cap is hit,
 * subsequent bytes are counted but discarded; on `close()` we append a
 * truncation marker recording how many bytes were dropped.
 *
 * Redaction works on bytes and survives chunk boundaries: each stream keeps
 * the trailing bytes that might be the start of a secret (at most
 * maxSecretLen - 1) and prepends them to that stream's next chunk; whatever is
 * still held is flushed, redacted, by `close()`. Streams are tracked
 * independently (stdout bytes never complete a secret begun on stderr) but all
 * use the same secret set. Redaction runs before the size cap, so a secret
 * straddling the cap is replaced by its token, never half-written.
 */
export class LogCapture {
  private fd: number | null = null;
  private writtenBytes = 0;
  private droppedBytes = 0;
  private closed = false;
  private hitCap = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly tails = new Map<string, Buffer>();
  private lastSecrets: Secret[] = [];
  private writeError: Error | null = null;

  constructor(private readonly opts: CaptureOptions) {
    ensureDirs(opts.filePath, opts.dirRoot);
    this.fd = openSync(opts.filePath, "w", 0o600);
    try {
      // The mode argument only applies when the file is created; make sure a
      // pre-existing file is not left readable by others.
      fchmodSync(this.fd, 0o600);
    } catch {
      // best-effort
    }
  }

  bytesWritten(): number {
    return this.writtenBytes;
  }

  truncated(): boolean {
    return this.hitCap;
  }

  /** First disk write error, if any (later output is then dropped). */
  error(): Error | null {
    return this.writeError;
  }

  /**
   * `stream` names the source (`"stdout"`, `"stderr"`, ...); each gets its own
   * redaction carry-over. Defaults to `"stdout"`.
   */
  write(chunk: Uint8Array | Buffer | string, stream: string = DEFAULT_STREAM): Promise<void> {
    const next = this.chain.then(() => this.writeNow(chunk, stream));
    // Don't let an unhandled rejection break the chain for subsequent writers;
    // each caller owns the promise it received.
    this.chain = next.catch(() => {});
    return next;
  }

  private currentSecrets(): PreparedSecret[] {
    try {
      this.lastSecrets = this.opts.secrets();
    } catch {
      // Fail closed: keep redacting with the last list we saw.
    }
    return prepareSecrets(this.lastSecrets);
  }

  private writeNow(chunk: Uint8Array | Buffer | string, stream: string): void {
    if (this.closed || this.fd === null) return;
    const buf = toBuffer(chunk);
    if (buf.length === 0) return;

    if (this.hitCap) {
      // Everything from here on is discarded, so skip the redaction work.
      this.droppedBytes += buf.length;
      return;
    }

    const held = this.tails.get(stream);
    const data = held && held.length > 0 ? Buffer.concat([held, buf]) : buf;
    const { out, rest } = redactBytes(data, this.currentSecrets(), true);
    if (rest.length > 0) this.tails.set(stream, rest);
    else this.tails.delete(stream);
    this.emit(out);
  }

  /** Write already-redacted bytes to disk, enforcing the cap. */
  private emit(out: Buffer): void {
    if (out.length === 0 || this.fd === null) return;
    const remaining = this.opts.maxBytes - this.writtenBytes;

    if (remaining <= 0) {
      // Already over the cap. Just count.
      this.droppedBytes += out.length;
      this.hitCap = true;
      return;
    }

    const head = out.length <= remaining ? out : out.subarray(0, remaining);
    const dropped = out.length - head.length;
    try {
      writeSync(this.fd, head, 0, head.length);
      this.writtenBytes += head.length;
    } catch (err) {
      // Disk full / fd gone: keep the run alive, drop the output.
      this.writeError ??= err instanceof Error ? err : new Error(String(err));
      this.droppedBytes += head.length;
    }
    if (dropped > 0) {
      this.droppedBytes += dropped;
      this.hitCap = true;
    }
  }

  async close(): Promise<void> {
    // Wait for any in-flight chained write to finish.
    await this.chain.catch(() => {});
    if (this.closed || this.fd === null) {
      this.closed = true;
      return;
    }
    // Flush what each stream was holding back: no more input is coming, so it
    // cannot become a secret any more, but it may still contain whole ones.
    if (this.tails.size > 0) {
      const secrets = this.currentSecrets();
      for (const tail of this.tails.values()) {
        if (this.hitCap) this.droppedBytes += tail.length;
        else this.emit(redactBytes(tail, secrets, false).out);
      }
      this.tails.clear();
    }
    if (this.hitCap) {
      const marker = `${TRUNC_MARKER_PREFIX}${this.droppedBytes}${TRUNC_MARKER_SUFFIX}`;
      const markerBuf = Buffer.from(marker, "utf8");
      try {
        writeSync(this.fd, markerBuf, 0, markerBuf.length);
      } catch {
        // best-effort
      }
    }
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
    this.fd = null;
    this.closed = true;
  }
}

/**
 * mkdir -p with mode 0700 for every directory we create, then (when a root is
 * given) force 0700 on the whole chain root..parent.
 */
function ensureDirs(filePath: string, dirRoot: string | undefined): void {
  const parent = resolve(dirname(filePath));
  const missing: string[] = [];
  for (let cur = parent; !existsSync(cur); ) {
    missing.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const dir of missing.reverse()) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (!dirRoot) return;
  const root = resolve(dirRoot);
  for (let cur = parent; cur === root || cur.startsWith(root + sep); cur = dirname(cur)) {
    try {
      chmodSync(cur, 0o700);
    } catch {
      // best-effort
    }
    if (cur === root) break;
  }
}

function toBuffer(chunk: Uint8Array | Buffer | string): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}
