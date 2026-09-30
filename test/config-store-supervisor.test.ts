import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./cli-harness.ts";

// The real supervisor process against a temp workspace: the config file is
// edited while it runs and every edit must be observed (hot reload), a broken
// edit must keep the running config, and `--check` must agree with it.

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_MAIN = resolve(HERE, "..", "supervisor/main.ts");
const PORT = Number(process.env.CONFIG_TEST_PORT ?? 17950);
const BASE = `http://127.0.0.1:${PORT}`;

let tmp: string;
let home: string;
let dataDir: string;
let configPath: string;
let procs: Array<ReturnType<typeof Bun.spawn>> = [];

function job(name: string, schedule = "0 3 * * *", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: name,
    name,
    worker: "./jobs/hello.ts",
    triggers: [{ kind: "cron", id: "t", schedule }],
    ...extra,
  };
}

function writeConfig(jobs: unknown[]): void {
  writeFileSync(configPath, `export default ${JSON.stringify(jobs)};\n`);
}

function env(): Record<string, string> {
  return {
    ...cleanEnv(),
    HOME: tmp,
    AUTO_HOME: home,
    AUTO_DATA_DIR: dataDir,
    AUTO_PORT: String(PORT),
    AUTO_NOTIFY: "0",
  };
}

function startSupervisor(): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn([process.execPath, SUPERVISOR_MAIN], {
    cwd: home,
    env: env(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(proc);
  return proc;
}

async function until<T>(check: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(50);
  }
  throw new Error(`condition not reached in time${last ? `: ${last}` : ""}`);
}

const token = () => readFileSync(join(dataDir, ".token"), "utf8").trim();

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const jobNames = async () => ((await api("/api/jobs")).body as any[]).map((j) => j.name);
const healthz = () => fetch(`${BASE}/healthz`).then((r) => r.status);

async function check(): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([process.execPath, SUPERVISOR_MAIN, "--check"], {
    cwd: home,
    env: env(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, text: out + err };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "config-supervisor-"));
  home = join(tmp, "home");
  dataDir = join(home, "data");
  configPath = join(home, "auto.config.ts");
  mkdirSync(join(home, "jobs"), { recursive: true });
  writeFileSync(join(home, "jobs", "hello.ts"), "console.log('hello');\n");
  procs = [];
});

afterEach(async () => {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // gone
    }
  }
  await Promise.all(procs.map((p) => Promise.race([p.exited, Bun.sleep(4_000)])));
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("hot reload in the running supervisor", () => {
  test("every edit is observed: add, break (last-known-good stays), fix, atomic-rename save; --check agrees", async () => {
    writeConfig([job("one")]);
    startSupervisor();
    await until(async () => (await healthz()) === 200);
    expect(await jobNames()).toEqual(["one"]);
    expect((await check()).code).toBe(0);

    // Valid change.
    writeConfig([job("one"), job("two")]);
    await until(async () => (await jobNames()).length === 2);
    expect((await api("/api/config/status")).body).toMatchObject({ ok: true, jobs: 2, lastError: null });

    // Invalid change: reported, previous config keeps running, --check says the same.
    writeConfig([job("one"), job("two", "99 * * * *")]);
    const status = await until(async () => {
      const s = (await api("/api/config/status")).body;
      return s.ok === false ? s : null;
    });
    expect(status.jobs).toBe(2);
    expect(status.lastError.message).toContain('job "two"');
    expect(status.lastError.message).toContain("invalid cron pattern");
    expect(await jobNames()).toEqual(["one", "two"]);
    const bad = await check();
    expect(bad.code).toBe(78);
    expect(bad.text).toContain('job "two"');
    // A broken config never degrades a supervisor that already runs a good one.
    expect(await healthz()).toBe(200);

    // A missing worker is the same class of error.
    writeConfig([job("one"), job("three", "0 3 * * *", { worker: "./jobs/missing.ts" })]);
    await until(async () => (await api("/api/config/status")).body.lastError?.message.includes("missing.ts"));
    expect(await jobNames()).toEqual(["one", "two"]);

    // Fixed: recovers.
    writeConfig([job("three")]);
    await until(async () => (await jobNames()).join() === "three");
    expect((await api("/api/config/status")).body).toMatchObject({ ok: true, jobs: 1, lastError: null });
    expect((await check()).code).toBe(0);

    // Atomic-write editors (write temp file, rename over the config).
    const tmpFile = join(home, ".auto.config.ts.swp");
    writeFileSync(tmpFile, `export default ${JSON.stringify([job("four")])};\n`);
    renameSync(tmpFile, configPath);
    await until(async () => (await jobNames()).join() === "four");
  }, 90_000);

  test("POST /api/config/reload reports the real state", async () => {
    writeConfig([job("one")]);
    startSupervisor();
    await until(async () => (await healthz()) === 200);
    writeConfig([job("one"), job("two")]);
    const ok = await api("/api/config/reload", { method: "POST" });
    expect(ok.status).toBe(200);
    expect(ok.body.jobs).toBe(2);
    expect(ok.body.changes.added).toEqual(["two"]);
    expect(await jobNames()).toEqual(["one", "two"]);

    writeConfig([job("one"), job("bad:name")]);
    const bad = await api("/api/config/reload", { method: "POST" });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toContain("bad:name");
    expect(await jobNames()).toEqual(["one", "two"]);
    expect((await api("/api/config/status")).body.ok).toBe(false);
  }, 60_000);

  test("a cold start with a broken config is degraded and recovers when the file is fixed", async () => {
    writeConfig([job("one", "not cron")]);
    startSupervisor();
    await until(async () => (await healthz()) === 503);
    const s = (await api("/api/config/status")).body;
    expect(s.ok).toBe(false);
    expect(s.degraded.active).toBe(true);
    expect(s.lastError.message).toContain("cron pattern");
    expect(await jobNames()).toEqual([]);
    expect((await check()).code).toBe(78);

    writeConfig([job("one")]);
    await until(async () => (await healthz()) === 200);
    expect(await jobNames()).toEqual(["one"]);
    expect((await api("/api/config/status")).body).toMatchObject({ ok: true, lastError: null, degraded: { active: false } });
  }, 60_000);

  test("a cold start with no config file is degraded and recovers when the file is created", async () => {
    startSupervisor();
    await until(async () => (await healthz()) === 503);
    expect((await api("/api/config/status")).body.lastError.message).toContain("config file not found");

    writeConfig([job("late")]);
    await until(async () => (await healthz()) === 200);
    expect(await jobNames()).toEqual(["late"]);
  }, 60_000);

  test("pausing a per-minute job: next_run_at goes null, then returns when the pause ends", async () => {
    writeConfig([job("every-minute", "* * * * *")]);
    startSupervisor();
    await until(async () => (await healthz()) === 200);
    const next = async () => ((await api("/api/jobs/every-minute")).body.triggers[0].next_run_at as number | null);
    expect(typeof (await next())).toBe("number");

    const res = await api("/api/jobs/every-minute/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration_ms: 3_000 }),
    });
    expect(res.status).toBe(200);
    expect(await next()).toBeNull();
    await until(async () => (await next()) !== null, 10_000);
  }, 60_000);

  test("a job disabled in the config is not scheduled", async () => {
    writeConfig([job("on", "* * * * *"), job("off", "* * * * *", { enabled: false })]);
    startSupervisor();
    await until(async () => (await healthz()) === 200);
    const jobs = (await api("/api/jobs")).body as any[];
    expect(jobs.find((j) => j.name === "on").triggers[0].next_run_at).toBeNumber();
    expect(jobs.find((j) => j.name === "off").triggers[0].next_run_at).toBeNull();
    expect(jobs.find((j) => j.name === "off").config_enabled).toBe(false);
  }, 60_000);
});
