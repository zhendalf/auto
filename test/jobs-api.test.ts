import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";
import { CronAdapter } from "../supervisor/adapters/cron.ts";
import { WebhookAdapter } from "../supervisor/adapters/webhook.ts";
import { SecretStore } from "../supervisor/secrets.ts";
import { ConfigStore } from "../supervisor/config.ts";
import { startServer, type ServerHandle } from "../supervisor/server.ts";
import { staticUi } from "../supervisor/ui-bundle.ts";
import { makeJobsHandlers } from "../supervisor/api/jobs.ts";
import { makeTriggersHandlers } from "../supervisor/api/triggers.ts";
import type { Automation, Config } from "../supervisor/config.ts";

// The job / trigger / config API: additive fields, scheduling state applied to
// both adapters, validated bodies, unified error codes.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FIXTURES = resolve(HERE, "fixtures");

type Ctx = {
  tmp: string;
  db: Database;
  registry: JobRegistry;
  runner: Runner;
  cron: CronAdapter;
  webhook: WebhookAdapter;
  store: ConfigStore;
  server: ServerHandle;
  base: string;
  hasSecret: { value: boolean };
  loadResult: { config: Config | Error };
  applyError: { value: Error | null };
  auth: Record<string, string>;
};

function cronJob(name: string, worker: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id: name,
    name,
    worker,
    triggers: [{ kind: "cron", id: "default", schedule: "* * * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 600_000,
    killGraceMs: 500,
    enabled: true,
    ...overrides,
  };
}

const hookTrigger = {
  kind: "webhook" as const,
  id: "in",
  path: "orders",
  auth: { profile: "hmac-sha256" as const, secretRef: "orders-secret", signatureHeader: "x-sig", signaturePrefix: "sha256=" },
  deliveryIdHeader: "x-delivery",
  contentTypes: ["application/json"],
  maxBodyBytes: 4096,
  keepPayload: false,
};

async function setup(): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "jobs-api-"));
  const db = new Database(join(tmp, "test.db"));
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);

  const hasSecret = { value: false };
  const config: Config = [
    cronJob("cronjob", join(FIXTURES, "hello-worker.ts")),
    cronJob("cond", join(FIXTURES, "hello-worker.ts"), {
      triggers: [
        {
          kind: "cron",
          id: "default",
          schedule: "*/5 * * * *",
          condition: { checker: "./test/fixtures/condition-quiet.ts", timeoutMs: 5_000 },
        },
      ],
    }),
    cronJob("hook", join(FIXTURES, "hello-worker.ts"), { triggers: [hookTrigger] }),
    cronJob("cfgoff", join(FIXTURES, "hello-worker.ts"), { enabled: false }),
    cronJob("busy", join(FIXTURES, "hang-worker.ts"), { timeoutMs: 60_000 }),
  ];

  const registry = new JobRegistry({ db, hasSecret: () => hasSecret.value });
  registry.reconcile(config);
  const runner = new Runner({
    db,
    registry,
    workspaceRoot: REPO_ROOT,
    dataDir: tmp,
    logsDir: join(tmp, "runs"),
  });
  const cron = new CronAdapter({ runner });
  writeFileSync(join(tmp, "secrets.json"), JSON.stringify({ version: 1, secrets: { "orders-secret": HOOK_SECRET } }), { mode: 0o600 });
  const secrets = new SecretStore(join(tmp, "secrets.json"));
  const webhook = new WebhookAdapter({ db, registry: () => registry, runner: () => runner, secrets, dataDir: tmp });

  // Wire it the way main.ts does.
  const applyScheduling = () => {
    cron.reconcile(registry.activeCronJobs());
    webhook.reconcile(registry.webhookJobs());
  };
  registry.onStateChange(applyScheduling);
  applyScheduling();

  const loadResult: { config: Config | Error } = { config };
  const applyError: { value: Error | null } = { value: null };
  const store = new ConfigStore({
    load: async () => {
      if (loadResult.config instanceof Error) throw loadResult.config;
      return { config: loadResult.config };
    },
    apply: () => {
      if (applyError.value) throw applyError.value;
    },
    hasSecret: () => hasSecret.value,
  });
  await store.reload();

  const server = await startServer({
    db,
    registry: () => registry,
    cronAdapter: () => cron,
    runner: () => runner,
    webhookAdapter: () => webhook,
    configStore: () => store,
    port: 0,
    ui: staticUi({ "index.html": "<!doctype html><html><head></head><body></body></html>" }),
    tokenPath: join(tmp, ".token"),
    dataDir: tmp,
    heartbeatMs: 10_000,
  });
  return {
    tmp,
    db,
    registry,
    runner,
    cron,
    webhook,
    store,
    server,
    base: `http://127.0.0.1:${server.port}`,
    hasSecret,
    loadResult,
    applyError,
    auth: { authorization: `Bearer ${server.token}` },
  };
}

let c: Ctx;

beforeEach(async () => {
  c = await setup();
});

afterEach(async () => {
  try {
    await c.server.stop();
  } catch {
    // ignore
  }
  c.registry.close();
  c.cron.stop();
  await c.runner.shutdown(2_000).catch(() => {});
  c.db.close();
  rmSync(c.tmp, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${c.base}${path}`, { headers: c.auth });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body?: unknown, raw?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${c.base}${path}`, {
    method: "POST",
    headers: { ...c.auth, "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const jobByName = async (name: string) => (await get(`/api/jobs/${name}`)).body;
const cronKeys = () => c.cron.list().map((e) => `${e.jobName}:${e.trigger_id}`);

const HOOK_SECRET = "orders-hook-secret";
let hookSeq = 0;
/** A fresh signed body each call, so the dedupe window never answers for the job. */
function signedHook(): { body: string; sig: string } {
  const body = JSON.stringify({ n: ++hookSeq });
  return { body, sig: `sha256=${createHmac("sha256", HOOK_SECRET).update(body).digest("hex")}` };
}

/** A correctly signed delivery: 202 while the job accepts it, 503 (retryable) while it is disabled or paused. */
async function hookStatus(): Promise<number> {
  const { body, sig } = signedHook();
  const res = await fetch(`${c.base}/hooks/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sig": sig },
    body,
  });
  return res.status;
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition not reached in time");
}

describe("trigger shapes", () => {
  test("cron triggers carry next_run_at (epoch ms) and the condition when present", async () => {
    const { body } = await get("/api/jobs");
    const cronjob = body.find((j: any) => j.name === "cronjob");
    const t = cronjob.triggers[0];
    expect(t.kind).toBe("cron");
    expect(t.schedule).toBe("* * * * *");
    expect(typeof t.next_run_at).toBe("number");
    expect(t.next_run_at).toBeGreaterThan(Date.now());
    expect(t.next_run_at).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(t.condition).toBeUndefined();

    const cond = body.find((j: any) => j.name === "cond").triggers[0];
    expect(cond.condition).toEqual({ checker: "./test/fixtures/condition-quiet.ts", timeoutMs: 5_000 });
    expect(cond.next_run_at % 60_000).toBe(0);
  });

  test("next_run_at is null for disabled triggers, disabled jobs, config-disabled jobs and paused jobs", async () => {
    const next = async (name: string) => (await jobByName(name)).triggers[0].next_run_at;
    expect(typeof (await next("cronjob"))).toBe("number");

    await post("/api/jobs/cronjob/disable");
    expect(await next("cronjob")).toBeNull();
    await post("/api/jobs/cronjob/enable");
    expect(typeof (await next("cronjob"))).toBe("number");

    await post("/api/triggers/cronjob:default/disable");
    expect(await next("cronjob")).toBeNull();
    await post("/api/triggers/cronjob:default/enable");
    expect(typeof (await next("cronjob"))).toBe("number");

    await post("/api/jobs/cronjob/pause", { duration_ms: 60_000 });
    expect(await next("cronjob")).toBeNull();
    await post("/api/jobs/cronjob/unpause");
    expect(typeof (await next("cronjob"))).toBe("number");

    const off = await jobByName("cfgoff");
    expect(off.config_enabled).toBe(false);
    expect(off.triggers[0].next_run_at).toBeNull();
    expect((await jobByName("cronjob")).config_enabled).toBe(true);
  });

  test("next_run_at goes null while paused and comes back when the pause ends by itself", async () => {
    const res = await post("/api/jobs/cronjob/pause", { duration_ms: 1_500 });
    expect(res.status).toBe(200);
    expect((await jobByName("cronjob")).triggers[0].next_run_at).toBeNull();
    expect(cronKeys()).not.toContain("cronjob:cronjob:default");

    await until(async () => (await jobByName("cronjob")).triggers[0].next_run_at !== null);
    // The cron adapter is re-reconciled by the pause timer, not by a request.
    await until(() => cronKeys().includes("cronjob:cronjob:default"));
  }, 20_000);

  test("webhook triggers expose their public path, secretRef, headers and whether the secret is set", async () => {
    const t = (await jobByName("hook")).triggers[0];
    expect(t).toMatchObject({
      kind: "webhook",
      trigger_id: "hook:in",
      public_path: "/hooks/orders",
      secretRef: "orders-secret",
      signatureHeader: "x-sig",
      deliveryIdHeader: "x-delivery",
      contentTypes: ["application/json"],
      maxBodyBytes: 4096,
      secret_present: false,
    });
    expect(t.next_run_at).toBeUndefined();
    c.hasSecret.value = true;
    expect((await jobByName("hook")).triggers[0].secret_present).toBe(true);
  });
});

describe("runs on the job entries", () => {
  test("recent_runs carry job_name and duration_ms; the list shows the run in flight as active_run", async () => {
    const started = await post("/api/jobs/busy/run", { force: true });
    expect(started.status).toBe(200);
    await until(() => c.runner.active().some((a) => a.runId === started.body.run_id));

    const list = (await get("/api/jobs")).body;
    const busy = list.find((j: any) => j.name === "busy");
    expect(busy.active_run).toMatchObject({ run_id: started.body.run_id });
    expect(["queued", "running"]).toContain(busy.active_run.state);
    expect(busy.last_run).toBeNull();
    expect(list.find((j: any) => j.name === "cronjob").active_run).toBeNull();

    const detailWhileRunning = await jobByName("busy");
    expect(detailWhileRunning.active_run.run_id).toBe(started.body.run_id);
    expect(detailWhileRunning.recent_runs[0].duration_ms).toBeNull();

    await post(`/api/runs/${started.body.run_id}/cancel`);
    await until(async () => (await jobByName("busy")).active_run === null, 12_000);

    const after = await jobByName("busy");
    const run = after.recent_runs[0];
    expect(run.job_name).toBe("busy");
    expect(run.job_id).toBeString();
    expect(typeof run.duration_ms).toBe("number");
    expect(run.duration_ms).toBe(run.finished_at - run.started_at);
    expect(after.last_run.run_id).toBe(started.body.run_id);
  }, 30_000);
});

describe("state is applied to cron and webhook adapters", () => {
  test("job disable/enable moves the cron entry and makes the webhook answer 503 while disabled", async () => {
    expect(cronKeys()).toContain("cronjob:cronjob:default");
    expect(await hookStatus()).toBe(202); // signed delivery is admitted

    await post("/api/jobs/cronjob/disable");
    expect(cronKeys()).not.toContain("cronjob:cronjob:default");
    await post("/api/jobs/hook/disable");
    expect(await hookStatus()).toBe(503);

    await post("/api/jobs/hook/enable");
    expect(await hookStatus()).toBe(202);
    await post("/api/jobs/cronjob/enable");
    expect(cronKeys()).toContain("cronjob:cronjob:default");
  });

  test("trigger disable/enable makes the webhook answer 503 and restores it", async () => {
    expect(await hookStatus()).toBe(202);
    expect((await post("/api/triggers/hook:in/disable")).status).toBe(200);
    expect(await hookStatus()).toBe(503);
    expect((await post("/api/triggers/hook:in/enable")).status).toBe(200);
    expect(await hookStatus()).toBe(202);
  });

  test("pause makes the webhook answer 503 and it is accepted again when the pause ends", async () => {
    await post("/api/jobs/hook/pause", { duration_ms: 1_500 });
    expect(await hookStatus()).toBe(503);
    await until(async () => (await hookStatus()) === 202);
    expect((await jobByName("hook")).paused_until).toBeLessThanOrEqual(Date.now());
  }, 20_000);

  test("unpause restores a paused job immediately", async () => {
    await post("/api/jobs/hook/pause", { duration_ms: 60_000 });
    expect(await hookStatus()).toBe(503);
    await post("/api/jobs/hook/unpause");
    expect(await hookStatus()).toBe(202);
  });

  test("a config-disabled job is not scheduled at all", () => {
    expect(cronKeys().some((k) => k.startsWith("cfgoff:"))).toBe(false);
  });

  test("without a state subscriber the handlers reconcile the cron and webhook adapters themselves", async () => {
    const bare = new JobRegistry({ db: c.db });
    bare.reconcile([cronJob("cronjob", join(FIXTURES, "hello-worker.ts")), cronJob("hook", join(FIXTURES, "hello-worker.ts"), { triggers: [hookTrigger] })]);
    const cron = new CronAdapter({ runner: c.runner });
    const webhook = new WebhookAdapter({
      db: c.db,
      registry: () => bare,
      runner: () => c.runner,
      secrets: new SecretStore(join(c.tmp, "secrets.json")),
      dataDir: c.tmp,
    });
    cron.reconcile(bare.activeCronJobs());
    webhook.reconcile(bare.webhookJobs());
    let emitted = 0;
    const ctx = {
      db: c.db,
      registry: () => bare,
      cronAdapter: () => cron,
      runner: () => c.runner,
      webhookAdapter: () => webhook,
      emitConfigReloaded: () => void emitted++,
    };
    const jobs = makeJobsHandlers(ctx);
    const triggers = makeTriggersHandlers(ctx);
    const req = () => new Request("http://x/", { method: "POST" });
    const hookReq = () => {
      const { body, sig } = signedHook();
      return new Request("http://x/hooks/orders", { method: "POST", body, headers: { "content-type": "application/json", "x-sig": sig } });
    };

    await jobs.disable(req(), { name: "hook" }, new URL("http://x/"));
    expect((await webhook.handle("orders", hookReq())).status).toBe(503);
    await jobs.enable(req(), { name: "hook" }, new URL("http://x/"));
    expect((await webhook.handle("orders", hookReq())).status).toBe(202);
    await triggers.disable(req(), { trigger_id: "cronjob:default" }, new URL("http://x/"));
    expect(cron.list()).toHaveLength(0);
    await triggers.enable(req(), { trigger_id: "cronjob:default" }, new URL("http://x/"));
    expect(cron.list()).toHaveLength(1);
    expect(emitted).toBe(4);
    cron.stop();
    bare.close();
  });

  test("every state change announces itself on the event stream", async () => {
    const res = await fetch(`${c.base}/events`, { headers: c.auth });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const pump = (async () => {
      while (!seen.includes("config.reloaded")) {
        const { value, done } = await reader.read();
        if (done) return;
        seen += decoder.decode(value);
      }
    })();
    await post("/api/jobs/cronjob/disable");
    await Promise.race([pump, Bun.sleep(3_000)]);
    await reader.cancel();
    expect(seen).toContain("config.reloaded");
  });
});

describe("request validation", () => {
  const pause = (body: unknown, raw?: string) => post("/api/jobs/cronjob/pause", body, raw);

  test("duration_ms is bounded to 1 s .. 1 year", async () => {
    expect((await pause({ duration_ms: 999 })).status).toBe(400);
    expect((await pause({ duration_ms: 31_536_000_001 })).status).toBe(400);
    expect((await pause({ duration_ms: "5000" })).status).toBe(400);
    expect((await pause({ duration_ms: null })).status).toBe(400);
    const ok = await pause({ duration_ms: 1_000 });
    expect(ok.status).toBe(200);
    expect((await pause({ duration_ms: 31_536_000_000 })).status).toBe(200);
  });

  test("until_iso must be a valid future timestamp within a year", async () => {
    expect((await pause({ until_iso: "yesterday-ish" })).body.error).toBe("invalid_until_iso");
    const past = await pause({ until_iso: new Date(Date.now() - 60_000).toISOString() });
    expect(past.status).toBe(400);
    expect(past.body.error).toBe("invalid_until_iso");
    const far = await pause({ until_iso: new Date(Date.now() + 2 * 31_536_000_000).toISOString() });
    expect(far.status).toBe(400);

    const at = new Date(Date.now() + 3_600_000);
    const ok = await pause({ until_iso: at.toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.body.paused_until).toBe(at.getTime());
  });

  test("neither, both, wrong types and bad JSON are 400 with distinct codes", async () => {
    expect((await pause({})).body.error).toBe("missing_duration_or_until");
    expect((await pause({ duration_ms: 5_000, until_iso: new Date(Date.now() + 9e6).toISOString() })).body.error).toBe("invalid_body");
    expect((await pause(undefined, "{not json")).body.error).toBe("invalid_json");
    expect((await pause(undefined, "[1,2]")).body.error).toBe("invalid_body");
    expect((await pause(undefined, "42")).body.error).toBe("invalid_body");
    const bad = await pause({ duration_ms: "x" });
    expect(bad.body.error).toBe("invalid_body");
    expect(bad.body.details).toContain("duration_ms");
  });

  test("nothing is written when the body is rejected", async () => {
    await pause({ duration_ms: 1 });
    expect((await jobByName("cronjob")).paused_until).toBeNull();
  });

  test("run body: force must be a boolean, reason a string", async () => {
    expect((await post("/api/jobs/cronjob/run", { force: "yes" })).body.error).toBe("invalid_body");
    expect((await post("/api/jobs/cronjob/run", { reason: 5 })).body.error).toBe("invalid_body");
    expect((await post("/api/jobs/cronjob/run", undefined, "nope")).body.error).toBe("invalid_json");
    // An empty body is fine.
    const empty = await post("/api/jobs/cronjob/run");
    expect([200, 202]).toContain(empty.status);
  });

  test("oversize bodies are refused before parsing", async () => {
    const big = JSON.stringify({ reason: "x".repeat(200_000) });
    expect((await post("/api/jobs/cronjob/run", undefined, big)).status).toBe(413);
  });
});

describe("error codes", () => {
  test("an unknown job is 404 not_found everywhere, including run", async () => {
    for (const [method, path] of [
      ["GET", "/api/jobs/nope"],
      ["POST", "/api/jobs/nope/run"],
      ["POST", "/api/jobs/nope/enable"],
      ["POST", "/api/jobs/nope/disable"],
      ["POST", "/api/jobs/nope/pause"],
      ["POST", "/api/jobs/nope/unpause"],
      ["POST", "/api/triggers/nope:default/enable"],
      ["POST", "/api/triggers/nope:default/disable"],
    ] as const) {
      const res = await fetch(`${c.base}${path}`, {
        method,
        headers: { ...c.auth, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ duration_ms: 5_000 }) : undefined,
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error).toBe("not_found");
    }
  });
});

describe("config status and reload", () => {
  test("status carries warnings and lastError", async () => {
    let s = (await get("/api/config/status")).body;
    expect(s.ok).toBe(true);
    expect(s.jobs).toBe(5);
    expect(s.lastError).toBeNull();
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatchObject({ code: "missing_secret", job: "hook", trigger_id: "hook:in" });

    c.hasSecret.value = true;
    s = (await get("/api/config/status")).body;
    expect(s.warnings).toEqual([]);
  });

  test("a valid reload reports the counts, warnings and what changed", async () => {
    const current = c.store.current!;
    c.loadResult.config = [...current, cronJob("extra", join(FIXTURES, "hello-worker.ts"))];
    const res = await post("/api/config/reload");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobs: 6, errors: [], changes: { added: ["extra"], removed: [], changed: [] } });
    expect(res.body.warnings).toHaveLength(1);
    expect((await get("/api/config/status")).body.jobs).toBe(6);
  });

  test("an invalid file is 400 config_invalid and status keeps the old config and shows the error", async () => {
    c.loadResult.config = new Error("Config validation failed:\n  - job \"x\", schedule: bad");
    const res = await post("/api/config/reload");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "config_invalid", stage: "load" });
    expect(res.body.details).toContain("schedule: bad");

    const s = (await get("/api/config/status")).body;
    expect(s.ok).toBe(false);
    expect(s.jobs).toBe(5);
    expect(s.lastError.message).toContain("schedule: bad");
  });

  test("a config the runtime cannot apply is rejected, not reported as reloaded", async () => {
    c.loadResult.config = [...c.store.current!, cronJob("extra", join(FIXTURES, "hello-worker.ts"))];
    c.applyError.value = new Error("registry write failed");
    const res = await post("/api/config/reload");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "config_invalid", stage: "apply" });
    const s = (await get("/api/config/status")).body;
    expect(s.ok).toBe(false);
    expect(s.jobs).toBe(5);
    expect(s.lastError.message).toContain("registry write failed");

    c.applyError.value = null;
    expect((await post("/api/config/reload")).status).toBe(200);
    expect((await get("/api/config/status")).body).toMatchObject({ ok: true, jobs: 6, lastError: null });
  });
});

describe("skip_reason and the last real run", () => {
  test("runs the supervisor refused or ended itself carry skip_reason in the list, the detail and the job's recent runs", async () => {
    expect((await post("/api/jobs/cronjob/disable")).status).toBe(200);
    const refused = await post("/api/jobs/cronjob/run", {});
    expect(refused.status).toBe(422);
    const runId = refused.body.run_id as string;

    const list = (await get("/api/runs?state=skipped")).body as { run_id: string; skip_reason: string | null }[];
    expect(list.find((r) => r.run_id === runId)?.skip_reason).toBe("disabled");
    const detail = (await get(`/api/runs/${runId}`)).body;
    expect(detail).toMatchObject({ state: "skipped", skip_reason: "disabled" });
    const job = (await get("/api/jobs/cronjob")).body;
    expect(job.recent_runs.find((r: { run_id: string }) => r.run_id === runId)).toMatchObject({ skip_reason: "disabled" });
  });

  test("an ordinary run reports skip_reason null", async () => {
    const started = await post("/api/jobs/cronjob/run", {});
    expect(started.status).toBe(200);
    await until(async () => (await get(`/api/runs/${started.body.run_id}`)).body.state === "succeeded");
    expect((await get(`/api/runs/${started.body.run_id}`)).body.skip_reason).toBeNull();
  });

  test("a refused manual run does not replace the last real run in last_run", async () => {
    const started = await post("/api/jobs/cronjob/run", {});
    await until(async () => (await get(`/api/runs/${started.body.run_id}`)).body.state === "succeeded");
    await post("/api/jobs/cronjob/disable");
    expect((await post("/api/jobs/cronjob/run", {})).status).toBe(422);

    const job = (await get("/api/jobs/cronjob")).body;
    expect(job.last_run.run_id).toBe(started.body.run_id);
    expect(job.last_run.state).toBe("succeeded");
    // Both are still in the history.
    expect(job.recent_runs.map((r: { state: string }) => r.state)).toContain("skipped");
  });

  test("a job that only ever had skipped runs has no last_run", async () => {
    expect((await post("/api/jobs/cfgoff/run", {})).status).toBe(422);
    expect((await get("/api/jobs/cfgoff")).body.last_run).toBeNull();
  });
});

describe("what the supervisor reports about itself", () => {
  test("/api/config/status carries the version and commit of the running code", async () => {
    const s = (await get("/api/config/status")).body;
    const pkg = JSON.parse(await Bun.file(join(REPO_ROOT, "package.json")).text()) as { version: string };
    expect(s.supervisor.version).toBe(pkg.version);
    expect(s.supervisor.commit === null || /^[0-9a-f]{4,}$/.test(s.supervisor.commit)).toBe(true);
  });

  test("a disabled job with a missing worker is a warning, not an error", async () => {
    // cfgoff is enabled:false; the store is not given a workspace probe here, so drive the pure check.
    const { computeConfigWarnings } = await import("../supervisor/config.ts");
    const off = c.store.current!.filter((j) => j.name === "cfgoff").map((j) => ({ ...j, worker: "./jobs/definitely-gone.ts" }));
    const warnings = computeConfigWarnings(off, undefined, REPO_ROOT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "missing_file", job: "cfgoff" });
  });
});
