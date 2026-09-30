import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, STATE_DIR } from "../paths.ts";
import { dataDirIsForeign, ensurePrivateDir, leaveRootModeAlone } from "./db/connection.ts";
import { classifySupervisorPid, sleepSync } from "./process-identity.ts";

// sysexits-style process codes used by direct invocations and diagnostics.
export const EX = {
  OK: 0,
  USAGE: 64,
  SOFTWARE: 70,
  TEMPFAIL: 75,
  CONFIG: 78,
} as const;

export { DATA_DIR, STATE_DIR };

/**
 * Shutdown budget shared by main.ts (which enforces it) and `auto svc stop`
 * (which waits for it). Runner.shutdown(SHUTDOWN_GRACE_MS) signals every worker
 * and always resolves within SHUTDOWN_GRACE_MS + 2000 ms; the hard deadline is
 * the last-resort exit if any teardown step wedges.
 */
export const SHUTDOWN_GRACE_MS = 10_000;
export const SHUTDOWN_HARD_DEADLINE_MS = SHUTDOWN_GRACE_MS + 5_000;
export const LOCK_PATH = resolve(DATA_DIR, "supervisor.lock");
export const LAST_ERROR_PATH = resolve(STATE_DIR, "last-error.txt");
export const DEGRADED_FLAG_PATH = resolve(STATE_DIR, "degraded.json");

let foreignVerdict: boolean | undefined;

/**
 * Was DATA_DIR a directory with content that is not Auto's when this process
 * first looked (a mistaken AUTO_DATA_DIR)? Decided once, before Auto adds
 * `state/` and the like, because afterwards every directory holds Auto data.
 */
export function dataDirIsForeignAtStart(): boolean {
  if (foreignVerdict === undefined) {
    foreignVerdict = dataDirIsForeign(DATA_DIR);
    if (foreignVerdict) leaveRootModeAlone(DATA_DIR);
  }
  return foreignVerdict;
}

/**
 * DATA_DIR and STATE_DIR exist and are 0700 (a looser existing DATA_DIR is
 * tightened). A DATA_DIR that holds only other people's files keeps its own
 * mode; only `state/` is created and tightened.
 */
export function ensureStateDirs(): void {
  if (dataDirIsForeignAtStart()) {
    ensurePrivateDir(STATE_DIR, STATE_DIR);
    return;
  }
  ensurePrivateDir(DATA_DIR);
  ensurePrivateDir(STATE_DIR);
}

function atomicWrite(path: string, data: string, mode: number): void {
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Singleton lock
// ---------------------------------------------------------------------------
//
// The lock is a small JSON file created atomically (write a private temp file,
// then link() it into place, so a reader never sees a half-written lock). A
// holder counts as live only when its pid is alive AND its command line looks
// like a supervisor: after a crash or reboot the pid may belong to any
// unrelated process. Stale takeover is serialized by a short-lived guard file
// so that exactly one starter replaces a dead holder.

export type LockInfo = { pid: number; startedAt: number; entry: string };

export class LockHeld extends Error {
  constructor(public holderPid: number | null) {
    super("supervisor lock already held");
  }
}

export type LockHandle = { release: () => void; info: LockInfo };

export type LockOptions = {
  /** Defaults to <DATA_DIR>/supervisor.lock. */
  lockPath?: string;
  /** Recorded in the lock; defaults to the running script (argv[1]). */
  entry?: string;
};

export type LockRead =
  | { kind: "none" }
  | { kind: "corrupt"; mtimeMs: number }
  | { kind: "ok"; info: LockInfo };

const GUARD_WAIT_MS = 3_000;
const GUARD_STALE_MS = 10_000;
const CORRUPT_GRACE_MS = 2_000;

export function readLock(lockPath: string = LOCK_PATH): LockRead {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "corrupt", mtimeMs: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        kind: "ok",
        info: {
          pid: parsed.pid,
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
          entry: typeof parsed.entry === "string" ? parsed.entry : "",
        },
      };
    }
  } catch {
    // fall through
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // vanished between read and stat
  }
  return { kind: "corrupt", mtimeMs };
}

/**
 * The holder of `lockPath` if it is a live supervisor, else null. This is what
 * `auto svc` trusts: a dead pid, a reused pid or a corrupt file all yield null.
 */
export function liveLockHolder(lockPath: string = LOCK_PATH): LockInfo | null {
  const read = readLock(lockPath);
  if (read.kind !== "ok") return null;
  return classifySupervisorPid(read.info.pid, read.info.entry) === "supervisor" ? read.info : null;
}

const heldHandles = new Map<LockHandle, string>();
let exitHookInstalled = false;

function installExitHookOnce(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Only lock cleanup. Signal handling belongs to main.ts, which must run its
  // graceful teardown before the process exits.
  process.on("exit", () => {
    for (const handle of [...heldHandles.keys()]) handle.release();
  });
}

/** Atomically create `lockPath` with `payload`; false when it already exists. */
function publish(lockPath: string, payload: string): boolean {
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP" || code === "EXDEV") {
      // Filesystem without hard links: fall back to exclusive create.
      try {
        const lfd = openSync(lockPath, "wx", 0o600);
        try {
          writeSync(lfd, payload);
        } finally {
          closeSync(lfd);
        }
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw inner;
      }
    }
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

function acquireGuard(guardPath: string): () => void {
  const deadline = Date.now() + GUARD_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(guardPath, "wx", 0o600);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(guardPath);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // A starter that died mid-takeover leaves a guard behind; clear old ones.
    try {
      if (Date.now() - statSync(guardPath).mtimeMs > GUARD_STALE_MS) {
        const aside = `${guardPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
        renameSync(guardPath, aside);
        unlinkSync(aside);
        continue;
      }
    } catch {
      continue; // guard vanished; retry immediately
    }
    if (Date.now() >= deadline) throw new LockHeld(null);
    sleepSync(25);
  }
}

export function acquireSingletonLock(opts: LockOptions = {}): LockHandle {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  if (opts.lockPath) ensurePrivateDir(dirname(lockPath), dirname(lockPath));
  else ensureStateDirs();
  installExitHookOnce();

  const info: LockInfo = {
    pid: process.pid,
    startedAt: Date.now(),
    entry: opts.entry ?? process.argv[1] ?? "",
  };
  const payload = JSON.stringify(info);

  const makeHandle = (): LockHandle => {
    let released = false;
    const handle: LockHandle = {
      info,
      release: () => {
        if (released) return;
        released = true;
        heldHandles.delete(handle);
        // Only remove the file if it is still ours.
        const read = readLock(lockPath);
        if (read.kind === "ok" && read.info.pid === info.pid && read.info.startedAt === info.startedAt) {
          try {
            unlinkSync(lockPath);
          } catch {
            // already gone
          }
        }
      },
    };
    heldHandles.set(handle, lockPath);
    return handle;
  };

  const holds = (path: string): boolean => [...heldHandles.values()].includes(path);

  // A lock naming our own pid that we did not create is a leftover from an
  // earlier process that happened to have this pid.
  const isLive = (read: LockRead & { kind: "ok" }): boolean => {
    if (read.info.pid === process.pid) return holds(lockPath);
    return classifySupervisorPid(read.info.pid, read.info.entry) === "supervisor";
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    if (publish(lockPath, payload)) {
      return makeHandle();
    }
    const read = readLock(lockPath);
    if (read.kind === "none") continue; // holder vanished; race again
    if (read.kind === "ok" && isLive(read)) throw new LockHeld(read.info.pid);
    if (read.kind === "corrupt" && read.mtimeMs > 0 && Date.now() - read.mtimeMs < CORRUPT_GRACE_MS) {
      // Possibly a writer mid-create (older versions used a non-atomic create).
      sleepSync(100);
      continue;
    }

    // Stale or corrupt: replace it, one starter at a time.
    const release = acquireGuard(`${lockPath}.takeover`);
    try {
      const again = readLock(lockPath);
      if (again.kind === "ok" && isLive(again)) throw new LockHeld(again.info.pid);
      if (again.kind !== "none") {
        const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
        try {
          renameSync(lockPath, aside);
          unlinkSync(aside);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      if (publish(lockPath, payload)) {
        return makeHandle();
      }
      const winner = readLock(lockPath);
      throw new LockHeld(winner.kind === "ok" ? winner.info.pid : null);
    } finally {
      release();
    }
  }
  throw new LockHeld(null);
}

// ---------------------------------------------------------------------------
// Degraded mode
// ---------------------------------------------------------------------------

export type DegradedReason = { kind: "config_error"; message: string };

export class DegradedMode {
  active = false;
  reason: DegradedReason | null = null;
  enteredAt: number | null = null;

  enter(reason: DegradedReason): void {
    if (this.active && this.reason && this.reason.message === reason.message) return;
    this.active = true;
    this.reason = reason;
    this.enteredAt = Date.now();
    ensureStateDirs();
    atomicWrite(
      DEGRADED_FLAG_PATH,
      JSON.stringify({ reason, enteredAt: this.enteredAt }),
      0o600,
    );
  }

  exit(): void {
    this.active = false;
    this.reason = null;
    this.enteredAt = null;
    this.clearFlag();
  }

  /**
   * Remove the degraded.json flag file. A supervisor that was stopped or
   * killed while degraded leaves it behind; the next start with a good config
   * calls this so the file only ever describes the current state.
   */
  clearFlag(): void {
    try {
      unlinkSync(DEGRADED_FLAG_PATH);
    } catch {
      // already absent
    }
  }

  snapshot(): {
    active: boolean;
    reason: DegradedReason | null;
    enteredAt: number | null;
  } {
    return {
      active: this.active,
      reason: this.reason,
      enteredAt: this.enteredAt,
    };
  }
}

export const degradedMode = new DegradedMode();

// ---------------------------------------------------------------------------
// Last error
// ---------------------------------------------------------------------------

export function writeLastError(err: unknown): void {
  ensureStateDirs();
  let body: string;
  if (err instanceof Error) {
    body = `${err.name}: ${err.message}\n${err.stack ?? ""}`;
  } else {
    try {
      body = typeof err === "string" ? err : JSON.stringify(err);
    } catch {
      body = String(err);
    }
  }
  atomicWrite(LAST_ERROR_PATH, body, 0o600);
}

export function readLastError(): string | null {
  if (!existsSync(LAST_ERROR_PATH)) return null;
  try {
    return readFileSync(LAST_ERROR_PATH, "utf8");
  } catch {
    return null;
  }
}
