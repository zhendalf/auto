import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConditionEvaluator } from "../supervisor/condition-evaluator.ts";
import type { Automation, CronTrigger } from "../supervisor/config.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

async function setup(checker: string) {
  const tmp = mkdtempSync(join(tmpdir(), "condition-test-"));
  temps.push(tmp);
  const db = new Database(join(tmp, "test.db"));
  await runMigrations(db);
  const trigger: CronTrigger = { kind: "cron", id: "watch", schedule: "* * * * *", condition: { checker, timeoutMs: 5_000 } };
  const job: Automation = {
    id: "condition-job", name: "condition-job", worker: "./test/fixtures/hello-worker.ts",
    triggers: [trigger], reentrancy: "drop", queueDepth: 1, timeoutMs: 5_000, killGraceMs: 100, enabled: true,
  };
  const registry = new JobRegistry({ db });
  registry.reconcile([job]);
  const runner = new Runner({ db, registry, workspaceRoot: ROOT, dataDir: tmp, logsDir: join(tmp, "runs") });
  const evaluator = new ConditionEvaluator({ db, runner, workspaceRoot: ROOT });
  return { tmp, db, job, trigger, runner, evaluator };
}

describe("ConditionEvaluator", () => {
  test("quiet checks persist state without creating a run", async () => {
    const ctx = await setup("./test/fixtures/condition-quiet.ts");
    expect((await ctx.evaluator.evaluate(ctx.job, ctx.trigger)).kind).toBe("quiet");
    const state = ctx.db.query<{ state_json: string; evaluation_count: number }, []>("SELECT state_json, evaluation_count FROM condition_states").get();
    expect(JSON.parse(state!.state_json)).toEqual({ checks: 1 });
    expect(state!.evaluation_count).toBe(1);
    expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()!.n).toBe(0);
    ctx.db.close();
  });

  test("fired state commits only after successful action", async () => {
    const ctx = await setup("./test/fixtures/condition-fire.ts");
    const result = await ctx.evaluator.evaluate(ctx.job, ctx.trigger);
    expect(result.kind).toBe("fired");
    const runId = result.kind === "fired" && "run_id" in result.enqueue ? result.enqueue.run_id : "";
    await waitFor(() => ctx.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(runId)?.state === "succeeded");
    await waitFor(() => ctx.db.query<{ pending_run_id: string | null }, []>("SELECT pending_run_id FROM condition_states").get()?.pending_run_id === null);
    const state = ctx.db.query<{ state_json: string }, []>("SELECT state_json FROM condition_states").get();
    expect(JSON.parse(state!.state_json)).toEqual({ cursor: "message-42" });
    ctx.db.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
