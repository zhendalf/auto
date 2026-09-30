import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { uuidv4 } from "../supervisor/db/ids.ts";
import { Runner, type Registry, type RunFinishedEvent, type TriggerCtx } from "../supervisor/runner.ts";
import type { Automation } from "../supervisor/config.ts";
import { ManualAdapter, triggerManual } from "../supervisor/adapters/manual.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FIXTURES = resolve(HERE, "fixtures");

type Ctx = {
  tmp: string;
  dataDir: string;
  logsDir: string;
  db: Database;
  runner: Runner;
  registry: MutableRegistry;
};

class MutableRegistry implements Registry {
  private byName = new Map<string, { jobId: string; job: Automation }>();
  set(jobName: string, job: Automation): string {
    const jobId = uuidv4();
    this.byName.set(jobName, { jobId, job });
    return jobId;
  }
  resolve(jobName: string): { jobId: string; job: Automation } | null {
    return this.byName.get(jobName) ?? null;
  }
}

function makeJob(overrides: Partial<Automation> & { worker: string; name: string }): Automation {
  return {
    id: overrides.name,
    name: overrides.name,
    description: undefined,
    worker: overrides.worker,
    triggers: [{ kind: "cron", id: "default", schedule: "* * * * *" }],
    reentrancy: overrides.reentrancy ?? "drop",
    queueDepth: overrides.queueDepth ?? 1,
    timeoutMs: overrides.timeoutMs ?? 600_000,
    killGraceMs: overrides.killGraceMs ?? 10_000,
    enabled: overrides.enabled ?? true,
  };
}

async function setup(): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "manual-adapter-test-"));
  const dbPath = join(tmp, "test.db");
  const dataDir = tmp;
  const logsDir = join(dataDir, "runs");
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  const registry = new MutableRegistry();
  const runner = new Runner({
    db,
    registry,
    workspaceRoot: REPO_ROOT,
    dataDir,
    logsDir,
  });
  return { tmp, dataDir, logsDir, db, runner, registry };
}

function makeSleepWorker(tmp: string, name: string, sleepMs: number, opts?: { honorSigterm?: boolean }): string {
  const path = join(tmp, `${name}.ts`);
  const honor = opts?.honorSigterm
    ? `process.on("SIGTERM", () => { process.exit(0); });`
    : `process.on("SIGTERM", () => { /* swallow */ });`;
  const body = `${honor}\nsetTimeout(() => { process.stdout.write("done\\n"); process.exit(0); }, ${sleepMs});\n`;
  writeFileSync(path, body);
  return path;
}

function teardown(ctx: Ctx) {
  try {
    ctx.db.close();
  } catch {
    // ignore
  }
  try {
    rmSync(ctx.tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function insertJobRow(db: Database, jobId: string, name: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (job_id, name, enabled, last_seen_in_config_at, created_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(jobId, name, now, now);
}

function insertTriggerRow(db: Database, triggerId: string, jobId: string, kind: string, configJson: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO triggers (trigger_id, job_id, kind, config_json, enabled, last_seen_in_config_at, updated_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(triggerId, jobId, kind, configJson, now, now, now);
}

function registerCronJob(ctx: Ctx, jobName: string, job: Automation): { jobId: string; triggerId: string } {
  const jobId = ctx.registry.set(jobName, job);
  insertJobRow(ctx.db, jobId, jobName);
  const trig = job.triggers[0]!;
  const triggerId = `${jobName}:${trig.id}`;
  insertTriggerRow(ctx.db, triggerId, jobId, trig.kind, JSON.stringify(trig));
  return { jobId, triggerId };
}

function cronCtx(triggerId: string, fireAt = Date.now()): TriggerCtx {
  return { kind: "cron", trigger_id: triggerId, fire_at: fireAt };
}

async function waitForFinish(
  runner: Runner,
  runId: string,
  db?: Database,
): Promise<{ run_id: string; state: string; exit_code: number | null; signal: string | null; duration_ms: number }> {
  const ev = await new Promise<RunFinishedEvent | null>((resolve) => {
    const handler = (e: RunFinishedEvent) => {
      if (e.run_id === runId) {
        runner.off("run.finished", handler);
        resolve(e);
      }
    };
    runner.on("run.finished", handler);
    const stillActive = runner.active().some((a) => a.runId === runId);
    if (!stillActive) {
      runner.off("run.finished", handler);
      resolve(null);
    }
  });
  if (ev) return ev;
  if (!db) return { run_id: runId, state: "unknown", exit_code: null, signal: null, duration_ms: 0 };
  const row = db.prepare(
    "SELECT state, exit_code, signal, started_at, finished_at FROM runs WHERE run_id = ?",
  ).get(runId) as { state: string; exit_code: number | null; signal: string | null; started_at: number | null; finished_at: number | null } | null;
  if (!row) return { run_id: runId, state: "unknown", exit_code: null, signal: null, duration_ms: 0 };
  return {
    run_id: runId,
    state: row.state,
    exit_code: row.exit_code,
    signal: row.signal,
    duration_ms: (row.finished_at ?? 0) - (row.started_at ?? 0),
  };
}

function getRunRow(db: Database, runId: string): any {
  return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
}

let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await ctx.runner.shutdown(2_000);
  teardown(ctx);
});

describe("ManualAdapter", () => {
  test("happy path: triggers an idle job, run succeeds", async () => {
    const job = makeJob({ name: "hello", worker: join(FIXTURES, "hello-worker.ts") });
    registerCronJob(ctx, "hello", job);

    const adapter = new ManualAdapter({ runner: ctx.runner });
    const result = await adapter.trigger("hello");

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") throw new Error("expected started");
    expect(typeof result.run_id).toBe("string");

    await waitForFinish(ctx.runner, result.run_id, ctx.db);
    const row = getRunRow(ctx.db, result.run_id);
    expect(row.state).toBe("succeeded");
    expect(row.exit_code).toBe(0);
    expect(row.trigger_kind).toBe("manual");
  });

  test("conflict without force: returns conflict pointing at running run", async () => {
    const worker = makeSleepWorker(ctx.tmp, "manual-conflict-sleep", 400, { honorSigterm: true });
    const job = makeJob({ name: "busy", worker, reentrancy: "drop" });
    registerCronJob(ctx, "busy", job);

    // Get a run into the running state via a cron-kind enqueue so the
    // setup is unambiguous about *what* is running.
    const r1 = await ctx.runner.enqueue("busy", cronCtx("default"));
    expect(r1.kind).toBe("started");
    if (r1.kind !== "started") throw new Error("expected started");

    const result = await triggerManual(ctx.runner, "busy");
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    expect(result.running_run_id).toBe(r1.run_id);
    expect(result.suggested_action).toBe("force_or_cancel");

    await waitForFinish(ctx.runner, r1.run_id, ctx.db);
  });

  test("conflict with force: starts a parallel run", async () => {
    const worker = makeSleepWorker(ctx.tmp, "manual-force-sleep", 400, { honorSigterm: true });
    const job = makeJob({ name: "busy-force", worker, reentrancy: "drop" });
    registerCronJob(ctx, "busy-force", job);

    const r1 = await ctx.runner.enqueue("busy-force", cronCtx("default"));
    if (r1.kind !== "started") throw new Error("expected started");

    const adapter = new ManualAdapter({ runner: ctx.runner });
    const result = await adapter.trigger("busy-force", { force: true });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") throw new Error("expected started");

    // Two runs are active simultaneously now.
    const activeIds = ctx.runner.active().map((a) => a.runId).sort();
    expect(activeIds).toContain(r1.run_id);
    expect(activeIds).toContain(result.run_id);
    expect(activeIds.length).toBeGreaterThanOrEqual(2);

    await Promise.all([
      waitForFinish(ctx.runner, r1.run_id, ctx.db),
      waitForFinish(ctx.runner, result.run_id, ctx.db),
    ]);

    const forcedRow = getRunRow(ctx.db, result.run_id);
    expect(forcedRow.trigger_kind).toBe("manual");
    expect(forcedRow.state).toBe("succeeded");
  });

  test("unknown job: returns unknown_job result, does not throw", async () => {
    const adapter = new ManualAdapter({ runner: ctx.runner });
    let threw = false;
    let result: Awaited<ReturnType<typeof adapter.trigger>> | null = null;
    try {
      result = await adapter.trigger("does-not-exist");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    if (!result) throw new Error("no result");
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("unknown_job");
    if (result.outcome !== "unknown_job") throw new Error("expected unknown_job");
    expect(result.jobName).toBe("does-not-exist");
  });

  test("reason carries through into trigger_meta", async () => {
    const job = makeJob({ name: "with-reason", worker: join(FIXTURES, "hello-worker.ts") });
    registerCronJob(ctx, "with-reason", job);

    const adapter = new ManualAdapter({ runner: ctx.runner });
    const result = await adapter.trigger("with-reason", { reason: "rerun after fix" });
    expect(result.ok).toBe(true);
    if (result.outcome !== "started") throw new Error("expected started");

    const row = getRunRow(ctx.db, result.run_id);
    expect(row.trigger_kind).toBe("manual");
    expect(row.trigger_id).toBeNull();
    const meta = JSON.parse(row.trigger_meta);
    expect(meta).toEqual({ reason: "rerun after fix" });

    await waitForFinish(ctx.runner, result.run_id, ctx.db);
  });
});
