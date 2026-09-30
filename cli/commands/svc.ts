import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import {
  installBunCronService,
  runningSupervisorPid,
  SERVICE_TITLE,
  startSupervisorNow,
  uninstallBunCronService,
  waitForHealthz,
} from "../../supervisor/bun-cron-service.ts";
import { LOCK_PATH, SHUTDOWN_GRACE_MS } from "../../supervisor/lifecycle.ts";
import { SUPERVISOR_LOG_PATH } from "../../supervisor/log-file.ts";
import { classifySupervisorPid, isPidAlive } from "../../supervisor/process-identity.ts";
import { status, CONFIG_PATH } from "../runtime.ts";
import { AUTO_PORT } from "../../paths.ts";

/**
 * Where the supervisor this command manages listens. Always loopback on
 * AUTO_PORT, whatever AUTO_BASE_URL says: that variable may name a proxy or
 * tunnel host that answers (or blocks) /healthz on its own.
 */
const LOCAL_URL = `http://127.0.0.1:${AUTO_PORT}`;

/** How long `auto install` / `auto svc start` wait for /healthz. */
const START_WAIT_MS = 15_000;
/** How long `auto svc stop` waits for the supervisor to exit: its shutdown grace plus margin. */
export const STOP_WAIT_MS = SHUTDOWN_GRACE_MS + 6_000;

/**
 * What the start and install commands touch outside this process. Tests pass
 * stand-ins, so they can run the command logic without registering a watchdog
 * or starting a supervisor.
 */
export type SvcDeps = {
  configExists: () => boolean;
  runningPid: () => number | null;
  portInUse: () => Promise<boolean>;
  installService: () => Promise<void>;
  startNow: () => number;
  waitForHealthz: typeof waitForHealthz;
  isAlive: (pid: number) => boolean;
};

const realDeps: SvcDeps = {
  configExists: () => existsSync(CONFIG_PATH),
  runningPid: () => runningSupervisorPid(LOCK_PATH),
  portInUse: () => portAlreadyInUse(),
  installService: () => installBunCronService(),
  startNow: () => startSupervisorNow(),
  waitForHealthz,
  isAlive: isPidAlive,
};

async function waitUntilUp(pid: number | null, deps: SvcDeps): Promise<number> {
  const result = await deps.waitForHealthz(LOCAL_URL, {
    timeoutMs: START_WAIT_MS,
    // Keep waiting while the process we launched, or any live supervisor, exists.
    stillStarting: () => (pid !== null && deps.isAlive(pid)) || deps.runningPid() !== null,
  });
  if (result.ok) {
    status(`supervisor is up at ${LOCAL_URL}${result.status === 503 ? " (degraded: see `auto config status`)" : ""}`);
    status(`Dashboard: ${LOCAL_URL}/`);
    return 0;
  }
  status(
    result.reason === "exited"
      ? `supervisor exited before it became reachable at ${LOCAL_URL}`
      : `supervisor did not become reachable at ${LOCAL_URL} within ${START_WAIT_MS / 1000}s`,
  );
  status(`see \`auto svc tail\` for its output (${SUPERVISOR_LOG_PATH})`);
  return 1;
}

export async function svcInstall(deps: SvcDeps = realDeps): Promise<number> {
  try {
    if (!deps.configExists()) {
      status(`workspace config not found: ${CONFIG_PATH}`);
      status("run `auto init` first");
      return 1;
    }
    const existing = deps.runningPid();
    if (!existing && (await deps.portInUse())) return 1;
    await deps.installService();
    status(`Bun cron service registered as ${SERVICE_TITLE}`);
    if (existing) {
      status(`supervisor already running pid=${existing}`);
      status(
        "it was not restarted: run `auto svc restart` for a changed AUTO_PORT, AUTO_ALLOWED_HOSTS, AUTO_RETENTION_* or PATH to take effect",
      );
      return await waitUntilUp(existing, deps);
    }
    const pid = deps.startNow();
    status(`supervisor starting pid=${pid}`);
    return await waitUntilUp(pid, deps);
  } catch (err) {
    status(`service install failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function svcUninstall(): Promise<number> {
  const stop = await stopSupervisorProcess();
  try {
    await uninstallBunCronService();
    status(`removed Bun cron service ${SERVICE_TITLE} (data/ untouched; shim left in place)`);
    return stop;
  } catch (err) {
    status(`service uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function svcStart(deps: SvcDeps = realDeps): Promise<number> {
  try {
    if (!deps.configExists()) {
      status(`workspace config not found: ${CONFIG_PATH}`);
      status("run `auto init` first");
      return 1;
    }
    const existing = deps.runningPid();
    if (existing) {
      status(`supervisor already running pid=${existing}`);
      status(`Dashboard: ${LOCAL_URL}/`);
      return 0;
    }
    if (await deps.portInUse()) return 1;
    await deps.installService();
    const pid = deps.startNow();
    status(`supervisor starting pid=${pid}`);
    return await waitUntilUp(pid, deps);
  } catch (err) {
    status(`service start failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function portAlreadyInUse(): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_URL}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.status > 0) {
      status(`cannot start: ${LOCAL_URL} is already served by another process`);
      status("choose another port with AUTO_PORT before running `auto install`");
      return true;
    }
  } catch {
    // Connection refused is the expected idle state.
  }
  return false;
}

export async function svcStop(): Promise<number> {
  try {
    await uninstallBunCronService();
  } catch (err) {
    status(`warning: could not remove watchdog: ${err instanceof Error ? err.message : String(err)}`);
  }
  return stopSupervisorProcess();
}

/** Stop, and only start again once the old supervisor has actually exited. */
export async function svcRestart(): Promise<number> {
  const stopped = await svcStop();
  if (stopped !== 0) {
    status("not starting a new supervisor while the old one is still running");
    return stopped;
  }
  return svcStart();
}

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

const TAIL_INITIAL_LINES = 50;
const TAIL_POLL_MS = 300;

/** Last `lines` lines of `path` (empty when it does not exist). Reads at most the last 1 MiB. */
export function readTail(path: string, lines: number = TAIL_INITIAL_LINES): { text: string; size: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const all = buf.toString("utf8").split("\n");
    if (all[all.length - 1] === "") all.pop();
    return { text: all.slice(-lines).map((l) => `${l}\n`).join(""), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Print the tail of the supervisor log, then follow it (surviving rotation and
 * truncation). Plain JS so it behaves the same on every platform.
 */
export async function tailLog(opts: {
  path?: string;
  lines?: number;
  follow?: boolean;
  out?: (chunk: string) => void;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const path = opts.path ?? SUPERVISOR_LOG_PATH;
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const first = readTail(path, opts.lines ?? TAIL_INITIAL_LINES);
  if (first.text) out(first.text);
  if (!opts.follow) return;
  let position = first.size;
  let pending = "";
  while (!opts.signal?.aborted) {
    await Bun.sleep(TAIL_POLL_MS);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      position = 0; // rotated away; pick up the new file when it appears
      continue;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < position) position = 0; // truncated or replaced
      if (size > position) {
        const buf = Buffer.alloc(size - position);
        const n = readSync(fd, buf, 0, buf.length, position);
        position += n;
        pending += buf.subarray(0, n).toString("utf8");
        const cut = pending.lastIndexOf("\n");
        if (cut >= 0) {
          out(pending.slice(0, cut + 1));
          pending = pending.slice(cut + 1);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
}

export async function svcTail(): Promise<number> {
  status(`following ${SUPERVISOR_LOG_PATH} (Ctrl-C to stop)`);
  if (process.platform === "darwin") {
    const base = `/tmp/bun.cron.${SERVICE_TITLE}`;
    status(`the host scheduler also keeps its own logs at ${base}.stdout.log and ${base}.stderr.log`);
  } else if (process.platform === "win32") {
    status("the host scheduler's own logs are in Task Scheduler history");
  } else {
    status("the host scheduler's own logs are in journalctl / syslog (search for the cron title)");
  }
  await tailLog({ follow: true });
  return 0;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/** Wait until `pid` is no longer a supervisor (exited, or its pid was reused). */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (classifySupervisorPid(pid) !== "supervisor") return true;
    await Bun.sleep(100);
  }
  return classifySupervisorPid(pid) !== "supervisor";
}

/**
 * SIGTERM the live supervisor named by the lock and wait for it to exit. A
 * dead, foreign or reused pid is never signalled.
 */
export async function stopSupervisorProcess(
  lockPath: string = LOCK_PATH,
  waitMs: number = STOP_WAIT_MS,
): Promise<number> {
  const pid = runningSupervisorPid(lockPath);
  if (!pid) {
    status("supervisor is not running");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    status(`could not stop supervisor pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  status(`sent SIGTERM to supervisor pid=${pid}; waiting up to ${waitMs / 1000}s for it to exit`);
  const started = Date.now();
  if (await waitForExit(pid, waitMs)) {
    status(`supervisor stopped (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return 0;
  }
  status(`supervisor pid=${pid} is still running after ${waitMs / 1000}s; see \`auto svc tail\``);
  status(`as a last resort: kill -9 ${pid}`);
  return 1;
}
