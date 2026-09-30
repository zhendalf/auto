import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { STATE_DIR } from "../paths.ts";

// Desktop notifications are best-effort: a missing notifier or a failed
// spawn must never affect the supervisor.

export const NOTIFY_STATE_PATH = resolve(STATE_DIR, "notified.json");
export const NOTIFY_REPEAT_MS = 6 * 60 * 60 * 1000;
const NOTIFIER_TIMEOUT_MS = 5_000;

export type NotifyRunner = (cmd: string[]) => Promise<void>;
export type NotifyDeps = {
  run?: NotifyRunner;
  which?: (name: string) => string | null;
  platform?: NodeJS.Platform;
};

async function defaultRunner(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  // A notifier that wedges (e.g. waiting on a permission prompt) must not stall startup.
  const timer = setTimeout(() => proc.kill("SIGKILL"), NOTIFIER_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a desktop notification. Uses terminal-notifier when it is on PATH,
 * otherwise osascript on macOS, otherwise does nothing. Set AUTO_NOTIFY=0 to
 * disable. Never throws.
 */
export async function notify(
  title: string,
  message: string,
  deps: NotifyDeps = {},
): Promise<void> {
  try {
    if (process.env.AUTO_NOTIFY === "0") return;
    const run = deps.run ?? defaultRunner;
    const which = deps.which ?? ((name: string) => Bun.which(name));
    const notifier = which("terminal-notifier");
    if (notifier) {
      await run([notifier, "-title", title, "-message", message]);
      return;
    }
    if ((deps.platform ?? process.platform) === "darwin") {
      const osascript = which("osascript") ?? "/usr/bin/osascript";
      // Arguments go through `argv`, never interpolated into the script.
      await run([
        osascript,
        "-e",
        "on run argv",
        "-e",
        "display notification (item 1 of argv) with title (item 2 of argv)",
        "-e",
        "end run",
        message,
        title,
      ]);
    }
  } catch {
    // best-effort
  }
}

function readState(path: string): Record<string, number> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeState(path: string, state: Record<string, number>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

export type NotifyOnceOptions = {
  statePath?: string;
  windowMs?: number;
  now?: number;
  deps?: NotifyDeps;
};

/**
 * Notify once per distinct `key` per window (default 6 hours). The watchdog
 * restarts a failing supervisor every minute, so the last-sent time is
 * persisted. Returns true when a notification was sent.
 */
export async function notifyOnce(
  key: string,
  title: string,
  message: string,
  opts: NotifyOnceOptions = {},
): Promise<boolean> {
  try {
    const path = opts.statePath ?? NOTIFY_STATE_PATH;
    const now = opts.now ?? Date.now();
    const windowMs = opts.windowMs ?? NOTIFY_REPEAT_MS;
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const state = readState(path);
    const last = state[digest];
    if (last !== undefined && now - last < windowMs && now >= last) return false;
    // Drop entries that have aged out so the file stays tiny.
    for (const [k, ts] of Object.entries(state)) {
      if (now - ts >= windowMs) delete state[k];
    }
    state[digest] = now;
    writeState(path, state);
    await notify(title, message, opts.deps);
    return true;
  } catch {
    return false;
  }
}
