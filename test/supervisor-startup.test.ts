import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { EX } from "../supervisor/lifecycle.ts";
import { cleanEnv } from "./cli-harness.ts";

// Startup failures of the real supervisor process: exit codes, notification
// de-duplication, refusing a database from a newer build, watchdog quietness.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SUPERVISOR_MAIN = resolve(REPO_ROOT, "supervisor/main.ts");
const PORT = Number(process.env.SUPERVISOR_TEST_PORT ?? 17910);

let tmp: string;
let home: string;
let dataDir: string;
let live: Array<ReturnType<typeof Bun.spawn>> = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "supervisor-startup-"));
  home = join(tmp, "home");
  dataDir = join(home, "data");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auto.config.ts"), "export default [];\n");
  live = [];
});

afterEach(() => {
  for (const p of live) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return {
    ...cleanEnv(),
    HOME: tmp,
    AUTO_HOME: home,
    AUTO_DATA_DIR: dataDir,
    AUTO_PORT: String(PORT),
    // notify() is silenced; notifyOnce still records that it would have notified.
    AUTO_NOTIFY: "0",
  };
}

async function runToExit(args: string[], timeoutMs = 20_000) {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: home, env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  live.push(proc);
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err, text: out + err };
}

function makeDb(): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return new Database(join(dataDir, "automations.db"));
}

const notifiedPath = () => join(dataDir, "state", "notified.json");

describe("startup failures", () => {
  test("a database with migrations this build does not know is refused untouched, exit 78, notified once", async () => {
    const db = makeDb();
    await runMigrations(db);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9999', 'from_the_future', 1)");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = db.query<{ n: number }, []>("SELECT count(*) AS n FROM schema_migrations").get()!.n;
    db.close();

    const first = await runToExit([SUPERVISOR_MAIN]);
    expect(first.code).toBe(EX.CONFIG);
    expect(first.text).toContain("refusing to start");
    expect(first.text).toContain("9999");
    expect(existsSync(join(dataDir, "supervisor.lock"))).toBe(false);
    const ts1 = JSON.parse(readFileSync(notifiedPath(), "utf8")) as Record<string, number>;
    expect(Object.keys(ts1).length).toBe(1);

    // The watchdog retries every minute; the same failure must not re-notify.
    const second = await runToExit([SUPERVISOR_MAIN]);
    expect(second.code).toBe(EX.CONFIG);
    expect(JSON.parse(readFileSync(notifiedPath(), "utf8"))).toEqual(ts1);

    // Nothing was written to the newer database.
    const check = new Database(join(dataDir, "automations.db"), { readonly: true });
    expect(check.query<{ n: number }, []>("SELECT count(*) AS n FROM schema_migrations").get()!.n).toBe(before);
    check.close();
  }, 60_000);

  test("--check also reports a newer database", async () => {
    const db = makeDb();
    await runMigrations(db);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9999', 'from_the_future', 1)");
    db.close();
    const res = await runToExit([SUPERVISOR_MAIN, "--check"]);
    expect(res.code).toBe(EX.CONFIG);
    expect(res.text).toContain("newer version");
  }, 30_000);

  test("an unreadable database exits non-zero (not 0) and is recorded", async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "automations.db"), "this is not a sqlite database".repeat(100));
    const res = await runToExit([SUPERVISOR_MAIN]);
    expect(res.code).toBe(EX.SOFTWARE);
    expect(res.text).toContain("db open failed");
    expect(existsSync(join(dataDir, "state", "last-error.txt"))).toBe(true);
    expect(existsSync(join(dataDir, "supervisor.lock"))).toBe(false);
  }, 30_000);

  test("a looser existing DATA_DIR is tightened to 0700 at startup", async () => {
    mkdirSync(dataDir, { recursive: true });
    chmodSync(dataDir, 0o755);
    const db = makeDb();
    await runMigrations(db);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9999', 'x', 1)");
    db.close();
    chmodSync(dataDir, 0o755);
    await runToExit([SUPERVISOR_MAIN]);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "state")).mode & 0o777).toBe(0o700);
  }, 30_000);
});

describe("command line", () => {
  test("--help and -h print the usage and exit 0; an unknown flag is still a usage error", async () => {
    for (const flag of ["--help", "-h"]) {
      const res = await runToExit([SUPERVISOR_MAIN, flag]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("usage: bun supervisor/main.ts");
    }
    const bad = await runToExit([SUPERVISOR_MAIN, "--nope"]);
    expect(bad.code).toBe(EX.USAGE);
    expect(bad.err).toContain("unknown argument");
  }, 30_000);
});

describe("watchdog tick", () => {
  const tick = `const m = await import(${JSON.stringify(SUPERVISOR_MAIN)}); await m.default.scheduled(); console.log("TICK_RETURNED");\n`;

  test("is silent and returns when a supervisor is already running", async () => {
    const supervisor = Bun.spawn([process.execPath, SUPERVISOR_MAIN], { cwd: home, env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    live.push(supervisor);
    const end = Date.now() + 15_000;
    let up = false;
    while (Date.now() < end && !up) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
        up = res.status === 200 || res.status === 503;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(up).toBe(true);
    const script = join(tmp, "tick.ts");
    writeFileSync(script, tick);
    const res = await runToExit([script]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("TICK_RETURNED");
    expect(res.text).not.toContain("already running");
    supervisor.kill("SIGTERM");
    await supervisor.exited;
  }, 40_000);

  test("fails loudly when startup fails, so the host scheduler records it", async () => {
    const db = makeDb();
    await runMigrations(db);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9999', 'x', 1)");
    db.close();
    const script = join(tmp, "tick.ts");
    writeFileSync(script, tick);
    const res = await runToExit([script]);
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain("TICK_RETURNED");
    expect(res.text).toContain("supervisor exited with code");
  }, 30_000);
});
