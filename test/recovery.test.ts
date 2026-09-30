import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { isPidAlive } from "../supervisor/process-identity.ts";
import {
  INTERRUPTED_REASON,
  recoveredTotal,
  recoverInterruptedRuns,
  SHUTDOWN_REASON,
} from "../supervisor/recovery.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SLEEP_WORKER = resolve(HERE, "fixtures", "sleep-worker.ts");

let tmp: string;
let dataDir: string;
let workspace: string;
let db: Database;
let cleanup: Array<() => void> = [];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "recovery-test-"));
  dataDir = join(tmp, "data");
  workspace = join(tmp, "workspace");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  db = new Database(join(tmp, "test.db"));
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  db.run(
    `INSERT INTO jobs (job_id, name, enabled, last_seen_in_config_at, created_at) VALUES ('job-1', 'demo', 1, 1, 1)`,
  );
  db.run(
    `INSERT INTO triggers (trigger_id, job_id, kind, config_json, enabled, last_seen_in_config_at, updated_at, created_at)
     VALUES ('demo:cond', 'job-1', 'cron', '{}', 1, 1, 1, 1)`,
  );
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

type RunSeed = {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  pid?: number | null;
  workerPath?: string | null;
  logPath?: string | null;
};

function seedRun(r: RunSeed): void {
  db.run(
    `INSERT INTO runs (run_id, job_id, trigger_id, trigger_kind, state, enqueued_at, started_at, pid, worker_path, log_path)
     VALUES (?, 'job-1', 'demo:cond', 'cron', ?, 100, ?, ?, ?, ?)`,
    [r.id, r.state, r.state === "queued" ? null : 110, r.pid ?? null, r.workerPath ?? null, r.logPath ?? null],
  );
}

function runRow(id: string) {
  return db
    .query<{ state: string; finished_at: number | null; skip_reason: string | null }, [string]>(
      "SELECT state, finished_at, skip_reason FROM runs WHERE run_id = ?",
    )
    .get(id)!;
}

function spawnSleeper(): { pid: number } {
  const child = Bun.spawn([process.execPath, SLEEP_WORKER], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, SLEEP_MS: "120000" },
  });
  cleanup.push(() => child.kill("SIGKILL"));
  return { pid: child.pid };
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !isPidAlive(pid);
}

describe("recoverInterruptedRuns", () => {
  test("a queued row is finalized as failed and never started", () => {
    seedRun({ id: "q1", state: "queued" });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace, now: 5000 });
    expect(result.queued).toBe(1);
    expect(result.running).toBe(0);
    const row = runRow("q1");
    expect(row.state).toBe("failed");
    expect(row.finished_at).toBe(5000);
    expect(row.skip_reason).toBe(INTERRUPTED_REASON);
  });

  test("a running row with a dead pid is finalized", () => {
    seedRun({ id: "r1", state: "running", pid: 999_999_1, workerPath: SLEEP_WORKER });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace, now: 5000 });
    expect(result.running).toBe(1);
    expect(result.killed).toEqual([]);
    expect(result.foreignPids).toEqual([]);
    expect(runRow("r1").state).toBe("failed");
  });

  test("a live pid that is not the recorded worker is NOT killed", () => {
    const foreign = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => foreign.kill("SIGKILL"));
    seedRun({ id: "r2", state: "running", pid: foreign.pid, workerPath: SLEEP_WORKER });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace });
    expect(result.killed).toEqual([]);
    expect(result.foreignPids).toEqual([foreign.pid]);
    expect(isPidAlive(foreign.pid)).toBe(true);
    expect(runRow("r2").state).toBe("failed");
  });

  test("a live pid whose command line matches the worker path is terminated", async () => {
    const worker = spawnSleeper();
    seedRun({ id: "r3", state: "running", pid: worker.pid, workerPath: SLEEP_WORKER });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace, termGraceMs: 300 });
    expect(result.killed).toEqual([worker.pid]);
    expect(await waitDead(worker.pid)).toBe(true);
    expect(runRow("r3").state).toBe("failed");
  });

  test("a worker that leads its own process group is terminated with its children", async () => {
    const script = join(tmp, "group-worker.ts");
    writeFileSync(
      script,
      `const child = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
require("node:fs").writeFileSync(process.env.CHILD_PID_FILE!, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    );
    const pidFile = join(tmp, "child.pid");
    const leader = Bun.spawn([process.execPath, script], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      env: { ...process.env, CHILD_PID_FILE: pidFile },
    });
    cleanup.push(() => {
      try {
        process.kill(-leader.pid, "SIGKILL");
      } catch {
        // gone
      }
    });
    const deadline = Date.now() + 5000;
    // The worker creates the file and then writes it: wait for the content, not just the file.
    while ((!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(grandchild).toBeGreaterThan(0);
    expect(isPidAlive(grandchild)).toBe(true);

    seedRun({ id: "r4", state: "running", pid: leader.pid, workerPath: script });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace, termGraceMs: 300 });
    expect(result.killed).toEqual([leader.pid]);
    expect(await waitDead(leader.pid)).toBe(true);
    expect(await waitDead(grandchild)).toBe(true);
  });

  test("where the command line cannot be read, rows are marked but no pid is signalled", () => {
    const worker = spawnSleeper();
    seedRun({ id: "r5", state: "running", pid: worker.pid, workerPath: SLEEP_WORKER });
    const result = recoverInterruptedRuns(db, {
      dataDir,
      workspaceRoot: workspace,
      commandLine: () => null,
    });
    expect(result.killed).toEqual([]);
    expect(result.foreignPids).toEqual([]);
    expect(isPidAlive(worker.pid)).toBe(true);
    expect(runRow("r5").state).toBe("failed");
  });

  test("never signals its own pid", () => {
    seedRun({ id: "r6", state: "running", pid: process.pid, workerPath: SLEEP_WORKER });
    const result = recoverInterruptedRuns(db, {
      dataDir,
      workspaceRoot: workspace,
      isAlive: () => true,
      commandLine: () => `bun ${SLEEP_WORKER}`,
    });
    expect(result.killed).toEqual([]);
    expect(runRow("r6").state).toBe("failed");
  });

  test("terminal rows are left alone", () => {
    seedRun({ id: "done", state: "succeeded" });
    seedRun({ id: "bad", state: "failed" });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace });
    expect(recoveredTotal(result)).toBe(0);
    expect(runRow("done").state).toBe("succeeded");
    expect(runRow("done").skip_reason).toBeNull();
  });

  test("a note is appended to the run log; a log path escaping data/ is ignored", () => {
    const rel = "runs/2026/01/01/r7.log";
    mkdirSync(join(dataDir, "runs/2026/01/01"), { recursive: true });
    writeFileSync(join(dataDir, rel), "original output\n");
    const outside = join(tmp, "outside.log");
    writeFileSync(outside, "outside\n");
    seedRun({ id: "r7", state: "running", pid: 999_999_1, logPath: rel });
    seedRun({ id: "r8", state: "queued", logPath: "../outside.log" });
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace });
    const log = readFileSync(join(dataDir, rel), "utf8");
    expect(log.startsWith("original output\n")).toBe(true);
    expect(log).toContain(INTERRUPTED_REASON);
    expect(result.logsAppended).toBe(1);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("a missing log file is not an error", () => {
    seedRun({ id: "r9", state: "queued", logPath: "runs/none.log" });
    expect(() => recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace })).not.toThrow();
    expect(runRow("r9").state).toBe("failed");
  });

  test("stale condition pending markers are cleared (or committed when the run succeeded)", () => {
    seedRun({ id: "p1", state: "running", pid: 999_999_1 });
    db.run(
      `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
       VALUES ('demo:cond', '{"v":1}', 'p1', '{"v":2}', 1)`,
    );
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace, now: 9000 });
    expect(result.conditionsCleared).toBe(1);
    const row = db
      .query<{ state_json: string; pending_run_id: string | null; pending_state_json: string | null }, []>(
        "SELECT state_json, pending_run_id, pending_state_json FROM condition_states WHERE trigger_id = 'demo:cond'",
      )
      .get()!;
    expect(row.pending_run_id).toBeNull();
    expect(row.pending_state_json).toBeNull();
    // The discarded state is not promoted: the trigger re-evaluates from the last committed state.
    expect(row.state_json).toBe('{"v":1}');
  });

  test("a pending marker whose run already succeeded is committed", () => {
    seedRun({ id: "p2", state: "succeeded" });
    db.run(
      `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
       VALUES ('demo:cond', '{"v":1}', 'p2', '{"v":2}', 1)`,
    );
    const result = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace });
    expect(result.conditionsCommitted).toBe(1);
    const row = db
      .query<{ state_json: string; pending_run_id: string | null }, []>(
        "SELECT state_json, pending_run_id FROM condition_states WHERE trigger_id = 'demo:cond'",
      )
      .get()!;
    expect(row.state_json).toBe('{"v":2}');
    expect(row.pending_run_id).toBeNull();
  });

  test("the shutdown phase uses its own reason and wording", () => {
    mkdirSync(join(dataDir, "runs"), { recursive: true });
    writeFileSync(join(dataDir, "runs/s1.log"), "");
    seedRun({ id: "s1", state: "running", pid: 999_999_1, logPath: "runs/s1.log" });
    recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace, phase: "shutdown" });
    expect(runRow("s1").skip_reason).toBe(SHUTDOWN_REASON);
    expect(readFileSync(join(dataDir, "runs/s1.log"), "utf8")).toContain("this supervisor shut down");
  });

  test("running twice is a no-op the second time", () => {
    seedRun({ id: "t1", state: "queued" });
    recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace });
    const second = recoverInterruptedRuns(db, { dataDir, workspaceRoot: workspace });
    expect(recoveredTotal(second)).toBe(0);
  });
});
