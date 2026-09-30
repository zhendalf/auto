// `auto data wipe` — DESTRUCTIVE. Deletes the data directory (run history,
// logs, secrets and the API token). The workspace config and workers are not
// touched.

import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { isAutoDataEntry } from "../../paths.ts";
import { runningSupervisorPid } from "../../supervisor/bun-cron-service.ts";
import {
  DATA_DIR,
  DB_PATH,
  EX,
  WORKSPACE_ROOT,
  ask,
  color,
  getApiClient,
  globals,
  isStdinTty,
  printJson,
  println,
  status,
} from "../runtime.ts";

/** Total bytes of regular files under `dir`, and how many files there are. Never follows symlinks. */
export function directoryUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(current, entry);
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) {
          bytes += st.size;
          files++;
        }
      } catch {
        // vanished while walking
      }
    }
  }
  return { bytes, files };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** Number of rows in the runs table, or null when the database cannot be read. */
function countRuns(): number | null {
  if (!existsSync(DB_PATH)) return 0;
  let db: Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true, create: false });
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get();
    return row?.n ?? 0;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** Why this directory must never be wiped (a wrong AUTO_DATA_DIR would otherwise delete something precious), or null. */
export function unsafeWipeReason(dir: string): string | null {
  const target = resolve(dir);
  const home = resolve(homedir());
  const workspace = resolve(WORKSPACE_ROOT);
  if (dirname(target) === target) return "it is a filesystem root";
  if (target === home || home.startsWith(target + sep)) return "it is your home directory or one of its parents";
  if (target === workspace || workspace.startsWith(target + sep)) return "it contains the workspace (config and workers)";
  return null;
}

/**
 * What a wipe would touch: the entries of `dir` Auto created, and the ones it
 * did not (left alone, since an AUTO_DATA_DIR that points at the wrong
 * directory must not lose someone else's files).
 */
export function wipePlan(dir: string): { own: string[]; foreign: string[] } {
  const own: string[] = [];
  const foreign: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { own, foreign };
  }
  for (const name of names.sort()) (isAutoDataEntry(name) ? own : foreign).push(name);
  return { own, foreign };
}

export async function runDataWipe(): Promise<number> {
  const unsafe = unsafeWipeReason(DATA_DIR);
  if (unsafe) {
    status(`refusing to wipe ${DATA_DIR}: ${unsafe}. Check AUTO_DATA_DIR.`);
    return EX.ERR;
  }
  if (!existsSync(DATA_DIR)) {
    status(`nothing to wipe: ${DATA_DIR} does not exist`);
    return EX.OK;
  }

  const plan = wipePlan(DATA_DIR);
  if (plan.own.length === 0) {
    if (plan.foreign.length === 0) {
      status(`nothing to wipe: ${DATA_DIR} is empty`);
      return EX.OK;
    }
    status(`refusing to wipe ${DATA_DIR}: it holds no Auto data (no automations.db, .token, runs/ or state/). Check AUTO_DATA_DIR.`);
    return EX.ERR;
  }

  // Never delete the database of a live supervisor.
  const client = getApiClient();
  if ((await client.reachable()) || runningSupervisorPid() !== null) {
    status("the supervisor is running; stop it first with `auto svc stop`");
    return EX.ERR;
  }

  const runs = countRuns();
  const usage = { bytes: 0, files: 0 };
  for (const name of plan.own) {
    const full = resolve(DATA_DIR, name);
    try {
      if (lstatSync(full).isDirectory()) {
        const u = directoryUsage(full);
        usage.bytes += u.bytes;
        usage.files += u.files;
      } else {
        usage.bytes += lstatSync(full).size;
        usage.files += 1;
      }
    } catch {
      // vanished
    }
  }
  if (globals().json && !globals().yes) {
    // A prompt cannot be answered on a machine-readable stream.
    status("--json needs --yes for a wipe (nothing was deleted)");
    return EX.USAGE;
  }
  if (!globals().json) {
    println(color.red("WARNING") + ": this permanently deletes:");
    println(`  path      ${DATA_DIR}`);
    println(`  runs      ${runs === null ? "unknown (database unreadable)" : runs} in the run history, plus their log files`);
    println(`  on disk   ${fmtBytes(usage.bytes)} in ${usage.files} file${usage.files === 1 ? "" : "s"}`);
    println("  also      stored secrets and the API token");
    if (plan.foreign.length > 0) {
      println(`  kept      ${plan.foreign.length} other entr${plan.foreign.length === 1 ? "y" : "ies"} Auto did not create (${plan.foreign.slice(0, 5).join(", ")}${plan.foreign.length > 5 ? ", ..." : ""})`);
    }
    println(color.dim("The config and workers in the workspace are not touched."));
    println("");
  }

  if (!globals().yes) {
    if (!isStdinTty()) {
      status("not interactive; pass --yes to confirm the wipe");
      return EX.ERR;
    }
    const r = await ask<{ value?: string }>({
      type: "text",
      name: "value",
      message: "Type 'wipe' to confirm:",
    });
    if (r.value !== "wipe") {
      status("aborted: you did not type 'wipe'");
      return EX.ERR;
    }
  }

  try {
    // Only what Auto created: never the whole directory tree.
    for (const name of plan.own) rmSync(resolve(DATA_DIR, name), { recursive: true, force: true });
    if (plan.foreign.length === 0) rmdirSync(DATA_DIR);
  } catch (err) {
    status(`could not delete ${DATA_DIR}: ${err instanceof Error ? err.message : String(err)}`);
    return EX.ERR;
  }
  if (globals().json) printJson({ ok: true, path: DATA_DIR, runs, bytes: usage.bytes, files: usage.files });
  status(`wiped ${DATA_DIR}`);
  status("run `auto install` (or `auto svc start`) to start again with a fresh database and token");
  return EX.OK;
}
