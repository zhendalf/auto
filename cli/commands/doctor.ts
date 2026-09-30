// `auto doctor` — diagnostic checklist.
//
// Each check is isolated (one failure does not cascade) and every check that
// is not OK says how to fix it in one line. The DB integrity check is the one
// direct-DB read in the CLI: we want to know if the database file itself is
// corrupt regardless of supervisor state.
//
// Exit code: 1 when any check FAILs, else 0 (WARN and INFO never fail).

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  SERVICE_TITLE,
  runningSupervisorPid,
  verifyServiceEntry,
} from "../../supervisor/bun-cron-service.ts";
import { checkConfigOffline } from "../config-file.ts";
import {
  CONFIG_PATH,
  DATA_DIR,
  DB_PATH,
  EX,
  MIN_BUN_VERSION,
  WORKSPACE_ROOT,
  color,
  errColor,
  getApiClient,
  globals,
  plural,
  printJson,
  println,
  status as printStatus,
} from "../runtime.ts";
import { bunVersionAtLeast } from "./init.ts";
import { directoryUsage, fmtBytes } from "./data.ts";

export type CheckStatus = "OK" | "WARN" | "FAIL" | "INFO";
export type Check = {
  name: string;
  status: CheckStatus;
  message: string;
  /** One line telling the user how to fix a WARN or FAIL. */
  remedy?: string;
  /** Optional structured data for --json consumers. */
  data?: Record<string, unknown>;
};

/** Total data (database + run logs) above which doctor warns. */
export const DISK_WARN_BYTES = 1024 ** 3;

/** The oldest Bun the test suite is run on (the minimum in package.json is lower and unverified). */
const TESTED_BUN_VERSION = "1.4.0";

function checkBun(): Check {
  const version = Bun.version;
  if (bunVersionAtLeast(version, MIN_BUN_VERSION)) {
    if (!bunVersionAtLeast(version, TESTED_BUN_VERSION)) {
      return {
        name: "Bun version",
        status: "WARN",
        message: `Bun ${version} is allowed (${MIN_BUN_VERSION} or newer) but Auto is only tested on ${TESTED_BUN_VERSION} and newer`,
        remedy: "run `bun upgrade`",
      };
    }
    return { name: "Bun version", status: "OK", message: `Bun ${version} (needs ${MIN_BUN_VERSION} or newer)` };
  }
  return {
    name: "Bun version",
    status: "FAIL",
    message: `Bun ${version} is older than ${MIN_BUN_VERSION}`,
    remedy: "run `bun upgrade`",
  };
}

function checkWorkspace(): Check {
  if (!existsSync(WORKSPACE_ROOT)) {
    return {
      name: "Workspace",
      status: "FAIL",
      message: `no workspace at ${WORKSPACE_ROOT}`,
      remedy: "run `auto init`",
    };
  }
  if (!existsSync(CONFIG_PATH)) {
    return {
      name: "Workspace",
      status: "FAIL",
      message: `${WORKSPACE_ROOT} has no config file (${CONFIG_PATH})`,
      remedy: "run `auto init`",
    };
  }
  return { name: "Workspace", status: "OK", message: `${WORKSPACE_ROOT}, config ${CONFIG_PATH}` };
}

function checkWatchdogRegistration(): Check {
  const name = "Watchdog registered";
  const fix = "run `auto install`";
  try {
    if (process.platform === "darwin") {
      const plist = resolve(homedir(), "Library", "LaunchAgents", `bun.cron.${SERVICE_TITLE}.plist`);
      return existsSync(plist)
        ? { name, status: "OK", message: plist }
        : { name, status: "FAIL", message: `missing: ${plist}`, remedy: fix };
    }
    if (process.platform === "linux") {
      const proc = Bun.spawnSync(["crontab", "-l"], { stdout: "pipe", stderr: "pipe" });
      const present = proc.exitCode === 0 && proc.stdout.toString().includes(`# bun-cron: ${SERVICE_TITLE}`);
      return present
        ? { name, status: "OK", message: `crontab entry ${SERVICE_TITLE}` }
        : { name, status: "FAIL", message: "not present in the user crontab", remedy: fix };
    }
    if (process.platform === "win32") {
      const proc = Bun.spawnSync(["schtasks", "/query", "/tn", `bun-cron-${SERVICE_TITLE}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return proc.exitCode === 0
        ? { name, status: "OK", message: `Task Scheduler task bun-cron-${SERVICE_TITLE}` }
        : { name, status: "FAIL", message: "Task Scheduler entry missing", remedy: fix };
    }
    return { name, status: "WARN", message: `unsupported platform: ${process.platform}` };
  } catch (err) {
    return {
      name,
      status: "FAIL",
      message: err instanceof Error ? err.message : String(err),
      remedy: "check that the OS scheduler (launchd, crontab or Task Scheduler) is available",
    };
  }
}

function checkWatchdogEntry(): Check {
  const name = "Watchdog entry";
  const r = verifyServiceEntry();
  if (r.ok) return { name, status: "OK", message: `runs ${r.bakedSupervisorPath}` };
  if (!existsSync(r.entryPath)) {
    return { name, status: "INFO", message: "not created yet (`auto install` writes it)" };
  }
  return {
    name,
    status: "FAIL",
    message: r.problem ?? "invalid watchdog entry",
    remedy: "run `auto install` again (it rewrites the entry for this checkout)",
    data: { entry: r.entryPath, supervisor: r.bakedSupervisorPath },
  };
}

async function checkSupervisor(): Promise<Check> {
  const name = "Supervisor reachable";
  const client = getApiClient();
  const r = await client.healthzLatencyMs();
  if (!r.ok) {
    const pid = runningSupervisorPid();
    return {
      name,
      status: "FAIL",
      message: `${client.baseUrl}/healthz did not answer`,
      remedy: pid
        ? `supervisor pid ${pid} is running but not answering; see \`auto svc tail\``
        : "run `auto install` (first time) or `auto svc start`",
    };
  }
  if (r.status === 503) {
    return {
      name,
      status: "WARN",
      message: `${client.baseUrl}/healthz, ${r.ms ?? "?"}ms, degraded`,
      remedy: "run `auto config status` to see what is wrong",
      data: { status: r.status, ms: r.ms },
    };
  }
  return {
    name,
    status: "OK",
    message: `${client.baseUrl}/healthz, ${r.ms ?? "?"}ms`,
    data: { status: r.status, ms: r.ms },
  };
}

function checkTokenFile(): Check {
  const name = "Token file";
  const tokenPath = resolve(DATA_DIR, ".token");
  if (!existsSync(tokenPath)) {
    return {
      name,
      status: "FAIL",
      message: `missing: ${tokenPath}`,
      remedy: "run `auto install`; the supervisor creates the token when it first starts",
    };
  }
  if (process.platform === "win32") return { name, status: "OK", message: tokenPath };
  let mode = 0;
  try {
    mode = statSync(tokenPath).mode & 0o777;
  } catch (err) {
    return {
      name,
      status: "FAIL",
      message: err instanceof Error ? err.message : String(err),
      remedy: `check permissions on ${tokenPath}`,
    };
  }
  if ((mode & 0o077) !== 0) {
    return {
      name,
      status: "WARN",
      message: `mode ${mode.toString(8).padStart(3, "0")}: readable by other users`,
      remedy: `run \`chmod 600 ${tokenPath}\` (or \`auto token rotate\` to replace it)`,
    };
  }
  return { name, status: "OK", message: `${tokenPath}, mode 600` };
}

/** What to do about config warnings: they come in two kinds with different fixes. */
export function warningRemedy(warnings: { code: string; secret?: string }[]): string {
  const secrets = [...new Set(warnings.filter((w) => w.code === "missing_secret").map((w) => w.secret ?? "<name>"))];
  const files = warnings.some((w) => w.code === "missing_file");
  const steps: string[] = [];
  if (secrets.length > 0) steps.push(secrets.map((n) => `run \`auto secret set ${n}\``).join("; "));
  if (files) steps.push("restore the missing worker or checker file, or remove the disabled job from the config");
  return steps.join("; ") || "see `auto config status`";
}

async function checkConfigValid(): Promise<Check> {
  const name = "Config valid";
  if (!existsSync(CONFIG_PATH)) {
    return { name, status: "INFO", message: "skipped: no config file" };
  }
  const fix = "fix the errors above, then run `auto config check`";
  const client = getApiClient();
  if (await client.reachable()) {
    try {
      const s = await client.configStatus();
      const counts = `${plural(s.jobs, "job")}, ${plural(s.triggers, "trigger")}`;
      if (s.degraded.active) {
        return {
          name,
          status: "FAIL",
          message: s.degraded.reason ? `${s.degraded.reason.kind}: ${s.degraded.reason.message}` : "degraded",
          remedy: fix,
        };
      }
      if (!s.ok) {
        return { name, status: "FAIL", message: s.lastError?.message ?? "config invalid", remedy: fix };
      }
      if (s.warnings && s.warnings.length > 0) {
        return {
          name,
          status: "WARN",
          message: `${counts}; ${s.warnings.map((w) => w.message).join("; ")}`,
          remedy: warningRemedy(s.warnings),
          data: { warnings: s.warnings },
        };
      }
      return { name, status: "OK", message: counts };
    } catch (err) {
      return { name, status: "FAIL", message: err instanceof Error ? err.message : String(err), remedy: fix };
    }
  }
  // No supervisor to ask: validate the file offline.
  const r = await checkConfigOffline();
  if (r.code === 0) {
    const m = /jobs=(\d+) triggers=(\d+)/.exec(r.stdout);
    return {
      name,
      status: "OK",
      message: m ? `${plural(Number(m[1]), "job")}, ${plural(Number(m[2]), "trigger")} (checked offline)` : "valid (checked offline)",
    };
  }
  const detail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(0, 4).join(" | ");
  return { name, status: "FAIL", message: detail || "config invalid", remedy: fix };
}

function checkDb(): Check {
  const name = "Database";
  if (!existsSync(DB_PATH)) {
    return {
      name,
      status: "FAIL",
      message: `missing: ${DB_PATH}`,
      remedy: "run `auto install`; the supervisor creates the database when it first starts",
    };
  }
  let db: Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true, create: false });
    const row = db.query<{ integrity_check: string }, []>(`PRAGMA integrity_check`).get();
    if (!row || row.integrity_check !== "ok") {
      return {
        name,
        status: "FAIL",
        message: `integrity_check returned: ${row?.integrity_check ?? "(no rows)"}`,
        remedy: `stop the supervisor (\`auto svc stop\`), back up ${DB_PATH}, then run \`auto data wipe\` to start fresh`,
      };
    }
    return { name, status: "OK", message: `${DB_PATH}, integrity ok` };
  } catch (err) {
    return {
      name,
      status: "FAIL",
      message: err instanceof Error ? err.message : String(err),
      remedy: `check that ${DB_PATH} is readable; if it is damaged, back it up and run \`auto data wipe\``,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function checkPath(): Check {
  const name = "`auto` on PATH";
  const found = Bun.which("auto");
  if (found) return { name, status: "INFO", message: found };
  return {
    name,
    status: "INFO",
    message: "not found on PATH (you can still run it as `bun cli/main.ts`)",
    remedy: "add the directory holding the auto shim (for example ~/.local/bin) to PATH",
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function checkDisk(): Check {
  const name = "Disk usage";
  const dbBytes = fileSize(DB_PATH) + fileSize(`${DB_PATH}-wal`) + fileSize(`${DB_PATH}-shm`);
  const runs = directoryUsage(resolve(DATA_DIR, "runs"));
  const total = dbBytes + runs.bytes;
  const message =
    `database ${fmtBytes(dbBytes)}, run logs ${fmtBytes(runs.bytes)} in ${plural(runs.files, "file")} ` +
    `(${dirname(DB_PATH)})`;
  const data = { db_bytes: dbBytes, runs_bytes: runs.bytes, runs_files: runs.files, total_bytes: total };
  if (total > DISK_WARN_BYTES) {
    return {
      name,
      status: "WARN",
      message: `${fmtBytes(total)} of history: ${message}`,
      remedy: "keep less history by lowering AUTO_RETENTION_DAYS, or clear it with `auto data wipe`",
      data,
    };
  }
  return { name, status: "INFO", message, data };
}

function tag(s: CheckStatus): string {
  const padded = `[${s}]`.padEnd(7);
  switch (s) {
    case "OK":
      return color.green(padded);
    case "WARN":
      return color.yellow(padded);
    case "FAIL":
      return color.red(padded);
    case "INFO":
      return color.dim(padded);
  }
}

/** Run every check. Exported for tests. */
export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const guard = async (name: string, fn: () => Check | Promise<Check>): Promise<void> => {
    try {
      checks.push(await fn());
    } catch (err) {
      checks.push({
        name,
        status: "FAIL",
        message: `check crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
  await guard("Bun version", checkBun);
  await guard("Workspace", checkWorkspace);
  await guard("Watchdog registered", checkWatchdogRegistration);
  await guard("Watchdog entry", checkWatchdogEntry);
  await guard("Supervisor reachable", checkSupervisor);
  await guard("Token file", checkTokenFile);
  await guard("Config valid", checkConfigValid);
  await guard("Database", checkDb);
  await guard("`auto` on PATH", checkPath);
  await guard("Disk usage", checkDisk);
  return checks;
}

export async function runDoctor(): Promise<number> {
  const checks = await runChecks();
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warned = checks.filter((c) => c.status === "WARN").length;

  if (globals().json) {
    printJson({ ok: failed === 0, checks });
  } else {
    for (const c of checks) {
      println(`${tag(c.status)} ${c.name}: ${c.message}`);
      if (c.remedy && c.status !== "OK") println(`        fix: ${c.remedy}`);
    }
  }

  if (failed > 0) {
    printStatus("");
    printStatus(errColor.red(`doctor: ${plural(failed, "check")} failed${warned ? `, ${plural(warned, "warning")}` : ""}`));
    return EX.ERR;
  }
  if (warned > 0 && !globals().json) {
    printStatus("");
    printStatus(errColor.yellow(`doctor: ${plural(warned, "warning")}`));
  }
  return EX.OK;
}
