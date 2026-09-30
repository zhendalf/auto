import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { uuidv4 } from "../supervisor/db/ids.ts";
import { Runner, type Registry, type RunFinishedEvent, type TriggerCtx } from "../supervisor/runner.ts";
import type { Automation } from "../supervisor/config.ts";

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
  const tmp = mkdtempSync(join(tmpdir(), "runner-test-"));
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

/** Write a one-off sleep worker into the test tmp dir with the desired ms baked in. */
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

function manualCtx(): TriggerCtx {
  return { kind: "manual" };
}

/** Wait for run to finish. If the run.finished event already fired before
 * subscription, falls back to the DB row to synthesize an event. */
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
  // Already finished; recover from DB.
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

describe("Runner", () => {
  test("hello world: succeeds, log file populated, runs row complete", async () => {
    const job = makeJob({ name: "hello", worker: join(FIXTURES, "hello-worker.ts") });
    registerCronJob(ctx, "hello", job);

    const result = await ctx.runner.enqueue("hello", cronCtx("default"));
    expect(result.kind).toBe("started");
    if (result.kind !== "started") throw new Error("expected started");

    const ev = await waitForFinish(ctx.runner, result.run_id, ctx.db);
    expect(ev.state).toBe("succeeded");
    expect(ev.exit_code).toBe(0);

    const row = getRunRow(ctx.db, result.run_id);
    expect(row.state).toBe("succeeded");
    expect(row.exit_code).toBe(0);
    expect(typeof row.started_at).toBe("number");
    expect(typeof row.finished_at).toBe("number");
    expect(row.log_path).toBeTruthy();
    expect(row.definition_hash).toBeTruthy();
    expect(row.cwd).toBe(REPO_ROOT);

    const logAbs = join(ctx.dataDir, row.log_path);
    expect(existsSync(logAbs)).toBe(true);
    expect(row.log_path.startsWith("runs/")).toBe(true);
    const text = readFileSync(logAbs, "utf8");
    expect(text).toContain(`hello from RUN_ID=${result.run_id}`);
  });

  test("reentrancy=drop: second enqueue while running is skipped(overlap)", async () => {
    const worker = makeSleepWorker(ctx.tmp, "drop-sleep", 300, { honorSigterm: true });
    const job = makeJob({
      name: "drop-job",
      worker,
      reentrancy: "drop",
      timeoutMs: 5_000,
    });
    registerCronJob(ctx, "drop-job", job);

    const r1 = await ctx.runner.enqueue("drop-job", cronCtx("default"));
    expect(r1.kind).toBe("started");
    if (r1.kind !== "started") throw new Error();

    const r2 = await ctx.runner.enqueue("drop-job", cronCtx("default"));
    expect(r2.kind).toBe("skipped");
    if (r2.kind !== "skipped") throw new Error();
    expect(r2.reason).toBe("overlap");

    await waitForFinish(ctx.runner, r1.run_id);

    const skipRow = getRunRow(ctx.db, r2.run_id);
    expect(skipRow.state).toBe("skipped");
    expect(skipRow.skip_reason).toBe("overlap");
  });

  test("reentrancy=queue, queueDepth=2: first runs, two queued, fourth skipped(queue_full)", async () => {
    const worker = makeSleepWorker(ctx.tmp, "queue-sleep", 150, { honorSigterm: true });
    const job = makeJob({
      name: "queue-job",
      worker,
      reentrancy: "queue",
      queueDepth: 2,
    });
    registerCronJob(ctx, "queue-job", job);

    const r1 = await ctx.runner.enqueue("queue-job", cronCtx("default"));
    const r2 = await ctx.runner.enqueue("queue-job", cronCtx("default"));
    const r3 = await ctx.runner.enqueue("queue-job", cronCtx("default"));
    const r4 = await ctx.runner.enqueue("queue-job", cronCtx("default"));

    expect(r1.kind).toBe("started");
    expect(r2.kind).toBe("queued");
    if (r2.kind === "queued") expect(r2.position).toBe(1);
    expect(r3.kind).toBe("queued");
    if (r3.kind === "queued") expect(r3.position).toBe(2);
    expect(r4.kind).toBe("skipped");
    if (r4.kind === "skipped") expect(r4.reason).toBe("queue_full");

    if (r1.kind !== "started") throw new Error();
    if (r2.kind !== "queued") throw new Error();
    if (r3.kind !== "queued") throw new Error();
    if (r4.kind !== "skipped") throw new Error();

    await waitForFinish(ctx.runner, r1.run_id);
    await waitForFinish(ctx.runner, r2.run_id);
    await waitForFinish(ctx.runner, r3.run_id);

    expect(getRunRow(ctx.db, r1.run_id).state).toBe("succeeded");
    expect(getRunRow(ctx.db, r2.run_id).state).toBe("succeeded");
    expect(getRunRow(ctx.db, r3.run_id).state).toBe("succeeded");
    expect(getRunRow(ctx.db, r4.run_id).state).toBe("skipped");
  });

  test("reentrancy=parallel: both start, both finish independently", async () => {
    const worker = makeSleepWorker(ctx.tmp, "par-sleep", 150, { honorSigterm: true });
    const job = makeJob({
      name: "par-job",
      worker,
      reentrancy: "parallel",
    });
    registerCronJob(ctx, "par-job", job);

    const r1 = await ctx.runner.enqueue("par-job", cronCtx("default"));
    const r2 = await ctx.runner.enqueue("par-job", cronCtx("default"));
    expect(r1.kind).toBe("started");
    expect(r2.kind).toBe("started");

    if (r1.kind !== "started" || r2.kind !== "started") throw new Error();
    const [e1, e2] = await Promise.all([
      waitForFinish(ctx.runner, r1.run_id),
      waitForFinish(ctx.runner, r2.run_id),
    ]);
    expect(e1.state).toBe("succeeded");
    expect(e2.state).toBe("succeeded");
  });

  test("manual conflict: without force returns conflict; with force starts", async () => {
    const worker = makeSleepWorker(ctx.tmp, "manual-sleep", 300, { honorSigterm: true });
    const job = makeJob({
      name: "manual-job",
      worker,
      reentrancy: "drop",
    });
    registerCronJob(ctx, "manual-job", job);

    const r1 = await ctx.runner.enqueue("manual-job", cronCtx("default"));
    expect(r1.kind).toBe("started");
    if (r1.kind !== "started") throw new Error();

    const r2 = await ctx.runner.enqueue("manual-job", manualCtx());
    expect(r2.kind).toBe("conflict");
    if (r2.kind === "conflict") expect(r2.running_run_id).toBe(r1.run_id);

    const r3 = await ctx.runner.enqueue("manual-job", manualCtx(), { force: true });
    expect(r3.kind).toBe("started");

    if (r3.kind !== "started") throw new Error();
    await waitForFinish(ctx.runner, r1.run_id);
    await waitForFinish(ctx.runner, r3.run_id);
  });

  test("timeout: SIGTERM then SIGKILL; state=timed_out, signal recorded", async () => {
    // Long sleep; process ignores SIGTERM by default so SIGKILL fires.
    const worker = makeSleepWorker(ctx.tmp, "timeout-sleep", 10_000, { honorSigterm: false });
    const job = makeJob({
      name: "timeout-job",
      worker,
      timeoutMs: 300,
      killGraceMs: 200,
    });
    registerCronJob(ctx, "timeout-job", job);

    const r1 = await ctx.runner.enqueue("timeout-job", cronCtx("default"));
    expect(r1.kind).toBe("started");
    if (r1.kind !== "started") throw new Error();

    const start = Date.now();
    const ev = await waitForFinish(ctx.runner, r1.run_id, ctx.db);
    const elapsed = Date.now() - start;

    expect(ev.state).toBe("timed_out");
    expect(elapsed).toBeLessThan(1500);
    const row = getRunRow(ctx.db, r1.run_id);
    expect(row.state).toBe("timed_out");
    // Signal can be SIGTERM if it died on TERM, or SIGKILL after grace.
    expect(row.signal === null ? "" : String(row.signal)).toMatch(/SIG(TERM|KILL)/);
  });

  test("cancel queued: state=cancelled, no started_at", async () => {
    const worker = makeSleepWorker(ctx.tmp, "cancel-q-sleep", 400, { honorSigterm: true });
    const job = makeJob({
      name: "cancel-q-job",
      worker,
      reentrancy: "queue",
      queueDepth: 2,
    });
    registerCronJob(ctx, "cancel-q-job", job);

    const r1 = await ctx.runner.enqueue("cancel-q-job", cronCtx("default"));
    const r2 = await ctx.runner.enqueue("cancel-q-job", cronCtx("default"));
    if (r1.kind !== "started" || r2.kind !== "queued") throw new Error();

    const cancel = await ctx.runner.cancel(r2.run_id);
    expect(cancel.ok).toBe(true);
    expect(cancel.previous_state).toBe("queued");

    const queuedRow = getRunRow(ctx.db, r2.run_id);
    expect(queuedRow.state).toBe("cancelled");
    expect(queuedRow.started_at).toBeNull();
    expect(typeof queuedRow.finished_at).toBe("number");

    await waitForFinish(ctx.runner, r1.run_id);
  });

  test("cancel running: state=killed", async () => {
    const worker = makeSleepWorker(ctx.tmp, "cancel-r-sleep", 10_000, { honorSigterm: false });
    const job = makeJob({
      name: "cancel-r-job",
      worker,
      reentrancy: "drop",
      killGraceMs: 200,
    });
    registerCronJob(ctx, "cancel-r-job", job);

    const r1 = await ctx.runner.enqueue("cancel-r-job", cronCtx("default"));
    if (r1.kind !== "started") throw new Error();

    // Give the child a moment to actually start.
    await new Promise((r) => setTimeout(r, 100));

    const c = await ctx.runner.cancel(r1.run_id);
    expect(c.ok).toBe(true);
    expect(c.previous_state).toBe("running");

    const ev = await waitForFinish(ctx.runner, r1.run_id, ctx.db);

    expect(ev.state).toBe("killed");
    const row = getRunRow(ctx.db, r1.run_id);
    expect(row.state).toBe("killed");
  });

  test("disabled job: cron skipped(disabled), manual without force also skipped(disabled)", async () => {
    const job = makeJob({
      name: "disabled-job",
      worker: join(FIXTURES, "hello-worker.ts"),
      enabled: false,
    });
    registerCronJob(ctx, "disabled-job", job);

    const r1 = await ctx.runner.enqueue("disabled-job", cronCtx("default"));
    expect(r1.kind).toBe("skipped");
    if (r1.kind === "skipped") expect(r1.reason).toBe("disabled");

    const r2 = await ctx.runner.enqueue("disabled-job", manualCtx());
    expect(r2.kind).toBe("skipped");
    if (r2.kind === "skipped") expect(r2.reason).toBe("disabled");

    // Manual + force still runs.
    const r3 = await ctx.runner.enqueue("disabled-job", manualCtx(), { force: true });
    expect(r3.kind).toBe("started");
    if (r3.kind !== "started") throw new Error();
    await waitForFinish(ctx.runner, r3.run_id);
  });

  test("redaction: stdout containing a secret value gets redacted in log file", async () => {
    // Standalone setup so we can inject a `secrets` function distinct from
    // the shared ctx fixture.
    const tmp2 = mkdtempSync(join(tmpdir(), "runner-redact-"));
    const dbPath = join(tmp2, "test.db");
    const dataDir2 = tmp2;
    const logsDir = join(dataDir2, "runs");
    const db = new Database(dbPath);
    db.run("PRAGMA foreign_keys = ON;");
    await runMigrations(db);
    const registry = new MutableRegistry();
    const runner = new Runner({
      db,
      registry,
      workspaceRoot: REPO_ROOT,
      dataDir: dataDir2,
      logsDir,
      secrets: () => [{ name: "API_KEY", value: "tops3cret-value" }],
    });

    // Use an inline worker that prints the literal secret to stdout.
    const fs = await import("node:fs");
    const inlineWorker = join(tmp2, "inline-leak.ts");
    fs.writeFileSync(
      inlineWorker,
      'process.stdout.write("seen: tops3cret-value\\n");\nprocess.exit(0);\n',
    );

    const job = makeJob({ name: "leak", worker: inlineWorker });
    const jobId = registry.set("leak", job);
    insertJobRow(db, jobId, "leak");
    insertTriggerRow(db, `leak:default`, jobId, "cron", JSON.stringify(job.triggers[0]));

    const r = await runner.enqueue("leak", cronCtx("default"));
    if (r.kind !== "started") throw new Error("expected started");
    const ev = await waitForFinish(runner, r.run_id, db);
    expect(ev.state).toBe("succeeded");

    const row = db.prepare("SELECT log_path FROM runs WHERE run_id = ?").get(r.run_id) as { log_path: string };
    expect(row.log_path.startsWith("runs/")).toBe(true);
    const logAbs = join(dataDir2, row.log_path);
    const text = readFileSync(logAbs, "utf8");
    expect(text).toContain("[redacted:API_KEY]");
    expect(text).not.toContain("tops3cret-value");

    await runner.shutdown(2000);
    db.close();
    rmSync(tmp2, { recursive: true, force: true });
  });
});
