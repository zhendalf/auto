import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LogCapture } from "../supervisor/log-capture.ts";
import type { RunFinishedEvent } from "../supervisor/runner.ts";
import {
  FIXTURES,
  collectFinished,
  cronCtx,
  makeJob,
  registerJob,
  runRow,
  setupHarness,
  teardownHarness,
  waitFor,
  waitTerminal,
  type Harness,
} from "./runner-harness.ts";

let h: Harness;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(async () => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  h = await setupHarness();
});

afterEach(async () => {
  await teardownHarness(h);
  process.off("unhandledRejection", onUnhandled);
});

const hello = () => join(FIXTURES, "hello-worker.ts");

describe("start-path failures", () => {
  test("unwritable log directory: run is finalized failed/spawn_error and the job is not wedged", async () => {
    // logsDir lives under a regular file, so mkdir/open must fail.
    const blocker = join(h.tmp, "not-a-dir");
    writeFileSync(blocker, "x");
    const runner = h.newRunner({ logsDir: join(blocker, "runs") });
    registerJob(h, makeJob({ name: "nolog", worker: hello(), reentrancy: "drop" }));
    const finished = collectFinished(runner);

    const r = await runner.enqueue("nolog", cronCtx());
    expect(r.kind).toBe("started");
    if (r.kind !== "started") return;
    const row = await waitTerminal(h.db, r.run_id, 3_000);
    expect(row.state).toBe("failed");
    expect(row.skip_reason).toBe("spawn_error");
    expect(row.finished_at).toBeGreaterThan(0);
    expect(row.log_path).toBeNull();
    expect(finished.at(-1)?.reason).toBe("spawn_error");
    expect(runner.active()).toEqual([]);

    // Not stuck queued/running, and the next fire is admitted (no skipped(overlap)).
    expect(h.db.query("SELECT count(*) AS n FROM runs WHERE state IN ('queued','running')").get()).toEqual({ n: 0 });
    const again = await runner.enqueue("nolog", cronCtx());
    expect(again.kind).toBe("started");
    await Bun.sleep(50);
    expect(unhandled).toEqual([]);
  });

  test("spawn throwing: failed/spawn_error, reason recorded in the log, queue keeps moving", async () => {
    let calls = 0;
    const boom = (() => {
      calls++;
      throw new Error("ENOENT: no such bun");
    }) as unknown as typeof Bun.spawn;
    const runner = h.newRunner({ spawn: boom });
    registerJob(h, makeJob({ name: "nospawn", worker: hello(), reentrancy: "queue", queueDepth: 2 }));

    const r1 = await runner.enqueue("nospawn", cronCtx());
    const r2 = await runner.enqueue("nospawn", cronCtx());
    if (r1.kind !== "started" || r2.kind !== "queued") throw new Error("unexpected admission");

    const row1 = await waitTerminal(h.db, r1.run_id, 3_000);
    const row2 = await waitTerminal(h.db, r2.run_id, 3_000);
    for (const row of [row1, row2]) {
      expect(row.state).toBe("failed");
      expect(row.skip_reason).toBe("spawn_error");
    }
    expect(calls).toBe(2); // the queued run was promoted and tried too
    expect(readFileSync(join(h.dataDir, row1.log_path), "utf8")).toContain("spawn failed: ENOENT: no such bun");
    expect(unhandled).toEqual([]);
  });
});

describe("exit-path failures", () => {
  function failUpdatesTo(states: string[]) {
    const list = states.map((s) => `'${s}'`).join(",");
    h.db.run(
      `CREATE TRIGGER fail_finalize BEFORE UPDATE OF state ON runs
         WHEN NEW.state IN (${list})
       BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END`,
    );
  }

  test("DB error while recording the result: retried as failed/finalize_error, run released", async () => {
    failUpdatesTo(["succeeded"]);
    registerJob(h, makeJob({ name: "fin", worker: hello(), reentrancy: "drop" }));
    const finished = collectFinished(h.runner);

    const r = await h.runner.enqueue("fin", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const row = await waitTerminal(h.db, r.run_id, 5_000);

    expect(row.state).toBe("failed");
    expect(row.skip_reason).toBe("finalize_error");
    expect(finished.at(-1)).toMatchObject({ run_id: r.run_id, state: "failed", reason: "finalize_error" });
    expect(h.runner.active()).toEqual([]);
    // Job is free again.
    h.db.run("DROP TRIGGER fail_finalize");
    expect((await h.runner.enqueue("fin", cronCtx())).kind).toBe("started");
    await Bun.sleep(50);
    expect(unhandled).toEqual([]);
  });

  test("DB error on every finalize attempt: still released, no unhandled rejection", async () => {
    failUpdatesTo(["succeeded", "failed"]);
    registerJob(h, makeJob({ name: "fin2", worker: hello(), reentrancy: "drop" }));
    const finished = collectFinished(h.runner);

    const r = await h.runner.enqueue("fin2", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    await waitFor(() => finished.length === 1, 5_000, "run.finished");
    expect(finished[0]!.state).toBe("failed");
    expect(h.runner.active()).toEqual([]);
    // The row is left for startup recovery; the runner itself carries on.
    expect(runRow(h.db, r.run_id).state).toBe("running");
    h.db.run("DROP TRIGGER fail_finalize");
    expect((await h.runner.enqueue("fin2", cronCtx())).kind).toBe("started");
    await Bun.sleep(50);
    expect(unhandled).toEqual([]);
  });

  test("capture.close() throwing still finalizes the run and promotes the queue", async () => {
    const original = LogCapture.prototype.close;
    let armed = true;
    LogCapture.prototype.close = async function (this: LogCapture) {
      await original.call(this);
      if (armed) {
        armed = false;
        throw new Error("injected close failure");
      }
    };
    try {
      registerJob(h, makeJob({ name: "closer", worker: hello(), reentrancy: "queue", queueDepth: 1 }));
      const r1 = await h.runner.enqueue("closer", cronCtx());
      const r2 = await h.runner.enqueue("closer", cronCtx());
      if (r1.kind !== "started" || r2.kind !== "queued") throw new Error("unexpected admission");
      const row1 = await waitTerminal(h.db, r1.run_id, 5_000);
      const row2 = await waitTerminal(h.db, r2.run_id, 5_000);
      expect(row1.state).toBe("succeeded");
      expect(row2.state).toBe("succeeded");
      await Bun.sleep(50);
      expect(unhandled).toEqual([]);
    } finally {
      LogCapture.prototype.close = original;
    }
  });

  test("a throwing run.finished listener does not stop bookkeeping or queue promotion", async () => {
    registerJob(h, makeJob({ name: "listener", worker: hello(), reentrancy: "queue", queueDepth: 1 }));
    h.runner.on("run.finished", () => {
      throw new Error("listener blew up");
    });
    const seen: RunFinishedEvent[] = [];
    h.runner.on("run.finished", (e: RunFinishedEvent) => seen.push(e));

    const r1 = await h.runner.enqueue("listener", cronCtx());
    const r2 = await h.runner.enqueue("listener", cronCtx());
    if (r1.kind !== "started" || r2.kind !== "queued") throw new Error("unexpected admission");
    // The second listener is never reached (EventEmitter stops at the throw), so
    // rely on the DB.
    expect((await waitTerminal(h.db, r1.run_id, 5_000)).state).toBe("succeeded");
    expect((await waitTerminal(h.db, r2.run_id, 5_000)).state).toBe("succeeded");
    expect(h.runner.active()).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("run log permissions", () => {
  test("run log directories are 0700 and the log file 0600", async () => {
    registerJob(h, makeJob({ name: "perm", worker: hello() }));
    const r = await h.runner.enqueue("perm", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const row = await waitTerminal(h.db, r.run_id, 5_000);
    const file = join(h.dataDir, row.log_path);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // runs/ and the YYYY/MM/DD chain under it.
    let dir = join(file, "..");
    for (let i = 0; i < 4; i++) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      dir = join(dir, "..");
    }
  });

  test("directories left loose by older versions are tightened", async () => {
    mkdirSync(h.logsDir, { recursive: true });
    chmodSync(h.logsDir, 0o755);
    registerJob(h, makeJob({ name: "perm2", worker: hello() }));
    const r = await h.runner.enqueue("perm2", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    await waitTerminal(h.db, r.run_id, 5_000);
    expect(statSync(h.logsDir).mode & 0o777).toBe(0o700);
  });
});

describe("worker environment", () => {
  test("only allowlisted variables reach the worker", async () => {
    process.env.AUTO_TEST_SUPERVISOR_SECRET = "must-not-leak";
    try {
      const path = join(h.tmp, "env-worker.ts");
      writeFileSync(path, `process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));`);
      registerJob(h, makeJob({ name: "envjob", worker: path }));
      const r = await h.runner.enqueue("envjob", cronCtx());
      if (r.kind !== "started") throw new Error("expected started");
      const row = await waitTerminal(h.db, r.run_id, 5_000);
      const keys = JSON.parse(readFileSync(join(h.dataDir, row.log_path), "utf8")) as string[];
      expect(keys).not.toContain("AUTO_TEST_SUPERVISOR_SECRET");
      for (const k of ["RUN_ID", "JOB_NAME", "JOB_ID", "TRIGGER_KIND", "TRIGGER_ID", "TRIGGER_META"]) {
        expect(keys).toContain(k);
      }
    } finally {
      delete process.env.AUTO_TEST_SUPERVISOR_SECRET;
    }
  });
});
