import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cronCtx,
  isAlive,
  killQuietly,
  makeJob,
  registerJob,
  runRow,
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
  h = await setupHarness({ drainTimeoutMs: 400 });
});

afterEach(async () => {
  for (const pid of strays.splice(0)) killQuietly(pid);
  await teardownHarness(h);
});

/**
 * Worker that forks a long-lived grandchild sharing its stdout/stderr, records
 * both pids, then either lingers (`mode: "linger"`) or exits at once
 * (`mode: "exit"`).
 */
function forkingWorker(name: string, mode: "linger" | "exit", opts: { workerIgnoresTerm?: boolean } = {}) {
  const gcPid = join(h.tmp, `${name}.gc.pid`);
  const selfPid = join(h.tmp, `${name}.self.pid`);
  const path = writeWorker(
    h,
    name,
    `import { writeFileSync } from "node:fs";
     const gc = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
       stdin: "ignore", stdout: "inherit", stderr: "inherit",
     });
     gc.unref();
     writeFileSync(${JSON.stringify(gcPid)}, String(gc.pid));
     writeFileSync(${JSON.stringify(selfPid)}, String(process.pid));
     process.stdout.write("forked\\n");
     ${opts.workerIgnoresTerm ? `process.on("SIGTERM", () => {});` : ""}
     ${mode === "linger" ? "setInterval(() => {}, 1000);" : "process.exit(0);"}`,
  );
  return { path, gcPid, selfPid };
}

async function readPid(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").length > 0, 5_000, `${file}`);
  const pid = Number(readFileSync(file, "utf8"));
  strays.push(pid);
  return pid;
}

describe("worker process groups", () => {
  test("the worker runs in its own process group", async () => {
    const path = writeWorker(
      h,
      "pgid",
      `const out = await Bun.$\`ps -o pgid= -p \${process.pid}\`.text();
       process.stdout.write("pgid=" + out.trim() + " pid=" + process.pid + "\\n");`,
    );
    registerJob(h, makeJob({ name: "pgid", worker: path }));
    const r = await h.runner.enqueue("pgid", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const row = await waitTerminal(h.db, r.run_id);
    const log = readFileSync(join(h.dataDir, row.log_path), "utf8");
    const m = /pgid=(\d+) pid=(\d+)/.exec(log);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]!); // group leader: pgid == pid
    expect(Number(m![1])).not.toBe(process.pid);
  });

  test("timeout kills the whole group, grandchildren included, and the run finalizes", async () => {
    const { path, gcPid, selfPid } = forkingWorker("timeout-group", "linger");
    registerJob(h, makeJob({ name: "timeout-group", worker: path, timeoutMs: 500, killGraceMs: 300 }));
    const r = await h.runner.enqueue("timeout-group", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const grandchild = await readPid(gcPid);
    const worker = await readPid(selfPid);
    expect(isAlive(grandchild)).toBe(true);

    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("timed_out");
    await waitFor(() => !isAlive(grandchild) && !isAlive(worker), 3_000, "process group to die");
  });

  test("cancel kills the whole group", async () => {
    const { path, gcPid } = forkingWorker("cancel-group", "linger", { workerIgnoresTerm: true });
    registerJob(h, makeJob({ name: "cancel-group", worker: path, killGraceMs: 300 }));
    const r = await h.runner.enqueue("cancel-group", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const grandchild = await readPid(gcPid);

    await h.runner.cancel(r.run_id);
    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("killed");
    await waitFor(() => !isAlive(grandchild), 3_000, "grandchild to die");
  });

  test("a grandchild holding the pipes cannot wedge the run; the log notes the truncation", async () => {
    const { path, gcPid } = forkingWorker("held-pipes", "exit");
    registerJob(h, makeJob({ name: "held-pipes", worker: path, reentrancy: "drop" }));

    const t0 = Date.now();
    const r = await h.runner.enqueue("held-pipes", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const grandchild = await readPid(gcPid);

    const row = await waitTerminal(h.db, r.run_id, 5_000);
    expect(Date.now() - t0).toBeLessThan(3_500);
    expect(row.state).toBe("succeeded");
    expect(isAlive(grandchild)).toBe(true); // a normal exit does not reap what the worker left behind
    const log = readFileSync(join(h.dataDir, row.log_path), "utf8");
    expect(log).toContain("forked");
    expect(log).toContain("output pipes still open");

    // The job is free again: the next fire starts instead of being skipped(overlap).
    const next = await h.runner.enqueue("held-pipes", cronCtx());
    expect(next.kind).toBe("started");
    if (next.kind === "started") {
      const nextRow = await waitTerminal(h.db, next.run_id, 5_000);
      expect(nextRow.state).toBe("succeeded");
      strays.push(Number(readFileSync(gcPid, "utf8")));
    }
  });

  test("after a timeout, a grandchild still holding the pipes is killed rather than waited on", async () => {
    // Worker dies on SIGTERM but its grandchild ignores it and keeps the pipes.
    const gcPid = join(h.tmp, "orphan.gc.pid");
    const path = writeWorker(
      h,
      "orphan-maker",
      `import { writeFileSync } from "node:fs";
       const gc = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
         stdin: "ignore", stdout: "inherit", stderr: "inherit",
       });
       writeFileSync(${JSON.stringify(gcPid)}, String(gc.pid));
       process.on("SIGTERM", () => process.exit(0));
       setInterval(() => {}, 1000);`,
    );
    registerJob(h, makeJob({ name: "orphan-maker", worker: path, timeoutMs: 400, killGraceMs: 30_000 }));
    const r = await h.runner.enqueue("orphan-maker", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const grandchild = await readPid(gcPid);

    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("timed_out");
    await waitFor(() => !isAlive(grandchild), 3_000, "orphaned grandchild to be killed");
  });

  test("timeoutMs beyond the setTimeout limit does not fire immediately", async () => {
    const path = writeWorker(h, "long-timeout", `setTimeout(() => process.stdout.write("done\\n"), 600);`);
    registerJob(h, makeJob({ name: "long-timeout", worker: path, timeoutMs: 2 ** 31 + 1000 }));
    const r = await h.runner.enqueue("long-timeout", cronCtx());
    if (r.kind !== "started") throw new Error("expected started");
    const row = await waitTerminal(h.db, r.run_id, 8_000);
    expect(row.state).toBe("succeeded");
    expect(runRow(h.db, r.run_id).signal).toBeNull();
  });
});
