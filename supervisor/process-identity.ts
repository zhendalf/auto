// Process liveness and identity helpers shared by the singleton lock, the
// `auto svc` commands and crash recovery. A pid alone proves nothing after a
// crash or reboot (pids are reused), so callers also compare the command line.

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Does any process still belong to process group `pgid`? A group outlives its
 * leader for as long as one member does. Always false where groups do not exist.
 */
export function isGroupAlive(pgid: number): boolean {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Command line of `pid` via `ps`. Returns "" when the process does not exist
 * and null when it cannot be determined (no `ps`, e.g. on Windows, or a `ps`
 * that does not understand the flags).
 */
export function commandLineOf(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const proc = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
    // procps and BSD ps exit 1 with nothing on stderr when no process matches.
    // A ps that rejects the flags (BusyBox) exits 1 with a usage error; that is
    // "unknown", not "dead", or a live supervisor would look gone.
    return proc.exitCode === 1 && proc.stderr.toString().trim() === "" ? "" : null;
  } catch {
    return null;
  }
}

/** Process group id of `pid`, or null when unknown. */
export function processGroupOf(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const proc = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const n = Number(proc.stdout.toString().trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Substrings that identify a supervisor process on a command line. */
const SUPERVISOR_MARKERS = [
  "supervisor/main.ts",
  "supervisor\\main.ts",
  ".auto-runtime/supervisor.ts",
  ".auto-runtime\\supervisor.ts",
];

export type PidIdentity = "dead" | "supervisor" | "foreign";

/**
 * Is `pid` a live supervisor? `entry` is the entry path the lock holder
 * recorded when it started. Where the command line is unavailable this falls
 * back to plain liveness.
 */
export function classifySupervisorPid(
  pid: number,
  entry?: string | null,
  deps: {
    isAlive?: (pid: number) => boolean;
    commandLine?: (pid: number) => string | null;
  } = {},
): PidIdentity {
  const alive = deps.isAlive ?? isPidAlive;
  if (!alive(pid)) return "dead";
  const cmd = (deps.commandLine ?? commandLineOf)(pid);
  if (cmd === null) return "supervisor";
  if (cmd === "") return "dead";
  if (SUPERVISOR_MARKERS.some((m) => cmd.includes(m))) return "supervisor";
  if (entry && cmd.includes(entry)) return "supervisor";
  return "foreign";
}

/** Synchronous sleep; used only in tiny lock-contention loops. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
