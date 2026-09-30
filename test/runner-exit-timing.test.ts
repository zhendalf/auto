import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cronCtx,
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

let h: Harness;
const strays: number[] = [];

beforeEach(async () => {
  // Wait up to 1.5 s for output pipes after the worker has exited.
  h = await setupHarness({ drainTimeoutMs: 1_500 });
});
afterEach(async () => {
  for (const pid of strays.splice(0)) killQuietly(pid);
  await teardownHarness(h);
});

describe("a worker that exits in time but leaves a background process on its output pipes", () => {
  test("is succeeded, not timed_out, even when the timeout falls inside the wait for the pipes", async () => {
    const gcPidFile = join(h.tmp, "gc.pid");
    // Exits 0 after 300 ms, leaving a background sleeper that holds stdout open.
    const worker = writeWorker(
      h,
      "bg-holder",
      `import { writeFileSync } from "node:fs";
       const gc = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
       gc.unref();
       writeFileSync(${JSON.stringify(gcPidFile)}, String(gc.pid));
       await Bun.sleep(300);
       process.exit(0);`,
    );
    // timeoutMs 800: it fires 500 ms after the worker exited, while the drain still waits (up to 1.5 s).
    registerJob(h, makeJob({ name: "bg-holder", worker, timeoutMs: 800, killGraceMs: 200 }));
    const res = await h.runner.enqueue("bg-holder", cronCtx());
    if (res.kind !== "started") throw new Error(`not started: ${res.kind}`);
    await waitFor(() => existsSync(gcPidFile), 5_000, "the background process");
    strays.push(Number(readFileSync(gcPidFile, "utf8")));

    const row = await waitTerminal(h.db, res.run_id);
    expect(row.state).toBe("succeeded");
    expect(row.exit_code).toBe(0);
  });

  test("a worker that really runs past its timeout is still timed_out", async () => {
    const worker = writeWorker(h, "slow", `process.on("SIGTERM", () => process.exit(0)); await Bun.sleep(30000);`);
    registerJob(h, makeJob({ name: "slow", worker, timeoutMs: 300, killGraceMs: 500 }));
    const res = await h.runner.enqueue("slow", cronCtx());
    if (res.kind !== "started") throw new Error(`not started: ${res.kind}`);
    const row = await waitTerminal(h.db, res.run_id);
    expect(row.state).toBe("timed_out");
  });
});

describe("a run cancelled by the user", () => {
  test("is killed with the reason `cancelled`, so it can be told from a crash", async () => {
    const worker = writeWorker(h, "cancel-me", `process.on("SIGTERM", () => process.exit(143)); await Bun.sleep(30000);`);
    registerJob(h, makeJob({ name: "cancel-me", worker, killGraceMs: 500 }));
    const res = await h.runner.enqueue("cancel-me", cronCtx());
    if (res.kind !== "started") throw new Error(`not started: ${res.kind}`);
    await waitFor(() => (h.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(res.run_id) as any)?.state === "running", 5_000, "running");
    expect((await h.runner.cancel(res.run_id)).ok).toBe(true);
    const row = await waitTerminal(h.db, res.run_id);
    expect(row.state).toBe("killed");
    expect(row.skip_reason).toBe("cancelled");
  });

  test("a run that fails on its own has no reason", async () => {
    const worker = writeWorker(h, "fails", `process.exit(3);`);
    registerJob(h, makeJob({ name: "fails", worker }));
    const res = await h.runner.enqueue("fails", cronCtx());
    if (res.kind !== "started") throw new Error(`not started: ${res.kind}`);
    const row = await waitTerminal(h.db, res.run_id);
    expect(row.state).toBe("failed");
    expect(row.skip_reason).toBeNull();
  });
});
