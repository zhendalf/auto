// Shared helpers for spawning and signalling supervised child processes
// (workers in runner.ts, condition checkers in condition-evaluator.ts).

type Killable = {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): void;
};

/**
 * Whether the platform has POSIX process groups. On win32 there is no
 * `kill(-pid)`, and `Bun.spawn({ detached: true })` would open a separate
 * console window, so we fall back to signalling only the direct child.
 */
export const HAS_PROCESS_GROUPS = process.platform !== "win32";

/**
 * `Bun.spawn` option that puts the child in its own session and process group
 * (pgid == child pid), so a timeout, cancel or shutdown can signal the worker
 * AND everything it forked with one `kill(-pid)`.
 */
export function processGroupSpawnOption(): { detached: boolean } {
  return { detached: HAS_PROCESS_GROUPS };
}

/**
 * Signal the whole process group led by `child`. Falls back to signalling just
 * the child where groups are unsupported (win32), when the pid is unknown
 * (test doubles), or when the group signal itself fails.
 *
 * Windows caveat: there `kill()` terminates the process unconditionally
 * whatever the signal name is, so SIGTERM is not a polite request and a
 * job's `killGraceMs` grace period does not apply.
 */
export function signalProcessGroup(child: Killable, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (HAS_PROCESS_GROUPS && typeof pid === "number" && Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // ESRCH: no such group. Either it is empty or the child was not started
      // in its own group (spawn wrapper that ignored `detached`); signalling
      // the child directly below covers the second case and is a no-op for the
      // first.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}

/**
 * Environment variables copied from the supervisor into child processes.
 * Everything else (in particular every secret the supervisor itself holds) is
 * deliberately not inherited.
 */
const POSIX_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "SHELL", "TMPDIR"];

// Windows needs these for basic process start-up (DLL search, temp dirs,
// executable resolution); without SystemRoot many programs fail to even start.
const WIN32_ENV_KEYS = [
  "SystemRoot",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PATHEXT",
  "COMSPEC",
];

export function childEnvAllowlist(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? [...POSIX_ENV_KEYS, ...WIN32_ENV_KEYS] : [...POSIX_ENV_KEYS];
}

/** Copy the allowlisted variables that are set in `source` (default: this process). */
export function allowlistedEnv(
  source: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of childEnvAllowlist(platform)) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
