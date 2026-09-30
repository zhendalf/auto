import { chmodSync, closeSync, existsSync, fstatSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { STATE_DIR } from "../paths.ts";
import { ensurePrivateDir } from "./db/connection.ts";
import { resolve } from "node:path";

// The supervisor's own stdout/stderr, kept in one file that `auto svc tail`
// can follow on every platform. `startSupervisorNow` points the child's stdio
// straight at this file; a supervisor started by the watchdog (Bun cron) tees
// its output here instead, so the file is complete either way.

export const SUPERVISOR_LOG_PATH = resolve(STATE_DIR, "supervisor.log");
export const SUPERVISOR_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Set by whoever already redirected our stdio into the log, so we do not tee twice. */
export const LOG_REDIRECTED_ENV = "AUTO_LOG_REDIRECTED";

/** Move `path` aside to `<path>.1` once it exceeds `maxBytes`. True when rotated. */
export function rotateLogIfLarge(path: string, maxBytes: number = SUPERVISOR_LOG_MAX_BYTES): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
    renameSync(path, `${path}.1`); // replaces the previous generation
    return true;
  } catch {
    return false;
  }
}

/** Open the log for appending (0600), rotating it first when it is large. */
export function openSupervisorLog(
  path: string = SUPERVISOR_LOG_PATH,
  maxBytes: number = SUPERVISOR_LOG_MAX_BYTES,
): number {
  ensurePrivateDir(resolve(path, ".."));
  rotateLogIfLarge(path, maxBytes);
  const fd = openSync(path, "a", 0o600);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
  return fd;
}

/**
 * Mirror everything written to process.stdout/stderr into the log file, and
 * rotate it while running. Best-effort: a full disk or a closed fd must never
 * take the supervisor down. Returns a function that restores the streams.
 */
export function installLogTee(
  path: string = SUPERVISOR_LOG_PATH,
  maxBytes: number = SUPERVISOR_LOG_MAX_BYTES,
  streams: NodeJS.WriteStream[] = [process.stdout, process.stderr],
): () => void {
  let fd: number;
  try {
    fd = openSupervisorLog(path, maxBytes);
  } catch {
    return () => {};
  }
  let size = 0;
  try {
    size = fstatSync(fd).size;
  } catch {
    // unknown; rotation just starts counting from zero
  }

  const append = (chunk: string | Uint8Array): void => {
    try {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.byteLength;
      writeSync(fd, bytes);
      if (size > maxBytes) {
        closeSync(fd);
        renameSync(path, `${path}.1`);
        fd = openSync(path, "a", 0o600);
        size = 0;
      }
    } catch {
      // logging is a courtesy
    }
  };

  type Write = typeof process.stdout.write;
  const patch = (stream: NodeJS.WriteStream): (() => void) => {
    const original = stream.write;
    stream.write = function (this: unknown, chunk: string | Uint8Array, ...rest: unknown[]) {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) append(chunk);
      return (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest);
    } as Write;
    return () => {
      stream.write = original;
    };
  };
  const restores = streams.map(patch);
  return () => {
    for (const restore of restores) restore();
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  };
}
