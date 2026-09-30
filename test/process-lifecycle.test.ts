import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConditionEvaluator } from "../supervisor/condition-evaluator.ts";
import type { Automation, CronTrigger } from "../supervisor/config.ts";
import { ConfigLoadError, ConfigStore, loadConfigOnce } from "../supervisor/config.ts";
import { isGroupAlive } from "../supervisor/process-identity.ts";
import { recoverInterruptedRuns } from "../supervisor/recovery.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";
import {
  REPO_ROOT,
  cronCtx,
  isAlive,
  killQuietly,
  makeJob,
  registerJob,
  setupHarness,
  teardownHarness,
  waitFor,
  waitTerminal,
  writeWorker,
  type Harness,
} from "./runner-harness.ts";

// Regression tests for processes that must not outlive a stop: a group member that
// ignores SIGTERM after cancel/timeout/shutdown/crash recovery, an in-flight
// condition checker at shutdown, and a config loader that never finishes.

let h: Harness;
const strays: number[] = [];

beforeEach(async () => {
  h = await setupHarness({ drainTimeoutMs: 300 });
});
afterEach(async () => {
  for (const pid of strays.splice(0)) killQuietly(pid);
  await teardownHarness(h);
});

/**
 * Source of a child that ignores SIGTERM. It writes its own pid only once the
 * handler is installed, so a test never signals it while it could still die of
 * the default disposition.
 */
function stubbornChildSource(pidFile: string): string {
  return `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
}

/**
 * A worker that starts a SIGTERM-ignoring child with NO stdio in common with it
 * (so nothing waits on a pipe and nothing else would ever signal the child),
 * records its pid, then idles. The worker itself dies on SIGTERM as usual.
 */
function stubbornChildWorker(name: string): { path: string; pidFile: string } {
  const pidFile = join(h.tmp, `${name}.pid`);
  const path = writeWorker(
    h,
    name,
    `const gc = Bun.spawn([process.execPath, "-e", ${JSON.stringify(stubbornChildSource(pidFile))}], {
       stdin: "ignore", stdout: "ignore", stderr: "ignore",
     });
     gc.unref();
     setInterval(() => {}, 1000);`,
  );
  return { path, pidFile };
}

async function readPid(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim().length > 0, 5_000, file);
  const pid = Number(readFileSync(file, "utf8"));
  strays.push(pid);
  return pid;
}

describe("a group member that ignores SIGTERM does not survive a deliberate stop", () => {
  test("cancel", async () => {
    const { path, pidFile } = stubbornChildWorker("stubborn-cancel");
    registerJob(h, makeJob({ name: "stubborn-cancel", worker: path, killGraceMs: 1_200 }));
    const r = await h.runner.enqueue("stubborn-cancel", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const child = await readPid(pidFile);
    expect(isAlive(child)).toBe(true);

    await h.runner.cancel(r.run_id);
    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("killed");
    await waitFor(() => !isAlive(child), 4_000, "the SIGTERM-ignoring child to be killed");
  });

  test("timeout", async () => {
    const { path, pidFile } = stubbornChildWorker("stubborn-timeout");
    registerJob(h, makeJob({ name: "stubborn-timeout", worker: path, timeoutMs: 400, killGraceMs: 1_200 }));
    const r = await h.runner.enqueue("stubborn-timeout", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const child = await readPid(pidFile);

    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("timed_out");
    await waitFor(() => !isAlive(child), 4_000, "the SIGTERM-ignoring child to be killed");
  });

  test("supervisor shutdown", async () => {
    const { path, pidFile } = stubbornChildWorker("stubborn-shutdown");
    registerJob(h, makeJob({ name: "stubborn-shutdown", worker: path, killGraceMs: 5_000 }));
    const r = await h.runner.enqueue("stubborn-shutdown", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const child = await readPid(pidFile);

    const t0 = Date.now();
    await h.runner.shutdown(1_000);
    expect(Date.now() - t0).toBeLessThan(3_500);
    // Nothing is left behind by the time shutdown() has resolved (allow the kernel a moment to reap).
    await waitFor(() => !isAlive(child), 1_500, "the child to be dead after shutdown");
    expect(h.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(r.run_id)).toMatchObject({ state: "killed" });
  });

  test("a run that ends by itself does not have its background children killed", async () => {
    // Only a deliberate stop reaps the group; a worker that exits normally and
    // leaves a daemon behind is not the runner's business.
    const pidFile = join(h.tmp, "daemon.pid");
    const path = writeWorker(
      h,
      "leaves-daemon",
      `import { writeFileSync } from "node:fs";
       const d = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
       d.unref();
       writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));`,
    );
    registerJob(h, makeJob({ name: "leaves-daemon", worker: path }));
    const r = await h.runner.enqueue("leaves-daemon", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const daemon = await readPid(pidFile);
    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("succeeded");
    await Bun.sleep(400);
    expect(isAlive(daemon)).toBe(true);
  });
});

describe("crash recovery kills the whole orphaned group", () => {
  test("a leader that exits on SIGTERM cannot hide a member that ignores it", async () => {
    const pidFile = join(h.tmp, "orphan-gc.pid");
    const script = writeWorker(
      h,
      "orphan-leader",
      `const gc = Bun.spawn([process.execPath, "-e", ${JSON.stringify(stubbornChildSource(pidFile))}], {
         stdin: "ignore", stdout: "ignore", stderr: "ignore",
       });
       gc.unref();
       setInterval(() => {}, 1000);`,
    );
    // A real orphan: started by a launcher that exits, so the leader is reparented and
    // is not this test's child (a zombie child would still look alive to a pid probe).
    const launcher = writeWorker(
      h,
      "launcher",
      `const leader = Bun.spawn([process.execPath, ${JSON.stringify(script)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
       leader.unref();
       process.stdout.write(String(leader.pid));
       process.exit(0);`,
    );
    const launched = Bun.spawn([process.execPath, launcher], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const leader = { pid: Number(await new Response(launched.stdout).text()) };
    await launched.exited;
    strays.push(leader.pid);
    const child = await readPid(pidFile);
    expect(isAlive(child)).toBe(true);
    expect(isGroupAlive(leader.pid)).toBe(true);

    const { jobId } = registerJob(h, makeJob({ name: "orphaned", worker: script }));
    h.db.prepare(
      `INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at, started_at, pid, worker_path, cwd)
       VALUES ('01900000-0000-7000-8000-000000000001', ?, 'manual', 'running', 1, 1, ?, ?, ?)`,
    ).run(jobId, leader.pid, script, REPO_ROOT);
    const result = recoverInterruptedRuns(h.db, { dataDir: h.dataDir, workspaceRoot: REPO_ROOT, termGraceMs: 300 });
    expect(result.killed).toEqual([leader.pid]);
    // The message said "terminated": nothing of that group may be left.
    expect(isAlive(child)).toBe(false);
    expect(isGroupAlive(leader.pid)).toBe(false);
  });
});

describe("a queued run does not start once its job is disabled in the config", () => {
  test("promoteNext consults the current definition, not the one captured at enqueue", async () => {
    const path = writeWorker(h, "slowish", `await Bun.sleep(700);\nconsole.log("ran");\n`);
    const job = makeJob({ name: "slowish", worker: path, reentrancy: "queue", queueDepth: 3 });
    registerJob(h, job);
    const first = await h.runner.enqueue("slowish", cronCtx());
    const second = await h.runner.enqueue("slowish", cronCtx());
    expect(first.kind).toBe("started");
    expect(second.kind).toBe("queued");
    if (second.kind !== "queued") throw new Error("unreachable");

    // What a hot reload with `enabled: false` does to the registry.
    h.registry.update("slowish", { ...job, enabled: false });
    const third = await h.runner.enqueue("slowish", cronCtx());
    expect(third).toMatchObject({ kind: "skipped", reason: "disabled" });

    await waitFor(() => (h.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(second.run_id) as { state: string }).state !== "queued", 6_000, "the queued run to be settled");
    const row = h.db.prepare("SELECT state, skip_reason, started_at FROM runs WHERE run_id = ?").get(second.run_id) as {
      state: string; skip_reason: string | null; started_at: number | null;
    };
    expect(row.state).toBe("cancelled");
    expect(row.skip_reason).toBe("disabled");
    expect(row.started_at).toBeNull();
  });

  test("a job removed from the config while runs wait for it cancels them too", async () => {
    const path = writeWorker(h, "vanishing", `await Bun.sleep(600);\n`);
    const job = makeJob({ name: "vanishing", worker: path, reentrancy: "queue", queueDepth: 2 });
    registerJob(h, job);
    await h.runner.enqueue("vanishing", cronCtx());
    const queued = await h.runner.enqueue("vanishing", cronCtx());
    if (queued.kind !== "queued") throw new Error("expected queued");
    h.registry.remove("vanishing");
    await waitFor(() => (h.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(queued.run_id) as { state: string }).state === "cancelled", 6_000, "the queued run to be cancelled");
  });
});

describe("shutdown stops in-flight condition checkers", () => {
  test("stop() ends a running checker, records nothing, and refuses further evaluations", async () => {
    const pidFile = join(h.tmp, "checker.pid");
    const checker = join(h.tmp, "slow-check.ts");
    writeFileSync(
      checker,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       await Bun.sleep(60000);`,
    );
    const trigger: CronTrigger = { kind: "cron", id: "watch", schedule: "* * * * *", condition: { checker, timeoutMs: 120_000 } };
    const job: Automation = {
      id: "cond", name: "cond", worker: "./test/fixtures/hello-worker.ts", triggers: [trigger],
      reentrancy: "drop", queueDepth: 1, timeoutMs: 5_000, killGraceMs: 100, enabled: true,
    };
    const registry = new JobRegistry({ db: h.db });
    registry.reconcile([job]);
    const runner = h.newRunner({ registry });
    const evaluator = new ConditionEvaluator({ db: h.db, runner, workspaceRoot: REPO_ROOT, killGraceMs: 200 });

    const pending = evaluator.evaluate(job, trigger);
    const pid = await readPid(pidFile);
    expect(isAlive(pid)).toBe(true);

    await evaluator.stop(300);
    expect(isAlive(pid)).toBe(false);
    const result = await pending;
    expect(result.kind).toBe("error");
    // An interrupted evaluation is not a checker failure: no bookkeeping row appears.
    expect(h.db.prepare("SELECT count(*) AS n FROM condition_states").get()).toEqual({ n: 0 });

    const after = await evaluator.evaluate(job, trigger);
    expect(after).toEqual({ kind: "error", error: "supervisor is shutting down" });
  });

  test("stop() with nothing running returns at once", async () => {
    const registry = new JobRegistry({ db: h.db });
    const evaluator = new ConditionEvaluator({ db: h.db, runner: h.runner, workspaceRoot: REPO_ROOT });
    const t0 = Date.now();
    await evaluator.stop(5_000);
    expect(Date.now() - t0).toBeLessThan(500);
    registry.close();
  });
});

describe("a config load in flight is cancelled with the store", () => {
  function processesMentioning(needle: string): string[] {
    const out = Bun.spawnSync(["ps", "-ax", "-o", "pid=,command="], { stdout: "pipe" }).stdout.toString();
    return out.split("\n").filter((l) => l.includes(needle) && !l.includes(" ps "));
  }

  function hangingWorkspace(): { ws: string; config: string } {
    const ws = mkdtempSync(join(tmpdir(), "hang-config-"));
    mkdirSync(join(ws, "jobs"), { recursive: true });
    const config = join(ws, "auto.config.ts");
    // A live handle plus an await that never resolves: only a kill ends this loader.
    writeFileSync(config, "setInterval(() => {}, 1000);\nawait new Promise(() => {});\nexport default [];\n");
    return { ws, config };
  }

  test("loadConfigOnce rejects on abort and leaves no loader process behind", async () => {
    const { ws, config } = hangingWorkspace();
    try {
      const ctrl = new AbortController();
      const loading = loadConfigOnce({ configPath: config, workspaceRoot: ws, signal: ctrl.signal, timeoutMs: 60_000 });
      await waitFor(() => processesMentioning(config).length > 0, 5_000, "the loader to start");
      ctrl.abort();
      await expect(loading).rejects.toBeInstanceOf(ConfigLoadError);
      await waitFor(() => processesMentioning(config).length === 0, 3_000, "the loader to be gone");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("ConfigStore.stop() aborts a load that never finishes", async () => {
    const { ws, config } = hangingWorkspace();
    const store = new ConfigStore({ configPath: config, workspaceRoot: ws, pollMs: 60_000 });
    try {
      const started = store.start();
      await waitFor(() => processesMentioning(config).length > 0, 5_000, "the loader to start");
      await store.stop();
      await started;
      await waitFor(() => processesMentioning(config).length === 0, 3_000, "the loader to be gone");
    } finally {
      await store.stop();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});
