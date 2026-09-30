import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConditionEvaluator } from "../supervisor/condition-evaluator.ts";
import type { Automation, CronTrigger } from "../supervisor/config.ts";
import { uuidv7 } from "../supervisor/db/ids.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];
const dbs: Database[] = [];
const runners: Runner[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const r of runners.splice(0)) await r.shutdown(500).catch(() => {});
  for (const d of dbs.splice(0)) {
    try { d.close(); } catch {}
  }
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(opts: {
  checker: string;
  worker?: string;
  reentrancy?: Automation["reentrancy"];
  checkerTimeoutMs?: number;
  killGraceMs?: number;
}) {
  const tmp = mkdtempSync(join(tmpdir(), "condition-recovery-"));
  temps.push(tmp);
  const db = new Database(join(tmp, "test.db"));
  dbs.push(db);
  await runMigrations(db);
  const trigger: CronTrigger = {
    kind: "cron", id: "watch", schedule: "* * * * *",
    condition: { checker: opts.checker, timeoutMs: opts.checkerTimeoutMs ?? 5_000 },
  };
  const job: Automation = {
    id: "cjob", name: "cjob", worker: opts.worker ?? "./test/fixtures/hello-worker.ts",
    triggers: [trigger], reentrancy: opts.reentrancy ?? "drop", queueDepth: 1,
    timeoutMs: 10_000, killGraceMs: 200, enabled: true,
  };
  const registry = new JobRegistry({ db });
  registry.reconcile([job]);
  const mkRunner = () => {
    const r = new Runner({ db, registry, workspaceRoot: ROOT, dataDir: tmp, logsDir: join(tmp, "runs") });
    runners.push(r);
    return r;
  };
  const mkEvaluator = (runner: Runner) =>
    new ConditionEvaluator({ db, runner, workspaceRoot: ROOT, killGraceMs: opts.killGraceMs ?? 200 });
  const runner = mkRunner();
  const evaluator = mkEvaluator(runner);
  return { tmp, db, job, trigger, registry, runner, evaluator, mkRunner, mkEvaluator, triggerId: "cjob:watch" };
}

function write(ctx: { tmp: string }, name: string, body: string): string {
  const path = join(ctx.tmp, name);
  writeFileSync(path, body);
  return path;
}

function tmpFor(): { tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "condition-scripts-"));
  temps.push(tmp);
  return { tmp };
}

function stateRow(db: Database, triggerId = "cjob:watch") {
  return db.query<
    { state_json: string | null; pending_run_id: string | null; pending_state_json: string | null; consecutive_failures: number; last_error: string | null },
    [string]
  >("SELECT * FROM condition_states WHERE trigger_id = ?").get(triggerId);
}

function insertRun(db: Database, jobId: string, state: string, opts: { triggerId?: string } = {}): string {
  const runId = uuidv7();
  db.prepare(
    `INSERT INTO runs (run_id, job_id, trigger_id, trigger_kind, state, enqueued_at) VALUES (?, ?, ?, 'cron', ?, ?)`,
  ).run(runId, jobId, opts.triggerId ?? "cjob:watch", state, Date.now());
  return runId;
}

function jobIdOf(ctx: Setup): string {
  return ctx.db.query<{ job_id: string }, []>("SELECT job_id FROM jobs").get()!.job_id;
}

const SCRIPT_HEAD = `const input = await new Response(Bun.stdin.stream()).json();`;

/** Checker that records what it was given, then fires with cursor "c<n>" derived from the input. */
function recordingFireChecker(dir: { tmp: string }, name = "record-fire.ts"): { path: string; inputsFile: string; inputs: () => any[] } {
  const inputsFile = join(dir.tmp, `${name}.inputs`);
  const path = write(dir, name, `
    import { appendFileSync } from "node:fs";
    ${SCRIPT_HEAD}
    appendFileSync(${JSON.stringify(inputsFile)}, JSON.stringify(input) + "\\n");
    const n = (input.previousState?.n ?? 0) + 1;
    process.stdout.write(JSON.stringify({ fire: true, state: { n }, meta: { n } }));
  `);
  return {
    path,
    inputsFile,
    inputs: () => (existsSync(inputsFile) ? readFileSync(inputsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

// ---------------------------------------------------------------------------
// Checker failure modes
// ---------------------------------------------------------------------------

describe("checker failure modes", () => {
  test("non-zero exit is an error with the stderr text, state untouched", async () => {
    const dir = tmpFor();
    const checker = write(dir, "boom.ts", `process.stderr.write("kaboom"); process.exit(3);`);
    const ctx = await setup({ checker });
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res).toEqual({ kind: "error", error: "condition checker exited 3: kaboom" });
    const row = stateRow(ctx.db)!;
    expect(row.consecutive_failures).toBe(1);
    expect(row.state_json).toBeNull();
    expect(row.pending_run_id).toBeNull();
    expect(ctx.db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  test("invalid JSON and a missing boolean 'fire' are errors", async () => {
    const dir = tmpFor();
    const bad = write(dir, "badjson.ts", `process.stdout.write("this is not json");`);
    const ctx = await setup({ checker: bad });
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res).toEqual({ kind: "error", error: "condition checker stdout is not valid JSON" });

    const nofire = write(dir, "nofire.ts", `process.stdout.write(JSON.stringify({ state: {} }));`);
    const ctx2 = await setup({ checker: nofire });
    const res2 = await ctx2.evaluator.evaluate(ctx2.job, ctx2.trigger);
    expect(res2).toEqual({ kind: "error", error: "condition checker result must contain boolean fire" });
    expect(stateRow(ctx2.db)!.consecutive_failures).toBe(1);
  });

  test("timeout kills the checker's whole process group (SIGTERM ignored -> SIGKILL)", async () => {
    const dir = tmpFor();
    const pids = join(dir.tmp, "pids.json");
    const checker = write(dir, "hang.ts", `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      const gc = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ self: process.pid, gc: gc.pid }));
      setInterval(() => {}, 1000);
    `);
    const ctx = await setup({ checker, checkerTimeoutMs: 400, killGraceMs: 150 });
    const t0 = Date.now();
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toContain("timed out after 400ms");

    const { self, gc } = JSON.parse(readFileSync(pids, "utf8")) as { self: number; gc: number };
    strays.push(self, gc);
    await waitFor(() => !isAlive(self) && !isAlive(gc), 3_000);
    expect(stateRow(ctx.db)!.consecutive_failures).toBe(1);
  });

  test("oversized output is an error and the checker is killed, not left running", async () => {
    const dir = tmpFor();
    const pidFile = join(dir.tmp, "big.pid");
    const checker = write(dir, "big.ts", `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on("SIGTERM", () => {});
      process.stdout.write("x".repeat(2 * 1024 * 1024));
      setInterval(() => {}, 1000);
    `);
    const ctx = await setup({ checker, killGraceMs: 150 });
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toContain("output exceeds");
    const pid = Number(readFileSync(pidFile, "utf8"));
    strays.push(pid);
    await waitFor(() => !isAlive(pid), 3_000);
  });

  test("oversized state is rejected", async () => {
    const dir = tmpFor();
    const checker = write(dir, "bigstate.ts", `process.stdout.write(JSON.stringify({ fire: false, state: "y".repeat(20000) }));`);
    const ctx = await setup({ checker });
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toContain("condition state exceeds");
  });

  test("a checker that never reads stdin cannot stall evaluation past its timeout", async () => {
    const dir = tmpFor();
    const checker = write(dir, "deaf.ts", `setInterval(() => {}, 1000);`);
    const ctx = await setup({ checker, checkerTimeoutMs: 300, killGraceMs: 100 });
    const t0 = Date.now();
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("error");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Pending markers
// ---------------------------------------------------------------------------

describe("pending run tracking", () => {
  test("enqueue returning skipped does not advance state or set a pending marker; the next tick re-fires", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const ctx = await setup({ checker: rec.path });
    ctx.db.prepare("UPDATE jobs SET paused_until = ?").run(Date.now() + 60_000);

    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("fired");
    if (res.kind === "fired") expect(res.enqueue).toMatchObject({ kind: "skipped", reason: "paused" });
    let row = stateRow(ctx.db)!;
    expect(row.pending_run_id).toBeNull();
    expect(row.state_json).toBeNull(); // not advanced

    ctx.db.prepare("UPDATE jobs SET paused_until = NULL").run();
    const again = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(again.kind).toBe("fired");
    if (again.kind === "fired") expect(again.enqueue.kind).toBe("started");
    // The checker was shown the same (empty) previous state both times.
    expect(rec.inputs().map((i) => i.previousState)).toEqual([null, null]);
    await waitFor(() => stateRow(ctx.db)!.pending_run_id === null);
    row = stateRow(ctx.db)!;
    expect(JSON.parse(row.state_json!)).toEqual({ n: 1 });
  });

  test("a queued conditional run that is cancelled re-arms the trigger without advancing state", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const sleeper = write(dir, "sleeper.ts", `setTimeout(() => process.exit(0), 3000);`);
    const ctx = await setup({ checker: rec.path, worker: sleeper, reentrancy: "queue" });

    // Keep the job busy so the conditional run is queued.
    const busy = await ctx.runner.enqueue("cjob", { kind: "manual" });
    expect(busy.kind).toBe("started");

    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("fired");
    if (res.kind !== "fired" || res.enqueue.kind !== "queued") throw new Error("expected queued");
    const queuedId = res.enqueue.run_id;
    expect(stateRow(ctx.db)!.pending_run_id).toBe(queuedId);

    // While it waits the trigger stays suppressed.
    const suppressed = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(suppressed).toEqual({ kind: "suppressed", pending_run_id: queuedId });
    expect(rec.inputs().length).toBe(1);

    await ctx.runner.cancel(queuedId);
    expect(stateRow(ctx.db)!.pending_run_id).toBeNull();
    expect(stateRow(ctx.db)!.state_json).toBeNull(); // never advanced

    await ctx.runner.cancel(busy.kind === "started" ? busy.run_id : "");
    await waitFor(() => ctx.runner.active().length === 0);

    const after = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(after.kind).toBe("fired");
    expect(rec.inputs().map((i) => i.previousState)).toEqual([null, null]);
  });

  test("a pending run that failed (event missed) is cleared at evaluation time and state stays put", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const ctx = await setup({ checker: rec.path });
    const failedRun = insertRun(ctx.db, jobIdOf(ctx), "failed");
    ctx.db.prepare(
      `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
       VALUES ('cjob:watch', '{"n":5}', ?, '{"n":6}', ?)`,
    ).run(failedRun, Date.now());

    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("fired");
    // The checker saw the old committed state, not the failed run's pending one.
    expect(rec.inputs()[0].previousState).toEqual({ n: 5 });
  });

  test("terminal states other than success (killed, timed_out, cancelled, skipped) never advance state", async () => {
    for (const state of ["killed", "timed_out", "cancelled", "skipped"]) {
      const dir = tmpFor();
      const rec = recordingFireChecker(dir);
      const ctx = await setup({ checker: rec.path });
      const run = insertRun(ctx.db, jobIdOf(ctx), state);
      ctx.db.prepare(
        `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
         VALUES ('cjob:watch', '{"n":1}', ?, '{"n":2}', ?)`,
      ).run(run, Date.now());
      await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
      expect(rec.inputs()[0].previousState).toEqual({ n: 1 });
    }
  });

  test("a pending run that actually succeeded (event missed) commits its pending state", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const ctx = await setup({ checker: rec.path });
    const okRun = insertRun(ctx.db, jobIdOf(ctx), "succeeded");
    ctx.db.prepare(
      `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
       VALUES ('cjob:watch', '{"n":5}', ?, '{"n":6}', ?)`,
    ).run(okRun, Date.now());

    await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(rec.inputs()[0].previousState).toEqual({ n: 6 });
  });

  test("a pending run the database calls 'running' but the runner does not hold (crash) is not trusted", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const ctx = await setup({ checker: rec.path });
    const ghost = insertRun(ctx.db, jobIdOf(ctx), "running");
    ctx.db.prepare(
      `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
       VALUES ('cjob:watch', '{"n":1}', ?, '{"n":2}', ?)`,
    ).run(ghost, Date.now());

    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("fired");
    expect(rec.inputs()[0].previousState).toEqual({ n: 1 });
  });

  test("a pending run id with no runs row at all is cleared", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const ctx = await setup({ checker: rec.path });
    ctx.db.prepare(
      `INSERT INTO condition_states (trigger_id, state_json, pending_run_id, pending_state_json, updated_at)
       VALUES ('cjob:watch', '{"n":1}', 'no-such-run', '{"n":2}', ?)`,
    ).run(Date.now());
    const res = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(res.kind).toBe("fired");
    expect(rec.inputs()[0].previousState).toEqual({ n: 1 });
  });

  test("a genuinely live pending run still suppresses evaluation", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const sleeper = write(dir, "sleeper2.ts", `setTimeout(() => process.exit(0), 3000);`);
    const ctx = await setup({ checker: rec.path, worker: sleeper });
    const first = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    if (first.kind !== "fired" || first.enqueue.kind !== "started") throw new Error("expected started");
    const second = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(second).toEqual({ kind: "suppressed", pending_run_id: first.enqueue.run_id });
    expect(rec.inputs().length).toBe(1);
  });

  test("overlapping evaluations of the same trigger do not both fire", async () => {
    const dir = tmpFor();
    const slowChecker = write(dir, "slow.ts", `
      ${SCRIPT_HEAD}
      await Bun.sleep(400);
      process.stdout.write(JSON.stringify({ fire: true, state: { n: 1 } }));
    `);
    const ctx = await setup({ checker: slowChecker });
    const [a, b] = await Promise.all([
      ctx.evaluator.evaluate(ctx.job, ctx.trigger),
      ctx.evaluator.evaluate(ctx.job, ctx.trigger),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["fired", "suppressed"]);
    await waitFor(() => ctx.runner.active().length === 0);
    expect(ctx.db.query("SELECT count(*) AS n FROM runs WHERE trigger_kind = 'cron'").get()).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------
// Restart behaviour
// ---------------------------------------------------------------------------

describe("action failure across a restart", () => {
  test("a failed run leaves state unadvanced; a fresh evaluator on the same DB re-fires with the same input", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const failing = write(dir, "fail-worker.ts", `process.stderr.write("nope\\n"); process.exit(1);`);
    const ctx = await setup({ checker: rec.path, worker: failing });

    const first = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    if (first.kind !== "fired" || first.enqueue.kind !== "started") throw new Error("expected started");
    await waitFor(() => ctx.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(first.enqueue.kind === "started" ? first.enqueue.run_id : "")?.state === "failed");
    await waitFor(() => stateRow(ctx.db)!.pending_run_id === null);
    expect(stateRow(ctx.db)!.state_json).toBeNull(); // failure: not advanced

    // "Restart": new runner + new evaluator instance over the same database.
    const runner2 = ctx.mkRunner();
    const evaluator2 = ctx.mkEvaluator(runner2);
    const second = await evaluator2.evaluate(ctx.job, ctx.trigger);
    expect(second.kind).toBe("fired");
    expect(rec.inputs().map((i) => i.previousState)).toEqual([null, null]);
  });

  test("restart while the run outcome was never recorded: the new evaluator does not stay suppressed forever", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const sleeper = write(dir, "sleeper3.ts", `setTimeout(() => process.exit(0), 5000);`);
    const ctx = await setup({ checker: rec.path, worker: sleeper });

    const first = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    if (first.kind !== "fired" || first.enqueue.kind !== "started") throw new Error("expected started");
    // Simulate the supervisor dying with the run in flight: the old runner and
    // evaluator are gone (their events will never arrive), and startup recovery
    // has marked the orphaned row lost.
    await ctx.runner.shutdown(200);
    ctx.db.prepare("UPDATE runs SET state = 'running', finished_at = NULL WHERE run_id = ?").run(first.enqueue.run_id);
    ctx.db.prepare("UPDATE condition_states SET pending_run_id = ?").run(first.enqueue.run_id);

    const runner2 = ctx.mkRunner();
    const evaluator2 = ctx.mkEvaluator(runner2);
    const second = await evaluator2.evaluate(ctx.job, ctx.trigger);
    expect(second.kind).toBe("fired");
    expect(rec.inputs()[1].previousState).toBeNull();
  });

  test("a successful run advances state, and a restarted evaluator sees the committed value", async () => {
    const dir = tmpFor();
    const rec = recordingFireChecker(dir);
    const ctx = await setup({ checker: rec.path });
    const first = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(first.kind).toBe("fired");
    await waitFor(() => stateRow(ctx.db)!.pending_run_id === null);
    await waitFor(() => ctx.runner.active().length === 0);

    const runner2 = ctx.mkRunner();
    const evaluator2 = ctx.mkEvaluator(runner2);
    await evaluator2.evaluate(ctx.job, ctx.trigger);
    expect(rec.inputs().map((i) => i.previousState)).toEqual([null, { n: 1 }]);
  });
});
