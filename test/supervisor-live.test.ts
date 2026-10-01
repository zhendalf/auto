import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, makeWorkspace, runAuto, startSupervisor, writeWorkspaceFiles, type Workspace } from "./cli-harness.ts";

// Real supervisor processes (a private workspace each, `bun supervisor/main.ts`, never cron):
// degraded cold start, the stale degraded flag, a token file replaced while running,
// a config loader that never finishes at SIGTERM, a data directory that is not
// Auto's, a second supervisor on a taken port, and a condition checker at shutdown.

const PORT = Number(process.env.SUPERVISOR_LIVE_TEST_PORT ?? 17988);
const SUPERVISOR_MAIN = resolve(ROOT, "supervisor/main.ts");

const HOOK_JOB = `{
  id: "hook", name: "hook", worker: "./jobs/hook.ts",
  triggers: [{ kind: "webhook", id: "in", path: "in",
    auth: { profile: "hmac-sha256", secretRef: "hook-secret", signatureHeader: "x-sig" } }],
}`;
const GOOD_CONFIG = `export default [\n${HOOK_JOB},\n];\n`;
const DEGRADED_CONFIG = `export default [\n${HOOK_JOB},\n  { bad: true },\n];\n`;

const workspaces: Workspace[] = [];
const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stoppers.length) await stoppers.pop()!().catch(() => {});
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function workspace(config: string): Workspace {
  const ws = makeWorkspace(PORT);
  workspaces.push(ws);
  writeWorkspaceFiles(ws, config, { "hook.ts": `console.log("hook");\n` });
  return ws;
}

async function start(ws: Workspace) {
  const sup = await startSupervisor(ws, PORT);
  stoppers.push(sup.stop);
  return sup;
}

const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
const degradedFlag = (ws: Workspace) => join(ws.data, "state", "degraded.json");

async function until(check: () => boolean | Promise<boolean>, ms = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a cold start on a config that does not validate", () => {
  test("/hooks/* answers a retryable 503 (not 404) until a good config loads, then the route exists", async () => {
    const ws = workspace(DEGRADED_CONFIG);
    await start(ws);
    expect((await fetch(url("/healthz"))).status).toBe(503);

    const degraded = await fetch(url("/hooks/in"), { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-sig": `sha256=${"0".repeat(64)}` } });
    expect(degraded.status).toBe(503);
    expect(degraded.headers.get("retry-after")).toBe("60");
    expect(await degraded.json()).toEqual({ error: "supervisor_degraded" });

    // A dashboard open on the degraded screen hears about the recovery.
    const token = readFileSync(join(ws.data, ".token"), "utf8").trim();
    const events = await fetch(url("/events"), { headers: { authorization: `Bearer ${token}` } });
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    const seen = (async () => {
      let text = "";
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
        if (text.includes("event: degraded.exited")) return text;
      }
    })();

    writeFileSync(join(ws.home, "auto.config.ts"), GOOD_CONFIG);
    await until(async () => (await fetch(url("/healthz"))).status === 200, 15_000, "hot reload to recover");
    const stream = await Promise.race([seen, Bun.sleep(5_000).then(() => "")]);
    await reader.cancel().catch(() => {});
    expect(stream).toContain("event: degraded.exited");
    // The route exists now: an unsigned/unknown delivery is a plain 401, and so is an unknown path.
    const recovered = await fetch(url("/hooks/in"), { method: "POST", body: "{}", headers: { "x-sig": `sha256=${"0".repeat(64)}` } });
    expect(recovered.status).toBe(401);
    expect((await fetch(url("/hooks/nope"), { method: "POST", body: "{}" })).status).toBe(401);
    expect(existsSync(degradedFlag(ws))).toBe(false);
  }, 60_000);

  test("degraded.json left by a supervisor that died while degraded is cleared by the next healthy start", async () => {
    const ws = workspace(DEGRADED_CONFIG);
    const first = await start(ws);
    expect(existsSync(degradedFlag(ws))).toBe(true);
    await first.stop();
    expect(existsSync(degradedFlag(ws))).toBe(true); // still there after the stop

    writeFileSync(join(ws.home, "auto.config.ts"), GOOD_CONFIG);
    await start(ws);
    expect((await fetch(url("/healthz"))).status).toBe(200);
    expect(await (await fetch(url("/healthz"))).json()).toEqual({ ok: true, degraded: false });
    expect(existsSync(degradedFlag(ws))).toBe(false);
  }, 60_000);
});

describe("the token file replaced while the supervisor runs", () => {
  test("the old token stops working at once, the CLI keeps working, and / embeds the new token", async () => {
    const ws = workspace(GOOD_CONFIG);
    await start(ws);
    const tokenPath = join(ws.data, ".token");
    const oldToken = readFileSync(tokenPath, "utf8").trim();
    const call = (token: string) => fetch(url("/api/jobs"), { headers: { authorization: `Bearer ${token}` } });
    expect((await call(oldToken)).status).toBe(200);

    const replacement = "f".repeat(64);
    writeFileSync(tokenPath, replacement + "\n", { mode: 0o600 });

    expect((await call(oldToken)).status).toBe(401);
    expect((await call(replacement)).status).toBe(200);
    const page = await (await fetch(url("/"))).text();
    expect(page).toContain(replacement);
    expect(page).not.toContain(oldToken);
    // The CLI reads the same file, so it agrees with the supervisor.
    const r = await runAuto(ws, ["jobs"]);
    expect(r.code).toBe(0);
  }, 60_000);
});

describe("SIGTERM while the config loader is still running", () => {
  test("the loader subprocess does not outlive the supervisor", async () => {
    const ws = makeWorkspace(PORT);
    workspaces.push(ws);
    mkdirSync(ws.home, { recursive: true });
    const config = join(ws.home, "auto.config.ts");
    writeFileSync(config, "setInterval(() => {}, 1000);\nawait new Promise(() => {});\nexport default [];\n");
    const child = Bun.spawn([process.execPath, SUPERVISOR_MAIN], { cwd: ws.home, env: ws.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    stoppers.push(async () => { child.kill("SIGKILL"); });
    const loaders = () =>
      Bun.spawnSync(["ps", "-ax", "-o", "pid=,command="], { stdout: "pipe" }).stdout.toString()
        .split("\n").filter((l) => l.includes(config) && l.includes("config-loader"));
    await until(() => loaders().length > 0, 10_000, "the config loader to start");

    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(15_000)]);
    expect(child.exitCode).not.toBeNull();
    await until(() => loaders().length === 0, 3_000, "the loader to be gone");
  }, 60_000);
});

describe("AUTO_DATA_DIR pointing at a directory that is not Auto's", () => {
  test("its files and directories keep their permissions; Auto's own state is private", async () => {
    const ws = workspace(GOOD_CONFIG);
    const other = join(ws.home, "other-stuff");
    mkdirSync(join(other, "sub"), { recursive: true });
    const tool = join(other, "tool.sh");
    writeFileSync(tool, "#!/bin/sh\necho hi\n");
    chmodSync(tool, 0o755);
    chmodSync(join(other, "sub"), 0o755);
    chmodSync(other, 0o755);
    ws.env.AUTO_DATA_DIR = other;

    await start(ws);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(tool)).toBe(0o755);
    expect(mode(join(other, "sub"))).toBe(0o755);
    expect(mode(other)).toBe(0o755);
    // What Auto created there is private.
    expect(mode(join(other, "state"))).toBe(0o700);
    expect(mode(join(other, ".token"))).toBe(0o600);
    expect(mode(join(other, "automations.db"))).toBe(0o600);
  }, 60_000);
});

describe("a second supervisor on a port that is taken", () => {
  test("fails to bind and exits 70; the first keeps serving with its own token", async () => {
    const first = workspace(GOOD_CONFIG);
    await start(first);
    const token = readFileSync(join(first.data, ".token"), "utf8").trim();
    const asFirst = () => fetch(url("/api/jobs"), { headers: { authorization: `Bearer ${token}` } });
    expect((await asFirst()).status).toBe(200);

    const second = workspace(GOOD_CONFIG);
    const child = Bun.spawn([process.execPath, SUPERVISOR_MAIN], { cwd: second.home, env: second.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    stoppers.push(async () => { child.kill("SIGKILL"); });
    const code = await Promise.race([child.exited, Bun.sleep(30_000).then(() => "timeout" as const)]);
    expect(code).toBe(70);
    // Without reusePort: false the kernel would now send some requests to the newcomer (401 for this token).
    for (let i = 0; i < 6; i++) expect((await asFirst()).status).toBe(200);
  }, 90_000);
});

describe("SIGTERM while a condition checker is running", () => {
  test("the checker and its process group are gone when the supervisor exits", async () => {
    const ws = makeWorkspace(PORT);
    workspaces.push(ws);
    const pidFile = join(ws.home, "checker.pid");
    const config = `export default [{
      id: "cond", name: "cond", worker: "./jobs/hook.ts",
      triggers: [{ kind: "cron", id: "watch", schedule: "* * * * *", condition: { checker: "./jobs/check.ts", timeoutMs: 120000 } }],
    }];\n`;
    writeWorkspaceFiles(ws, config, {
      "hook.ts": `console.log("hook");\n`,
      "check.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nawait Bun.sleep(120000);\n`,
    });
    // Move this supervisor's clock so the next minute boundary is about two seconds away.
    const shift = (60_000 - 2_000 - (Date.now() % 60_000) + 60_000) % 60_000;
    const child = Bun.spawn([process.execPath, "--preload", resolve(ROOT, "test/fixtures/clock-shift-preload.ts"), SUPERVISOR_MAIN], {
      cwd: ws.home,
      env: { ...ws.env, TEST_CLOCK_SHIFT_MS: String(shift) },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    stoppers.push(async () => { child.kill("SIGKILL"); });

    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 40_000, "the checker to start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);

    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(20_000)]);
    expect(child.exitCode).not.toBeNull();
    await until(() => !alive(), 3_000, "the checker to be gone");
  }, 90_000);
});

describe("a restart in the minute a schedule is due", () => {
  test("the start-up run of that fire happens once, and a second start does not repeat it", async () => {
    const ws = makeWorkspace(PORT);
    workspaces.push(ws);
    writeWorkspaceFiles(
      ws,
      `export default [{ id: "tick", name: "tick", worker: "./jobs/tick.ts", triggers: [{ kind: "cron", id: "every", schedule: "* * * * *" }] }];\n`,
      { "tick.ts": `console.log("tick");\n` },
    );
    // A clock that reads 0.3 s past a minute boundary when the supervisor starts.
    const shift = (60_000 + 300 - (Date.now() % 60_000)) % 60_000;
    const launch = () => {
      const child = Bun.spawn([process.execPath, "--preload", resolve(ROOT, "test/fixtures/clock-shift-preload.ts"), SUPERVISOR_MAIN], {
        cwd: ws.home,
        env: { ...ws.env, TEST_CLOCK_SHIFT_MS: String(shift) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      stoppers.push(async () => { child.kill("SIGKILL"); });
      return child;
    };
    const cronFires = (): number[] => {
      if (!existsSync(join(ws.data, "automations.db"))) return [];
      const db = new Database(join(ws.data, "automations.db"), { readonly: true });
      try {
        // The file exists a moment before migrations create the table.
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()) return [];
        return db
          .query<{ f: number }, []>("SELECT json_extract(trigger_meta, '$.fire_at') AS f FROM runs WHERE trigger_kind = 'cron'")
          .all()
          .map((r) => r.f);
      } finally {
        db.close();
      }
    };

    const first = launch();
    await until(() => cronFires().length > 0, 20_000, "the start-up fire");
    const [fireAt] = cronFires();
    expect(fireAt! % 60_000).toBe(0);
    first.kill("SIGTERM");
    await Promise.race([first.exited, Bun.sleep(20_000)]);
    expect(first.exitCode).not.toBeNull();

    const second = launch();
    await until(async () => (await fetch(url("/healthz")).catch(() => null))?.status === 200, 20_000, "the second start");
    await Bun.sleep(2_500);
    expect(cronFires()).toEqual([fireAt!]);
    second.kill("SIGTERM");
    await Promise.race([second.exited, Bun.sleep(20_000)]);
  }, 90_000);
});
