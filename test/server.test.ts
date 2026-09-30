import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "../supervisor/db/migrate.ts";
import { uuidv4 } from "../supervisor/db/ids.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";
import { CronAdapter } from "../supervisor/adapters/cron.ts";
import { ConfigStore } from "../supervisor/config.ts";
import { startServer, type ServerHandle } from "../supervisor/server.ts";
import type { Automation, Config } from "../supervisor/config.ts";
import type { RunFinishedEvent } from "../supervisor/runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FIXTURES = resolve(HERE, "fixtures");

type Ctx = {
  tmp: string;
  dataDir: string;
  tokenPath: string;
  db: Database;
  runner: Runner;
  registry: JobRegistry;
  cron: CronAdapter;
  configStore: ConfigStore;
  server: ServerHandle;
  port: number;
};

function makeJob(name: string, worker: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id: name,
    name,
    description: "test job",
    worker,
    triggers: [{ kind: "cron", id: "default", schedule: "* * * * *" }],
    reentrancy: overrides.reentrancy ?? "drop",
    queueDepth: overrides.queueDepth ?? 1,
    timeoutMs: overrides.timeoutMs ?? 600_000,
    killGraceMs: overrides.killGraceMs ?? 10_000,
    enabled: overrides.enabled ?? true,
  };
}

// Use port 0 — Bun.serve picks a free one.
async function setup(): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "server-test-"));
  const dataDir = tmp;
  const tokenPath = join(tmp, ".token");
  const dbPath = join(tmp, "test.db");
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);

  // Seed config — a single harmless job backed by the hello-worker fixture.
  const config: Config = [
    makeJob("hello-job", join(FIXTURES, "hello-worker.ts")),
  ];

  const registry = new JobRegistry({ db });
  registry.reconcile(config);

  const runner = new Runner({
    db,
    registry,
    workspaceRoot: REPO_ROOT,
    dataDir,
    logsDir: join(dataDir, "runs"),
  });

  const cron = new CronAdapter({ runner });
  cron.reconcile(registry.activeCronJobs());

  const configStore = new ConfigStore();
  configStore.current = config;
  configStore.lastLoadedAt = Date.now();
  // Don't actually start the watcher — we don't want real file watch in tests.

  const server = await startServer({
    db,
    registry: () => registry,
    cronAdapter: () => cron,
    runner: () => runner,
    configStore: () => configStore,
    port: 0,
    uiDistDir: resolve(REPO_ROOT, "ui", "dist"),
    tokenPath,
    dataDir,
    heartbeatMs: 10_000,
  });

  return {
    tmp,
    dataDir,
    tokenPath,
    db,
    runner,
    registry,
    cron,
    configStore,
    server,
    port: server.port,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  try {
    await ctx.server.stop();
  } catch {
    /* ignore */
  }
  try {
    ctx.cron.stop();
  } catch {
    /* ignore */
  }
  try {
    await ctx.runner.shutdown(2_000);
  } catch {
    /* ignore */
  }
  try {
    ctx.db.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(ctx.tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function waitForRunFinish(runner: Runner, runId: string): Promise<RunFinishedEvent | null> {
  return new Promise((resolve) => {
    const handler = (e: RunFinishedEvent) => {
      if (e.run_id === runId) {
        runner.off("run.finished", handler);
        resolve(e);
      }
    };
    runner.on("run.finished", handler);
    if (!runner.active().some((a) => a.runId === runId)) {
      runner.off("run.finished", handler);
      resolve(null);
    }
    setTimeout(() => {
      runner.off("run.finished", handler);
      resolve(null);
    }, 5_000);
  });
}

let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await teardown(ctx);
});

describe("server: token + auth", () => {
  test("token file is 64 hex chars + newline, mode 0600", () => {
    expect(existsSync(ctx.tokenPath)).toBe(true);
    const stat = statSync(ctx.tokenPath);
    // POSIX low 9 bits: owner only.
    // mode 0o600 = 0o100600 in stat mode (S_IFREG | 0o600); mask off file type.
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = readFileSync(ctx.tokenPath, "utf8");
    expect(raw.length).toBe(65); // 64 hex + newline
    expect(/^[0-9a-f]{64}\n$/.test(raw)).toBe(true);
  });

  test("GET /api/jobs without token -> 401 unauthorized", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("unauthorized");
  });

  test("GET /api/jobs with valid token -> 200 with one job", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs`, {
      headers: authHeaders(ctx.server.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("hello-job");
    expect(body[0].enabled).toBe(true);
    expect(Array.isArray(body[0].triggers)).toBe(true);
    expect(body[0].triggers[0].trigger_id).toBe("hello-job:default");
    expect(body[0].triggers[0].kind).toBe("cron");
    expect(body[0].triggers[0].enabled).toBe(true);
  });

  test("only the Authorization header carries the token (X-Auto-Token, cookie and query do not)", async () => {
    const t = ctx.server.token;
    const base = `http://127.0.0.1:${ctx.port}/api/jobs`;
    expect((await fetch(base, { headers: { "x-auto-token": t } })).status).toBe(401);
    expect((await fetch(base, { headers: { cookie: `auto_session=${t}` } })).status).toBe(401);
    expect((await fetch(`${base}?token=${t}`)).status).toBe(401);
  });

  test("Bad Origin header -> 403", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs`, {
      headers: { ...authHeaders(ctx.server.token), origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad_origin");
  });

  test("Bad Origin header on a POST -> 403 as well", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/pause`, {
      method: "POST",
      headers: { ...authHeaders(ctx.server.token), origin: "http://evil.com", "content-type": "application/json" },
      body: JSON.stringify({ duration_ms: 60_000 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("bad_origin");
  });

  test("Allowed Origin (loopback) -> 200", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs`, {
      headers: { ...authHeaders(ctx.server.token), origin: `http://127.0.0.1:${ctx.port}` },
    });
    expect(res.status).toBe(200);
  });

  test("the old automations.localhost host is no longer built in -> 403 bad_host", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs`, {
      headers: { ...authHeaders(ctx.server.token), host: "automations.localhost" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("bad_host");
  });
});

describe("server: jobs detail + run + state", () => {
  test("GET /api/jobs/hello-job -> 200 with recent_runs", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job`, {
      headers: authHeaders(ctx.server.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("hello-job");
    expect(Array.isArray(body.recent_runs)).toBe(true);
    expect(body.recent_runs.length).toBe(0);
  });

  test("GET /api/jobs/unknown -> 404", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/does-not-exist`, {
      headers: authHeaders(ctx.server.token),
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/jobs/:name/run with force:true -> 200 with run_id; runs row appears", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx.server.token), "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.run_id).toBe("string");
    expect(body.run_id.length).toBeGreaterThan(8);

    await waitForRunFinish(ctx.runner, body.run_id);

    const list = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/runs`, {
      headers: authHeaders(ctx.server.token),
    })).json()) as any[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((r: any) => r.run_id === body.run_id)).toBe(true);
  });

  test("POST /api/jobs/:name/disable -> 200; subsequent GET shows enabled:false", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/disable`, {
      method: "POST",
      headers: authHeaders(ctx.server.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);

    const detail = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job`, {
      headers: authHeaders(ctx.server.token),
    })).json()) as any;
    expect(detail.enabled).toBe(false);
  });

  test("POST /api/jobs/:name/pause with duration_ms -> 200 with paused_until reflected in detail", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/pause`, {
      method: "POST",
      headers: { ...authHeaders(ctx.server.token), "content-type": "application/json" },
      body: JSON.stringify({ duration_ms: 60_000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.paused_until).toBe("number");
    expect(body.paused_until).toBeGreaterThan(Date.now());

    const detail = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job`, {
      headers: authHeaders(ctx.server.token),
    })).json()) as any;
    expect(detail.paused_until).toBe(body.paused_until);

    // activeCronJobs should now exclude the paused job.
    const active = ctx.registry.activeCronJobs();
    expect(active.some((j) => j.name === "hello-job")).toBe(false);
  });

  test("POST /api/jobs/:name/unpause -> 200 clears paused_until", async () => {
    await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/pause`, {
      method: "POST",
      headers: { ...authHeaders(ctx.server.token), "content-type": "application/json" },
      body: JSON.stringify({ duration_ms: 60_000 }),
    });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/unpause`, {
      method: "POST",
      headers: authHeaders(ctx.server.token),
    });
    expect(res.status).toBe(200);
    const detail = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job`, {
      headers: authHeaders(ctx.server.token),
    })).json()) as any;
    expect(detail.paused_until).toBeNull();
  });
});

describe("server: runs", () => {
  test("GET /api/runs/<8-char-prefix> when ambiguous -> 409 ambiguous_prefix", async () => {
    // Insert two run rows whose IDs share an 8-char prefix.
    const jobId = ctx.registry.activeJobs()[0]
      ? (ctx.db
          .query<{ job_id: string }, [string]>("SELECT job_id FROM jobs WHERE name = ?")
          .get("hello-job")?.job_id ?? uuidv4())
      : uuidv4();
    const sharedPrefix = "abcdef12";
    const run1 = sharedPrefix + "-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const run2 = sharedPrefix + "-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const now = Date.now();
    for (const id of [run1, run2]) {
      ctx.db
        .prepare(
          `INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at, finished_at)
           VALUES (?, ?, 'manual', 'succeeded', ?, ?)`,
        )
        .run(id, jobId, now, now);
    }
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/${sharedPrefix}`, {
      headers: authHeaders(ctx.server.token),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe("ambiguous_prefix");
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBe(2);
  });

  test("GET /api/runs/:id/log -> 200 text/plain after a manual run", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx.server.token), "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const { run_id } = (await res.json()) as { run_id: string };
    await waitForRunFinish(ctx.runner, run_id);
    const logRes = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/${run_id}/log`, {
      headers: authHeaders(ctx.server.token),
    });
    expect(logRes.status).toBe(200);
    expect(logRes.headers.get("content-type") ?? "").toContain("text/plain");
    const text = await logRes.text();
    expect(text).toContain(`hello from RUN_ID=${run_id}`);
  });

  test("POST /api/runs/:id/cancel after exit -> 409 already_finished", async () => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs/hello-job/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx.server.token), "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const { run_id } = (await r.json()) as { run_id: string };
    await waitForRunFinish(ctx.runner, run_id);
    const c = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/${run_id}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx.server.token),
    });
    expect(c.status).toBe(409);
    const body = (await c.json()) as any;
    expect(body.error).toBe("already_finished");
  });
});

describe("server: SPA shell + healthz", () => {
  test("GET / -> 200 text/html with the token and bound port in the bootstrap tag", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    // The port is the bound one (not the requested 0), and the token is the live one.
    expect(text).toContain(`{"token":"${ctx.server.token}","port":${ctx.port}}`);
    expect(text).toContain('<script id="auto-bootstrap" type="application/json">');
  });

  test("the token in the page opens the API, and no cookie is involved", async () => {
    const page = await (await fetch(`http://127.0.0.1:${ctx.port}/`)).text();
    const token = JSON.parse(/id="auto-bootstrap"[^>]*>(.*?)<\/script>/s.exec(page)![1]!).token as string;
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/jobs`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("GET /assets/<missing> -> 404 (no SPA fallback)", async () => {
    // Bun's fetch normalizes `..` traversals before sending, so we can't
    // exercise the literal traversal vector via fetch. The complementary
    // guarantee — that a missing /assets/ file does NOT fall through to the
    // SPA shell — is testable directly.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/assets/does-not-exist.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  test("GET /healthz -> minimal {ok, degraded}; no auth required", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
    expect([200, 503].includes(res.status)).toBe(true);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(["degraded", "ok"]);
    expect(typeof body.ok).toBe("boolean");
    expect(body.degraded).toBe(res.status === 503);
  });

  test("GET /hooks/whatever -> 404 (excluded from SPA fallback)", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/hooks/foo`);
    expect(res.status).toBe(404);
  });

  test("GET /some/spa/route -> 200 HTML (SPA fallback)", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/jobs/hello-job`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });
});
