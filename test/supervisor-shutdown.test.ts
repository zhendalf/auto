import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHUTDOWN_GRACE_MS, SHUTDOWN_HARD_DEADLINE_MS } from "../supervisor/lifecycle.ts";
import { isPidAlive } from "../supervisor/process-identity.ts";
import { cleanEnv } from "./cli-harness.ts";

// End-to-end lifecycle: the real supervisor process in a private workspace
// with a long-sleeping worker. Covers graceful shutdown (SIGTERM/SIGINT/SIGHUP),
// and recovery after the supervisor is SIGKILLed mid-run.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SUPERVISOR_MAIN = resolve(REPO_ROOT, "supervisor/main.ts");
// Runs until killed and ignores SIGTERM (sleep-worker.ts exits by itself after 5 s).
const HANG_WORKER = resolve(HERE, "fixtures", "hang-worker.ts");
const PORT = Number(process.env.SUPERVISOR_TEST_PORT ?? 17910);

type Running = {
  proc: ReturnType<typeof Bun.spawn>;
  output: () => string;
};

let tmp: string;
let home: string;
let dataDir: string;
let started: Running[] = [];
let strays: number[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "supervisor-e2e-"));
  home = join(tmp, "home");
  dataDir = join(home, "data");
  mkdirSync(join(home, "jobs", "sleeper"), { recursive: true });
  copyFileSync(HANG_WORKER, join(home, "jobs", "sleeper", "worker.ts"));
  writeFileSync(
    join(home, "auto.config.ts"),
    `export default [{
  id: "sleeper",
  name: "sleeper",
  worker: "./jobs/sleeper/worker.ts",
  triggers: [{ kind: "cron", id: "never", schedule: "0 0 1 1 *" }],
  reentrancy: "drop",
  timeoutMs: 600000,
  killGraceMs: 1000,
}];\n`,
  );
  started = [];
  strays = [];
});

afterEach(() => {
  for (const s of started) {
    try {
      s.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function startSupervisor(): Running {
  const proc = Bun.spawn([process.execPath, SUPERVISOR_MAIN], {
    cwd: home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv(),
      HOME: tmp,
      AUTO_HOME: home,
      AUTO_DATA_DIR: dataDir,
      AUTO_PORT: String(PORT),
      AUTO_NOTIFY: "0",
    },
  });
  let text = "";
  for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) text += decoder.decode(chunk);
    })();
  }
  const running = { proc, output: () => text };
  started.push(running);
  return running;
}

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitHealthy(s: Running): Promise<void> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
      if (res.status === 200 || res.status === 503) return;
    } catch {
      // not up yet
    }
    if (s.proc.exitCode !== null) throw new Error(`supervisor exited early:\n${s.output()}`);
    await Bun.sleep(100);
  }
  throw new Error(`supervisor did not come up:\n${s.output()}`);
}

function readDb<T>(fn: (db: Database) => T): T {
  const db = new Database(join(dataDir, "automations.db"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type RunRow = {
  run_id: string;
  state: string;
  pid: number | null;
  finished_at: number | null;
  skip_reason: string | null;
  log_path: string | null;
};

const latestRun = (): RunRow | null =>
  readDb((db) =>
    db
      .query<RunRow, []>(
        "SELECT run_id, state, pid, finished_at, skip_reason, log_path FROM runs ORDER BY enqueued_at DESC LIMIT 1",
      )
      .get(),
  );

/** Trigger the sleeper job through the API and wait until its worker is running. */
async function startWorkerRun(): Promise<RunRow & { pid: number }> {
  const token = readFileSync(join(dataDir, ".token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/jobs/sleeper/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBeLessThan(300);
  const row = await waitFor("worker to start", () => {
    const r = latestRun();
    return r && r.state === "running" && r.pid ? (r as RunRow & { pid: number }) : null;
  });
  strays.push(row.pid);
  // Wait until the worker has installed its SIGTERM handler; a SIGTERM that
  // lands earlier kills it outright and the escalation path goes untested.
  await waitFor("worker to be ready", () => {
    const logPath = latestRun()?.log_path;
    return logPath && existsSync(join(dataDir, logPath)) && readFileSync(join(dataDir, logPath), "utf8").includes("hang-worker started");
  });
  return row;
}

const lockPath = () => join(dataDir, "supervisor.lock");

describe("graceful shutdown", () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    test(`${signal} terminates the worker, finalizes the run, removes the lock and exits in time`, async () => {
      const s = startSupervisor();
      await waitHealthy(s);
      expect(existsSync(lockPath())).toBe(true);
      const run = await startWorkerRun();
      expect(isPidAlive(run.pid)).toBe(true);

      const t0 = Date.now();
      s.proc.kill(signal);
      const code = await s.proc.exited;
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(SHUTDOWN_HARD_DEADLINE_MS);
      // The worker ignores SIGTERM, so stopping it took the job's killGraceMs (1 s).
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(code).toBe(0);
      // The worker (which ignores SIGTERM) is gone.
      await waitFor("worker to be gone", () => !isPidAlive(run.pid));
      // Nothing is left queued or running.
      const after = latestRun()!;
      expect(["queued", "running"]).not.toContain(after.state);
      expect(after.finished_at).not.toBeNull();
      // The lock is released.
      expect(existsSync(lockPath())).toBe(false);
      expect(s.output()).toContain("shutting down");
    }, 60_000);
  }

  test("state files are private and supervisor.log captures output", async () => {
    const s = startSupervisor();
    await waitHealthy(s);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    const log = join(dataDir, "state", "supervisor.log");
    await waitFor("supervisor.log output", () => existsSync(log) && readFileSync(log, "utf8").includes("[supervisor] up"));
    expect(statSync(log).mode & 0o777).toBe(0o600);
    s.proc.kill("SIGTERM");
    await s.proc.exited;
  }, 30_000);
});

describe("crash recovery", () => {
  test("after SIGKILL the next supervisor reaps the orphan worker, finalizes the row and takes the stale lock", async () => {
    const first = startSupervisor();
    await waitHealthy(first);
    const run = await startWorkerRun();

    first.proc.kill("SIGKILL");
    await first.proc.exited;
    // The worker outlived its supervisor and the lock file is a leftover.
    expect(isPidAlive(run.pid)).toBe(true);
    expect(existsSync(lockPath())).toBe(true);
    expect(readDbState(run.run_id)).toBe("running");

    const second = startSupervisor();
    await waitHealthy(second);
    await waitFor("orphan worker to be reaped", () => !isPidAlive(run.pid));
    const after = latestRun()!;
    expect(after.run_id).toBe(run.run_id);
    expect(after.state).toBe("failed");
    expect(after.skip_reason).toBe("supervisor_interrupted");
    expect(after.finished_at).not.toBeNull();
    expect(second.output()).toContain("recovery:");
    expect(second.output()).toMatch(/\[supervisor\] up .*recovered=\d+/);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(second.proc.pid);

    second.proc.kill("SIGTERM");
    await second.proc.exited;
    expect(existsSync(lockPath())).toBe(false);
  }, 90_000);

  test("a second supervisor while one is live exits cleanly without disturbing it", async () => {
    const first = startSupervisor();
    await waitHealthy(first);
    const second = startSupervisor();
    const code = await second.proc.exited;
    expect(code).toBe(0);
    expect(second.output()).toContain("already running");
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(first.proc.pid);
    first.proc.kill("SIGTERM");
    await first.proc.exited;
  }, 30_000);
});

function readDbState(runId: string): string | undefined {
  return readDb((db) =>
    db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(runId)?.state,
  );
}

test("the shutdown budget is consistent", () => {
  expect(SHUTDOWN_HARD_DEADLINE_MS).toBe(SHUTDOWN_GRACE_MS + 5_000);
});
