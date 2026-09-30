import { closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_PORT, CONFIG_PATH, DATA_DIR, WORKSPACE_ROOT } from "../paths.ts";
import { ensurePrivateDir } from "./db/connection.ts";
import { LOCK_PATH, liveLockHolder } from "./lifecycle.ts";
import { LOG_REDIRECTED_ENV, openSupervisorLog } from "./log-file.ts";

export const WATCHDOG_SCHEDULE = "* * * * *";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPLICIT_CONFIG_PATH = process.env.AUTO_CONFIG;
export const SUPERVISOR_ENTRY = resolve(HERE, "main.ts");
const suffix = createHash("sha256").update(WORKSPACE_ROOT).digest("hex").slice(0, 8);
export const SERVICE_TITLE = `auto-supervisor-${suffix}`;
export const SERVICE_ENTRY = resolve(WORKSPACE_ROOT, ".auto-runtime", "supervisor.ts");

/**
 * Optional settings the watchdog entry and the CLI shim carry along when they
 * are set at install time. The scheduler starts the supervisor with a bare
 * environment, so anything not baked in here would silently revert to its
 * default after the next reboot.
 */
export const OPTIONAL_ENV_VARS = [
  "AUTO_ALLOWED_HOSTS",
  "AUTO_RETENTION_DAYS",
  "AUTO_RETENTION_MIN_RUNS",
] as const;

/** The optional variables that are set (and non-empty) in `env`. */
export function optionalEnvFrom(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of OPTIONAL_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

export type ServiceEntryInput = {
  workspaceRoot: string;
  /** Only baked when the config location was set explicitly. */
  configPath?: string | null;
  dataDir: string;
  port: number;
  supervisorEntry: string;
  optionalEnv?: Record<string, string>;
  /**
   * PATH to give the supervisor (and so its workers). The scheduler starts the
   * watchdog with the OS default PATH; without this a worker that runs
   * `gh`, `jq` or `node` by name would find them after `auto svc start` but not
   * after a crash or reboot restart.
   */
  path?: string | null;
};

/** Source of the module the Bun cron watchdog runs every minute. */
export function renderServiceEntry(input: ServiceEntryInput): string {
  const optional = Object.entries(input.optionalEnv ?? {});
  return [
    `process.env.AUTO_HOME = ${JSON.stringify(input.workspaceRoot)};`,
    ...(input.configPath ? [`process.env.AUTO_CONFIG = ${JSON.stringify(input.configPath)};`] : []),
    `process.env.AUTO_DATA_DIR = ${JSON.stringify(input.dataDir)};`,
    `process.env.AUTO_PORT = ${JSON.stringify(String(input.port))};`,
    ...optional.map(([name, value]) => `process.env.${name} = ${JSON.stringify(value)};`),
    ...(input.path ? [`process.env.PATH = ${JSON.stringify(input.path)};`] : []),
    `const supervisor = await import(${JSON.stringify(input.supervisorEntry)});`,
    "export default supervisor.default;",
    "",
  ].join("\n");
}

/** What the watchdog entry bakes in for the install-time environment `env`. */
export function serviceEntryInput(env: NodeJS.ProcessEnv = process.env): ServiceEntryInput {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    configPath: EXPLICIT_CONFIG_PATH ? CONFIG_PATH : null,
    dataDir: DATA_DIR,
    port: AUTO_PORT,
    supervisorEntry: SUPERVISOR_ENTRY,
    optionalEnv: optionalEnvFrom(env),
    path: env.PATH || null,
  };
}

/** Written on every install so a moved checkout never leaves a stale absolute path. */
function writeServiceEntry(): void {
  mkdirSync(dirname(SERVICE_ENTRY), { recursive: true, mode: 0o700 });
  writeFileSync(SERVICE_ENTRY, renderServiceEntry(serviceEntryInput()), { mode: 0o600 });
}

export type ServiceEntryCheck = {
  ok: boolean;
  /** The watchdog entry file that was inspected. */
  entryPath: string;
  /** Absolute supervisor path baked into that entry, when one could be read. */
  bakedSupervisorPath: string | null;
  /** Human-readable reason when `ok` is false. */
  problem: string | null;
};

/**
 * Does the baked watchdog entry still point at a supervisor that exists? A
 * moved or deleted checkout leaves the entry importing a missing file, and the
 * watchdog then fails silently every minute. `auto install` rewrites it.
 */
export function verifyServiceEntry(entryPath: string = SERVICE_ENTRY): ServiceEntryCheck {
  const fail = (problem: string, baked: string | null = null): ServiceEntryCheck => ({
    ok: false,
    entryPath,
    bakedSupervisorPath: baked,
    problem,
  });
  if (!existsSync(entryPath)) return fail(`watchdog entry not found: ${entryPath} (run \`auto install\`)`);
  let source: string;
  try {
    source = readFileSync(entryPath, "utf8");
  } catch (err) {
    return fail(`cannot read watchdog entry: ${err instanceof Error ? err.message : String(err)}`);
  }
  const match = /await import\(("(?:[^"\\]|\\.)*")\)/.exec(source);
  let baked: string | null = null;
  if (match) {
    try {
      baked = JSON.parse(match[1]!) as string;
    } catch {
      baked = null;
    }
  }
  if (!baked) return fail("watchdog entry does not import a supervisor (run `auto install`)");
  if (!existsSync(baked)) {
    return fail(`watchdog entry points at a missing supervisor: ${baked} (run \`auto install\`)`, baked);
  }
  return { ok: true, entryPath, bakedSupervisorPath: baked, problem: null };
}

export async function installBunCronService(): Promise<void> {
  writeServiceEntry();
  await Bun.cron(SERVICE_ENTRY, WATCHDOG_SCHEDULE, SERVICE_TITLE);
}

export async function uninstallBunCronService(): Promise<void> {
  await Bun.cron.remove(SERVICE_TITLE);
}

/**
 * Start a supervisor in its own session, detached from this terminal. Its
 * stdout/stderr go to data/state/supervisor.log (0600, rotated at start when
 * over ~5 MB) so start-up failures are not lost.
 */
export function startSupervisorNow(): number {
  ensurePrivateDir(resolve(DATA_DIR, "state"));
  const logFd = openSupervisorLog();
  try {
    const child = Bun.spawn([process.execPath, SUPERVISOR_ENTRY], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        AUTO_HOME: WORKSPACE_ROOT,
        AUTO_CONFIG: CONFIG_PATH,
        AUTO_DATA_DIR: DATA_DIR,
        AUTO_PORT: String(AUTO_PORT),
        [LOG_REDIRECTED_ENV]: "1",
      },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

/**
 * Pid of the live supervisor recorded in the lock file, or null. A dead pid, a
 * reused pid that now belongs to another program and a corrupt lock all give
 * null, so `auto svc` never signals a stranger.
 */
export function runningSupervisorPid(lockPath: string = LOCK_PATH): number | null {
  return liveLockHolder(lockPath)?.pid ?? null;
}

export type HealthWait =
  | { ok: true; status: number; waitedMs: number }
  | { ok: false; reason: "timeout" | "exited"; waitedMs: number };

/**
 * Poll `<baseUrl>/healthz` until it answers (200, or 503 when degraded: either
 * way the supervisor is up). `stillStarting` lets the caller give up early when
 * the process it launched is already gone.
 */
export async function waitForHealthz(
  baseUrl: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    stillStarting?: () => boolean;
    fetchFn?: typeof fetch;
  } = {},
): Promise<HealthWait> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 250;
  const doFetch = opts.fetchFn ?? fetch;
  const started = Date.now();
  for (;;) {
    try {
      const response = await doFetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200 || response.status === 503) {
        return { ok: true, status: response.status, waitedMs: Date.now() - started };
      }
    } catch {
      // not listening yet
    }
    if (opts.stillStarting && !opts.stillStarting()) {
      return { ok: false, reason: "exited", waitedMs: Date.now() - started };
    }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, reason: "timeout", waitedMs: Date.now() - started };
    }
    await Bun.sleep(intervalMs);
  }
}
