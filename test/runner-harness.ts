// Shared scaffolding for the runner*/condition-evaluator* test files: a temp
// workspace with its own DB, a Runner wired to it, and small worker scripts.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Automation } from "../supervisor/config.ts";
import { uuidv4 } from "../supervisor/db/ids.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { Runner, type Registry, type RunFinishedEvent, type RunnerOptions, type TriggerCtx } from "../supervisor/runner.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = resolve(REPO_ROOT, "test", "fixtures");

export class MutableRegistry implements Registry {
  private byName = new Map<string, { jobId: string; job: Automation }>();
  set(jobName: string, job: Automation): string {
    const jobId = uuidv4();
    this.byName.set(jobName, { jobId, job });
    return jobId;
  }
  /** Replace a job's definition but keep its id, as a config reload does. */
  update(jobName: string, job: Automation): void {
    const existing = this.byName.get(jobName);
    if (!existing) throw new Error(`unknown job: ${jobName}`);
    this.byName.set(jobName, { jobId: existing.jobId, job });
  }
  /** Forget a job, as a config reload that drops it does. */
  remove(jobName: string): void {
    this.byName.delete(jobName);
  }
  resolve(jobName: string): { jobId: string; job: Automation } | null {
    return this.byName.get(jobName) ?? null;
  }
}

export function makeJob(overrides: Partial<Automation> & { worker: string; name: string }): Automation {
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

export type Harness = {
  tmp: string;
  dataDir: string;
  logsDir: string;
  db: Database;
  registry: MutableRegistry;
  runner: Runner;
  /** Extra runners created with `newRunner`, shut down by `teardown`. */
  extraRunners: Runner[];
  newRunner(opts?: Partial<RunnerOptions>): Runner;
};

export async function setupHarness(opts: Partial<RunnerOptions> = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "runner-h-"));
  const dataDir = tmp;
  const logsDir = join(dataDir, "runs");
  const db = new Database(join(tmp, "test.db"));
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  const registry = new MutableRegistry();
  const extraRunners: Runner[] = [];
  const build = (extra: Partial<RunnerOptions> = {}) =>
    new Runner({ db, registry, workspaceRoot: REPO_ROOT, dataDir, logsDir, ...opts, ...extra });
  return {
    tmp,
    dataDir,
    logsDir,
    db,
    registry,
    runner: build(),
    extraRunners,
    newRunner(extra) {
      const r = build(extra);
      extraRunners.push(r);
      return r;
    },
  };
}

export async function teardownHarness(h: Harness): Promise<void> {
  for (const r of [h.runner, ...h.extraRunners]) {
    try {
      await r.shutdown(1_000);
    } catch {
      // ignore
    }
  }
  try {
    h.db.close();
  } catch {
    // ignore
  }
  rmSync(h.tmp, { recursive: true, force: true });
}

export function registerJob(h: Harness, job: Automation, opts: { registry?: MutableRegistry } = {}): { jobId: string; triggerId: string } {
  const jobId = (opts.registry ?? h.registry).set(job.name, job);
  const now = Date.now();
  h.db.prepare(
    `INSERT INTO jobs (job_id, name, enabled, last_seen_in_config_at, created_at) VALUES (?, ?, 1, ?, ?)`,
  ).run(jobId, job.name, now, now);
  const trig = job.triggers[0]!;
  const triggerId = `${job.name}:${trig.id}`;
  h.db.prepare(
    `INSERT INTO triggers (trigger_id, job_id, kind, config_json, enabled, last_seen_in_config_at, updated_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(triggerId, jobId, trig.kind, JSON.stringify(trig), now, now, now);
  return { jobId, triggerId };
}

export function cronCtx(fireAt = Date.now()): TriggerCtx {
  return { kind: "cron", trigger_id: "default", fire_at: fireAt };
}

export function webhookCtx(): TriggerCtx {
  return { kind: "webhook", trigger_id: "default", meta: {} };
}

export function manualCtx(): TriggerCtx {
  return { kind: "manual" };
}

export function runRow(db: Database, runId: string): any {
  return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
}

/** Writes a worker script into the harness temp dir and returns its path. */
export function writeWorker(h: Harness, name: string, body: string): string {
  const path = join(h.tmp, `${name}.ts`);
  writeFileSync(path, body);
  return path;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Resolves once the run reached a terminal DB state; returns the row. */
export async function waitTerminal(db: Database, runId: string, timeoutMs = 10_000): Promise<any> {
  await waitFor(() => {
    const r = runRow(db, runId);
    return !!r && !["queued", "running"].includes(r.state);
  }, timeoutMs, `run ${runId} to finish`);
  return runRow(db, runId);
}

export function collectFinished(runner: Runner): RunFinishedEvent[] {
  const events: RunFinishedEvent[] = [];
  runner.on("run.finished", (e: RunFinishedEvent) => events.push(e));
  return events;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort cleanup for processes a test may have left behind. */
export function killQuietly(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}
