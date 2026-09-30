import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { ConfigValidationError, JobRegistry } from "../supervisor/registry.ts";
import type { Automation, Config } from "../supervisor/config.ts";

type Ctx = {
  tmp: string;
  db: Database;
  registry: JobRegistry;
};

function makeJob(overrides: Partial<Automation> & { name: string }): Automation {
  return {
    id: overrides.id ?? overrides.name,
    name: overrides.name,
    description: overrides.description,
    worker: overrides.worker ?? `./${overrides.name}/worker.ts`,
    triggers: overrides.triggers ?? [
      { kind: "cron", id: "default", schedule: "0 3 * * *" },
    ],
    reentrancy: overrides.reentrancy ?? "drop",
    queueDepth: overrides.queueDepth ?? 1,
    timeoutMs: overrides.timeoutMs ?? 600_000,
    killGraceMs: overrides.killGraceMs ?? 10_000,
    enabled: overrides.enabled ?? true,
  };
}

async function setup(): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "registry-test-"));
  const dbPath = join(tmp, "test.db");
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  const registry = new JobRegistry({ db });
  return { tmp, db, registry };
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

let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(() => {
  teardown(ctx);
});

describe("JobRegistry.reconcile", () => {
  test("initial reconcile: empty DB + 1-job config inserts job and trigger", () => {
    const config: Config = [makeJob({ name: "job1" })];
    const stats = ctx.registry.reconcile(config);

    expect(stats.jobs.added).toBe(1);
    expect(stats.jobs.updated).toBe(0);
    expect(stats.jobs.archived).toBe(0);
    expect(stats.jobs.unchanged).toBe(0);

    expect(stats.triggers.added).toBe(1);
    expect(stats.triggers.updated).toBe(0);
    expect(stats.triggers.archived).toBe(0);
    expect(stats.triggers.unchanged).toBe(0);

    const snap = ctx.registry.snapshot();
    expect(snap.jobs.length).toBe(1);
    expect(snap.jobs[0]!.name).toBe("job1");
    expect(snap.jobs[0]!.archived_at).toBeNull();
    expect(snap.triggers.length).toBe(1);
    expect(snap.triggers[0]!.trigger_id).toBe("job1:default");
    expect(snap.triggers[0]!.kind).toBe("cron");

    const resolved = ctx.registry.resolve("job1");
    expect(resolved).not.toBeNull();
    expect(resolved!.job.name).toBe("job1");
    expect(typeof resolved!.jobId).toBe("string");
    expect(resolved!.jobId.length).toBeGreaterThan(0);

    expect(ctx.registry.activeJobs().length).toBe(1);
    expect(ctx.registry.activeCronJobs().length).toBe(1);
  });

  test("idempotent re-reconcile: same config twice → second call shows unchanged", () => {
    const config: Config = [makeJob({ name: "job1" })];
    const first = ctx.registry.reconcile(config);
    expect(first.jobs.added).toBe(1);
    expect(first.triggers.added).toBe(1);

    const beforeSnap = ctx.registry.snapshot();
    const jobIdBefore = beforeSnap.jobs[0]!.jobId;
    const triggerIdBefore = beforeSnap.triggers[0]!.trigger_id;

    const second = ctx.registry.reconcile(config);
    expect(second.jobs.added).toBe(0);
    expect(second.jobs.updated).toBe(0);
    expect(second.jobs.archived).toBe(0);
    expect(second.jobs.unchanged).toBe(1);

    expect(second.triggers.added).toBe(0);
    expect(second.triggers.updated).toBe(0);
    expect(second.triggers.archived).toBe(0);
    expect(second.triggers.unchanged).toBe(1);

    const afterSnap = ctx.registry.snapshot();
    expect(afterSnap.jobs.length).toBe(1);
    expect(afterSnap.triggers.length).toBe(1);
    // Same row, same id.
    expect(afterSnap.jobs[0]!.jobId).toBe(jobIdBefore);
    expect(afterSnap.triggers[0]!.trigger_id).toBe(triggerIdBefore);
  });

  test("job removed from config: row archived, not deleted; resolve returns null", () => {
    const both: Config = [makeJob({ name: "job1" }), makeJob({ name: "job2" })];
    ctx.registry.reconcile(both);
    expect(ctx.registry.activeJobs().length).toBe(2);

    const onlyOne: Config = [makeJob({ name: "job1" })];
    const stats = ctx.registry.reconcile(onlyOne);
    expect(stats.jobs.archived).toBe(1);
    expect(stats.triggers.archived).toBe(1);

    const snap = ctx.registry.snapshot();
    // Both rows still exist.
    expect(snap.jobs.length).toBe(2);
    expect(snap.triggers.length).toBe(2);

    const job2Row = snap.jobs.find((j) => j.name === "job2");
    expect(job2Row).toBeDefined();
    expect(job2Row!.archived_at).not.toBeNull();
    expect(typeof job2Row!.archived_at).toBe("number");

    const trig2Row = snap.triggers.find((t) => t.trigger_id === "job2:default");
    expect(trig2Row).toBeDefined();
    expect(trig2Row!.archived_at).not.toBeNull();

    expect(ctx.registry.resolve("job2")).toBeNull();
    expect(ctx.registry.resolve("job1")).not.toBeNull();
    expect(ctx.registry.activeJobs().length).toBe(1);
    expect(ctx.registry.activeCronJobs().length).toBe(1);
  });

  test("job re-added (un-archive): same job_id reused, archived_at cleared", () => {
    const both: Config = [makeJob({ name: "job1" }), makeJob({ name: "job2" })];
    ctx.registry.reconcile(both);

    // Capture original IDs.
    const before = ctx.registry.snapshot();
    const job2IdBefore = before.jobs.find((j) => j.name === "job2")!.jobId;

    // Remove job2.
    ctx.registry.reconcile([makeJob({ name: "job1" })]);
    const afterArchive = ctx.registry.snapshot();
    expect(afterArchive.jobs.find((j) => j.name === "job2")!.archived_at).not.toBeNull();

    // Re-add job2.
    const stats = ctx.registry.reconcile(both);
    // job1 unchanged, job2 un-archived (counted as updated).
    expect(stats.jobs.unchanged).toBe(1);
    expect(stats.jobs.updated).toBe(1);
    expect(stats.jobs.added).toBe(0);

    const after = ctx.registry.snapshot();
    const job2Row = after.jobs.find((j) => j.name === "job2");
    expect(job2Row).toBeDefined();
    expect(job2Row!.archived_at).toBeNull();
    expect(job2Row!.jobId).toBe(job2IdBefore); // SAME job_id (no new row)

    // Trigger un-archived too.
    const trig2 = after.triggers.find((t) => t.trigger_id === "job2:default");
    expect(trig2).toBeDefined();
    expect(trig2!.archived_at).toBeNull();

    // Total rows still 2.
    expect(after.jobs.length).toBe(2);
    expect(after.triggers.length).toBe(2);
    expect(ctx.registry.activeJobs().length).toBe(2);
  });

  test("cron pattern invalid: throws ConfigValidationError; DB not mutated by failed attempt", () => {
    // Pre-seed a successful job so we can detect any leakage from the failed attempt.
    ctx.registry.reconcile([makeJob({ name: "job1" })]);
    const before = ctx.registry.snapshot();

    const bad: Config = [
      makeJob({
        name: "bad-job",
        triggers: [{ kind: "cron", id: "broken", schedule: "not a cron" }],
      }),
    ];
    expect(() => ctx.registry.reconcile(bad)).toThrow(ConfigValidationError);

    const after = ctx.registry.snapshot();
    // No new rows (validation failed before transaction touched anything).
    expect(after.jobs.length).toBe(before.jobs.length);
    expect(after.triggers.length).toBe(before.triggers.length);
    // job1 still active, bad-job NOT inserted.
    expect(after.jobs.some((j) => j.name === "bad-job")).toBe(false);
    expect(after.triggers.some((t) => t.trigger_id === "bad-job:broken")).toBe(false);
  });
});
