import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { childEnvAllowlist, allowlistedEnv } from "../supervisor/child-process.ts";
import { triggerManual } from "../supervisor/adapters/manual.ts";
import {
  FIXTURES,
  cronCtx,
  makeJob,
  manualCtx,
  registerJob,
  runRow,
  setupHarness,
  teardownHarness,
  waitTerminal,
  webhookCtx,
  writeWorker,
  type Harness,
} from "./runner-harness.ts";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
});

afterEach(async () => {
  await teardownHarness(h);
});

const hello = () => join(FIXTURES, "hello-worker.ts");

function disableInDb(jobId: string): void {
  h.db.prepare("UPDATE jobs SET enabled = 0 WHERE job_id = ?").run(jobId);
}
function pauseInDb(jobId: string, until: number): void {
  h.db.prepare("UPDATE jobs SET paused_until = ? WHERE job_id = ?").run(until, jobId);
}

describe("DB-level admission (auto disable / auto pause)", () => {
  test("a job disabled in the DB skips cron, webhook and manual runs as disabled", async () => {
    const { jobId } = registerJob(h, makeJob({ name: "off", worker: hello() }));
    disableInDb(jobId);

    for (const ctx of [cronCtx(), webhookCtx(), manualCtx()]) {
      const res = await h.runner.enqueue("off", ctx);
      expect(res.kind).toBe("skipped");
      if (res.kind !== "skipped") continue;
      expect(res.reason).toBe("disabled");
      const row = runRow(h.db, res.run_id);
      expect(row.state).toBe("skipped");
      expect(row.skip_reason).toBe("disabled");
      expect(row.trigger_kind).toBe(ctx.kind);
      expect(row.started_at).toBeNull();
    }
  });

  test("a paused job skips every non-force trigger as paused; the pause lapses on its own", async () => {
    const { jobId } = registerJob(h, makeJob({ name: "paused", worker: hello() }));
    pauseInDb(jobId, Date.now() + 60_000);

    for (const ctx of [cronCtx(), webhookCtx(), manualCtx()]) {
      const res = await h.runner.enqueue("paused", ctx);
      expect(res.kind).toBe("skipped");
      if (res.kind === "skipped") {
        expect(res.reason).toBe("paused");
        expect(runRow(h.db, res.run_id).skip_reason).toBe("paused");
      }
    }

    pauseInDb(jobId, Date.now() - 1); // expired
    const res = await h.runner.enqueue("paused", webhookCtx());
    expect(res.kind).toBe("started");
    if (res.kind === "started") await waitTerminal(h.db, res.run_id, 5_000);
  });

  test("manual force still bypasses DB-disabled and paused", async () => {
    const { jobId } = registerJob(h, makeJob({ name: "forced", worker: hello() }));
    disableInDb(jobId);
    const r1 = await h.runner.enqueue("forced", manualCtx(), { force: true });
    expect(r1.kind).toBe("started");
    if (r1.kind === "started") await waitTerminal(h.db, r1.run_id, 5_000);

    h.db.prepare("UPDATE jobs SET enabled = 1 WHERE job_id = ?").run(jobId);
    pauseInDb(jobId, Date.now() + 60_000);
    const r2 = await h.runner.enqueue("forced", manualCtx(), { force: true });
    expect(r2.kind).toBe("started");
    if (r2.kind === "started") await waitTerminal(h.db, r2.run_id, 5_000);
  });

  test("force does not turn a cron/webhook trigger into a bypass", async () => {
    const { jobId } = registerJob(h, makeJob({ name: "noforce", worker: hello() }));
    disableInDb(jobId);
    const res = await h.runner.enqueue("noforce", webhookCtx(), { force: true });
    expect(res.kind).toBe("skipped");
  });

  test("config-level enabled:false is still enforced", async () => {
    registerJob(h, makeJob({ name: "cfgoff", worker: hello(), enabled: false }));
    for (const ctx of [cronCtx(), webhookCtx(), manualCtx()]) {
      const res = await h.runner.enqueue("cfgoff", ctx);
      expect(res).toMatchObject({ kind: "skipped", reason: "disabled" });
    }
    const forced = await h.runner.enqueue("cfgoff", manualCtx(), { force: true });
    expect(forced.kind).toBe("started");
    if (forced.kind === "started") await waitTerminal(h.db, forced.run_id, 5_000);
  });

  test("a job with no jobs row has no DB overrides and simply runs", async () => {
    // Registry knows the job, the jobs table does not (foreign keys off for the insert).
    h.db.run("PRAGMA foreign_keys = OFF;");
    h.registry.set("norow", makeJob({ name: "norow", worker: hello() }));
    const res = await h.runner.enqueue("norow", cronCtx());
    expect(res.kind).toBe("started");
    if (res.kind === "started") await waitTerminal(h.db, res.run_id, 5_000);
  });

  test("a queued run whose job gets paused while it waits is cancelled, not started", async () => {
    const slow = writeWorker(h, "slow", `setTimeout(() => process.exit(0), 400);`);
    const { jobId } = registerJob(h, makeJob({ name: "slowq", worker: slow, reentrancy: "queue", queueDepth: 1 }));
    const skipped: { run_id: string; job_id: string; reason: string }[] = [];
    h.runner.on("run.skipped", (e: { run_id: string; job_id: string; reason: string }) => skipped.push(e));

    const r1 = await h.runner.enqueue("slowq", cronCtx());
    const r2 = await h.runner.enqueue("slowq", cronCtx());
    if (r1.kind !== "started" || r2.kind !== "queued") throw new Error("unexpected admission");
    pauseInDb(jobId, Date.now() + 60_000);

    await waitTerminal(h.db, r1.run_id, 5_000);
    const row2 = runRow(h.db, r2.run_id);
    expect(row2.state).toBe("cancelled");
    expect(row2.skip_reason).toBe("paused");
    expect(row2.started_at).toBeNull();
    expect(skipped).toContainEqual({ run_id: r2.run_id, job_id: jobId, reason: "paused" });
    expect(h.runner.active()).toEqual([]);
  });

  test("manual adapter reports paused/disabled as a skipped result", async () => {
    const { jobId } = registerJob(h, makeJob({ name: "madapter", worker: hello() }));
    pauseInDb(jobId, Date.now() + 60_000);
    const res = await triggerManual(h.runner, "madapter");
    expect(res).toMatchObject({ ok: false, outcome: "skipped", reason: "paused" });

    const forced = await triggerManual(h.runner, "madapter", { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) await waitTerminal(h.db, forced.run_id, 5_000);
  });
});

describe("worker environment allowlist", () => {
  test("posix list has no Windows-only names", () => {
    const posix = childEnvAllowlist("linux");
    expect(posix).toEqual(expect.arrayContaining(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "SHELL", "TMPDIR"]));
    expect(posix).not.toContain("SystemRoot");
  });

  test("win32 list adds the variables Windows needs to start processes", () => {
    const win = childEnvAllowlist("win32");
    for (const k of ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC", "PATH"]) {
      expect(win).toContain(k);
    }
  });

  test("allowlistedEnv copies only listed variables that are set", () => {
    const env = allowlistedEnv(
      { PATH: "/bin", SystemRoot: "C:\\Windows", SECRET_TOKEN: "x", HOME: undefined },
      "win32",
    );
    expect(env).toEqual({ PATH: "/bin", SystemRoot: "C:\\Windows" });
    expect(allowlistedEnv({ PATH: "/bin", SystemRoot: "C:\\Windows" }, "linux")).toEqual({ PATH: "/bin" });
  });
});
