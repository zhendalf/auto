import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  SHUTDOWN_HARD_DEADLINE_SLACK_MS,
  SHUTDOWN_SETTLE_SLACK_MS,
  shutdownHardDeadlineMs,
  type RunFinishedEvent,
} from "../supervisor/runner.ts";
import {
  collectFinished,
  cronCtx,
  isAlive,
  killQuietly,
  makeJob,
  manualCtx,
  registerJob,
  runRow,
  setupHarness,
  teardownHarness,
  waitFor,
  writeWorker,
  type Harness,
} from "./runner-harness.ts";

let h: Harness;
const pidsToKill: number[] = [];

beforeEach(async () => {
  h = await setupHarness();
});

afterEach(async () => {
  for (const pid of pidsToKill.splice(0)) killQuietly(pid);
  await teardownHarness(h);
});

/** Long-running worker that ignores SIGTERM and records its pid. */
function stubbornWorker(name: string): { path: string; pidFile: string } {
  const pidFile = join(h.tmp, `${name}.pid`);
  const path = writeWorker(
    h,
    name,
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     process.on("SIGTERM", () => {});
     setInterval(() => {}, 1000);`,
  );
  return { path, pidFile };
}

async function pidOf(pidFile: string): Promise<number> {
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 5_000, "worker pid file");
  const pid = Number(readFileSync(pidFile, "utf8"));
  pidsToKill.push(pid);
  return pid;
}

describe("Runner.shutdown", () => {
  test("terminates running workers, finalizes rows as killed/supervisor_shutdown", async () => {
    const { path, pidFile } = stubbornWorker("stubborn");
    registerJob(h, makeJob({ name: "stubborn", worker: path, killGraceMs: 30_000 }));
    const finished = collectFinished(h.runner);

    const r = await h.runner.enqueue("stubborn", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const pid = await pidOf(pidFile);

    const t0 = Date.now();
    // killGraceMs (30 s) is capped by the shutdown grace (400 ms).
    await h.runner.shutdown(400);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(400 + SHUTDOWN_SETTLE_SLACK_MS);
    const row = runRow(h.db, r.run_id);
    expect(row.state).toBe("killed");
    expect(row.skip_reason).toBe("supervisor_shutdown");
    expect(typeof row.finished_at).toBe("number");
    expect(isAlive(pid)).toBe(false);
    expect(h.runner.active()).toEqual([]);
    expect(finished.map((e: RunFinishedEvent) => e.run_id)).toEqual([r.run_id]);
    expect(finished[0]!.reason).toBe("supervisor_shutdown");
  });

  test("a worker that honours SIGTERM is stopped quickly, well inside the grace", async () => {
    const worker = writeWorker(
      h,
      "polite",
      `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`,
    );
    registerJob(h, makeJob({ name: "polite", worker }));
    const r = await h.runner.enqueue("polite", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    await Bun.sleep(300);

    const t0 = Date.now();
    await h.runner.shutdown(5_000);
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(runRow(h.db, r.run_id).state).toBe("killed");
  });

  test("queued runs are cancelled and never promoted; nothing stays queued or running", async () => {
    const { path, pidFile } = stubbornWorker("busy");
    registerJob(h, makeJob({ name: "busy", worker: path, reentrancy: "queue", queueDepth: 2, killGraceMs: 30_000 }));

    const r1 = await h.runner.enqueue("busy", cronCtx());
    const r2 = await h.runner.enqueue("busy", cronCtx());
    const r3 = await h.runner.enqueue("busy", cronCtx());
    if (r1.kind !== "started" || r2.kind !== "queued" || r3.kind !== "queued") throw new Error("unexpected admission");
    await pidOf(pidFile);

    const skipped: { run_id: string; reason: string }[] = [];
    h.runner.on("run.skipped", (e: { run_id: string; reason: string }) => skipped.push(e));

    await h.runner.shutdown(300);

    for (const q of [r2, r3]) {
      const row = runRow(h.db, q.run_id);
      expect(row.state).toBe("cancelled");
      expect(row.skip_reason).toBe("supervisor_shutdown");
      expect(row.started_at).toBeNull();
      expect(row.log_path).toBeNull();
    }
    expect(skipped.map((e) => e.reason)).toEqual(["supervisor_shutdown", "supervisor_shutdown"]);
    expect(runRow(h.db, r1.run_id).state).toBe("killed");
    // No worker was ever started for the queued runs.
    const unfinished = h.db.query("SELECT run_id FROM runs WHERE state IN ('queued', 'running')").all();
    expect(unfinished).toEqual([]);
    expect(h.runner.active()).toEqual([]);
  });

  test("refuses new runs once shutdown has started, force included", async () => {
    const worker = writeWorker(h, "quick", `process.stdout.write("hi\\n");`);
    registerJob(h, makeJob({ name: "quick", worker }));

    const pending = h.runner.shutdown(200);
    for (const attempt of [
      h.runner.enqueue("quick", cronCtx()),
      h.runner.enqueue("quick", manualCtx()),
      h.runner.enqueue("quick", manualCtx(), { force: true }),
    ]) {
      const res = await attempt;
      expect(res.kind).toBe("skipped");
      if (res.kind === "skipped") {
        expect(res.reason).toBe("shutdown");
        expect(runRow(h.db, res.run_id).skip_reason).toBe("shutdown");
      }
    }
    await pending;
    expect(h.db.query("SELECT count(*) AS n FROM runs WHERE state = 'running' OR started_at IS NOT NULL").get()).toEqual({ n: 0 });
  });

  test("a run finishing during shutdown does not promote the next queued run", async () => {
    // The worker exits by itself shortly after shutdown starts (SIGTERM ignored,
    // short sleep), which is exactly when cleanupAfterExit used to promote.
    const worker = writeWorker(
      h,
      "short",
      `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 300);`,
    );
    registerJob(h, makeJob({ name: "short", worker, reentrancy: "queue", queueDepth: 1, killGraceMs: 30_000 }));
    const r1 = await h.runner.enqueue("short", cronCtx());
    const r2 = await h.runner.enqueue("short", cronCtx());
    if (r1.kind !== "started" || r2.kind !== "queued") throw new Error("unexpected admission");
    await Bun.sleep(100);

    await h.runner.shutdown(3_000);

    expect(runRow(h.db, r2.run_id).state).toBe("cancelled");
    expect(runRow(h.db, r2.run_id).started_at).toBeNull();
    expect(h.db.query("SELECT count(*) AS n FROM runs WHERE state IN ('queued','running')").get()).toEqual({ n: 0 });
  });

  test("is idempotent and safe on an idle runner", async () => {
    const a = h.runner.shutdown(100);
    const b = h.runner.shutdown(5_000);
    expect(b).toBe(a);
    await a;
  });

  test("always resolves within graceMs + slack even when a child never exits", async () => {
    // Fake child: ignores kill(), exit never resolves, pipes never close.
    const never = new Promise<number>(() => {});
    const fake = () => ({
      pid: undefined,
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exited: never,
      exitCode: null,
      signalCode: null,
      kill() {},
    });
    const runner = h.newRunner({ spawn: fake as unknown as typeof Bun.spawn });
    registerJob(h, makeJob({ name: "zombie", worker: "/nonexistent.ts", killGraceMs: 30_000 }));
    const r = await runner.enqueue("zombie", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");

    const t0 = Date.now();
    await runner.shutdown(300);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(300 + SHUTDOWN_SETTLE_SLACK_MS);
    const row = runRow(h.db, r.run_id);
    expect(row.state).toBe("killed");
    expect(row.skip_reason).toBe("supervisor_shutdown");
    expect(runner.active()).toEqual([]);
  });

  test("exposes the shutdown constants main.ts is meant to use", () => {
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(10_000);
    expect(SHUTDOWN_SETTLE_SLACK_MS).toBe(2_000);
    expect(SHUTDOWN_HARD_DEADLINE_SLACK_MS).toBe(5_000);
    // The process failsafe must outlast the runner's own worst case.
    expect(shutdownHardDeadlineMs(4_000)).toBe(9_000);
    expect(shutdownHardDeadlineMs(4_000)).toBeGreaterThan(4_000 + SHUTDOWN_SETTLE_SLACK_MS);
  });
});
