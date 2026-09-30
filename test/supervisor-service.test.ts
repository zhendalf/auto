import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  optionalEnvFrom,
  OPTIONAL_ENV_VARS,
  renderServiceEntry,
  runningSupervisorPid,
  verifyServiceEntry,
  waitForHealthz,
} from "../supervisor/bun-cron-service.ts";
import { isOnPath, renderCmdShim, renderShim } from "../cli/install-shim.ts";
import {
  openSupervisorLog,
  installLogTee,
  rotateLogIfLarge,
  SUPERVISOR_LOG_MAX_BYTES,
} from "../supervisor/log-file.ts";
import { readTail, stopSupervisorProcess, tailLog } from "../cli/commands/svc.ts";
import { isPidAlive } from "../supervisor/process-identity.ts";

let tmp: string;
let cleanup: Array<() => void> = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "supervisor-service-"));
  cleanup = [];
});
afterEach(() => {
  for (const fn of cleanup.reverse()) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

const baseEntry = {
  workspaceRoot: "/w/.auto",
  dataDir: "/w/.auto/data",
  port: 7788,
  supervisorEntry: "/src/auto/supervisor/main.ts",
};

describe("watchdog entry", () => {
  test("bakes the base settings and only the optional variables that are set", () => {
    const plain = renderServiceEntry(baseEntry);
    expect(plain).toContain('process.env.AUTO_HOME = "/w/.auto";');
    expect(plain).toContain('process.env.AUTO_DATA_DIR = "/w/.auto/data";');
    expect(plain).toContain('process.env.AUTO_PORT = "7788";');
    expect(plain).not.toContain("AUTO_CONFIG");
    for (const name of OPTIONAL_ENV_VARS) expect(plain).not.toContain(name);
    expect(plain).toContain('await import("/src/auto/supervisor/main.ts")');

    const full = renderServiceEntry({
      ...baseEntry,
      configPath: "/w/.auto/alt.config.ts",
      optionalEnv: { AUTO_ALLOWED_HOSTS: "auto.example:7788", AUTO_RETENTION_DAYS: "30", AUTO_RETENTION_MIN_RUNS: "50" },
    });
    expect(full).toContain('process.env.AUTO_CONFIG = "/w/.auto/alt.config.ts";');
    expect(full).toContain('process.env.AUTO_ALLOWED_HOSTS = "auto.example:7788";');
    expect(full).toContain('process.env.AUTO_RETENTION_DAYS = "30";');
    expect(full).toContain('process.env.AUTO_RETENTION_MIN_RUNS = "50";');
  });

  test("bakes the install-time PATH so workers see the same tools after a watchdog restart", () => {
    const withPath = renderServiceEntry({ ...baseEntry, path: "/opt/homebrew/bin:/usr/bin:/bin" });
    expect(withPath).toContain('process.env.PATH = "/opt/homebrew/bin:/usr/bin:/bin";');
    // Set before the supervisor is imported, so its child environment picks it up.
    expect(withPath.indexOf("process.env.PATH")).toBeLessThan(withPath.indexOf("await import"));
    expect(renderServiceEntry(baseEntry)).not.toContain("process.env.PATH");
    expect(renderServiceEntry({ ...baseEntry, path: null })).not.toContain("process.env.PATH");
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(withPath)).not.toThrow();
  });

  test("the CLI shim never bakes PATH (only the watchdog entry does)", () => {
    expect(OPTIONAL_ENV_VARS as readonly string[]).not.toContain("PATH");
  });

  test("values are emitted as JSON string literals (no injection through env values)", () => {
    const src = renderServiceEntry({ ...baseEntry, optionalEnv: { AUTO_ALLOWED_HOSTS: 'a"; process.exit(1); //' } });
    expect(src).toContain(JSON.stringify('a"; process.exit(1); //'));
    // The entry stays valid JavaScript.
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(src)).not.toThrow();
  });

  test("optionalEnvFrom picks only set, non-empty variables", () => {
    expect(
      optionalEnvFrom({ AUTO_ALLOWED_HOSTS: "h:1", AUTO_RETENTION_DAYS: "", OTHER: "x" } as NodeJS.ProcessEnv),
    ).toEqual({ AUTO_ALLOWED_HOSTS: "h:1" });
    expect(optionalEnvFrom({} as NodeJS.ProcessEnv)).toEqual({});
  });

  test("verifyServiceEntry detects a missing entry, a missing baked supervisor and a healthy entry", () => {
    const entryPath = join(tmp, ".auto-runtime", "supervisor.ts");
    expect(verifyServiceEntry(entryPath).ok).toBe(false);

    mkdirSync(dirname(entryPath), { recursive: true });
    const supervisor = join(tmp, "src", "supervisor", "main.ts");
    writeFileSync(entryPath, renderServiceEntry({ ...baseEntry, supervisorEntry: supervisor }));
    const missing = verifyServiceEntry(entryPath);
    expect(missing.ok).toBe(false);
    expect(missing.bakedSupervisorPath).toBe(supervisor);
    expect(missing.problem).toContain("missing supervisor");

    mkdirSync(dirname(supervisor), { recursive: true });
    writeFileSync(supervisor, "");
    const ok = verifyServiceEntry(entryPath);
    expect(ok.ok).toBe(true);
    expect(ok.problem).toBeNull();

    writeFileSync(entryPath, "export default {};\n");
    expect(verifyServiceEntry(entryPath).ok).toBe(false);
  });
});

describe("CLI shim", () => {
  const input = {
    workspaceRoot: "/w/it's here/.auto",
    dataDir: "/w/.auto/data",
    port: 7788,
    bunPath: "/opt/bun",
    cliMain: "/src/auto/cli/main.ts",
  };

  test("posix shim exports settings, quotes safely and includes optional variables", () => {
    const sh = renderShim({ ...input, optionalEnv: { AUTO_ALLOWED_HOSTS: "h:1", AUTO_RETENTION_DAYS: "9" } });
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain(`export AUTO_HOME='/w/it'"'"'s here/.auto'`);
    expect(sh).toContain("export AUTO_ALLOWED_HOSTS='h:1'");
    expect(sh).toContain("export AUTO_RETENTION_DAYS='9'");
    expect(sh).not.toContain("AUTO_CONFIG");
    expect(sh).toContain(`exec '/opt/bun' '/src/auto/cli/main.ts' "$@"`);
    expect(renderShim({ ...input, configPath: "/c.ts" })).toContain("export AUTO_CONFIG='/c.ts'");
  });

  test("the shim is valid sh and runs with the baked environment", async () => {
    const script = join(tmp, "printenv.ts");
    writeFileSync(script, 'console.log(process.env.AUTO_PORT, process.env.AUTO_ALLOWED_HOSTS ?? "-", process.argv.slice(2).join(","));\n');
    const shim = join(tmp, "auto");
    writeFileSync(
      shim,
      renderShim({ ...input, port: 4321, bunPath: process.execPath, cliMain: script, optionalEnv: { AUTO_ALLOWED_HOSTS: "h:1" } }),
    );
    chmodSync(shim, 0o755);
    const proc = Bun.spawn([shim, "a", "b"], { stdout: "pipe", stdin: "ignore", env: { ...process.env, AUTO_PORT: "1" } });
    expect((await new Response(proc.stdout).text()).trim()).toBe("4321 h:1 a,b");
  });

  test("windows shim doubles percent signs and forwards arguments", () => {
    const cmd = renderCmdShim({ ...input, optionalEnv: { AUTO_ALLOWED_HOSTS: "100%" } });
    expect(cmd.startsWith("@echo off\r\n")).toBe(true);
    expect(cmd).toContain('set "AUTO_ALLOWED_HOSTS=100%%"');
    expect(cmd).toContain('"/opt/bun" "/src/auto/cli/main.ts" %*');
  });

  test("isOnPath", () => {
    expect(isOnPath("/a/b", ["/x", "/a/b", "/y"].join(delimiter))).toBe(true);
    expect(isOnPath("/a/b", ["/x", "", "/y"].join(delimiter))).toBe(false);
    expect(isOnPath("/a/b", "")).toBe(false);
  });
});

describe("supervisor.log", () => {
  test("opens 0600 and rotates once it is over the limit", () => {
    const path = join(tmp, "state", "supervisor.log");
    const fd = openSupervisorLog(path, 100);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    appendFileSync(path, "x".repeat(200));
    require("node:fs").closeSync(fd);
    expect(rotateLogIfLarge(path, 100)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(path)).toBe(false);
    const fd2 = openSupervisorLog(path, 100);
    require("node:fs").closeSync(fd2);
    expect(statSync(path).size).toBe(0);
    expect(rotateLogIfLarge(path, 100)).toBe(false);
    expect(SUPERVISOR_LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  test("the tee mirrors stdout and stderr into the file and restores the streams", () => {
    const path = join(tmp, "state", "tee.log");
    const forwarded: string[] = [];
    const fake = () => ({ write: (c: string) => (forwarded.push(c), true) }) as unknown as NodeJS.WriteStream;
    const out = fake();
    const err = fake();
    const outBefore = out.write;
    const restore = installLogTee(path, 1024 * 1024, [out, err]);
    out.write("hello out\n");
    err.write("hello err\n");
    restore();
    expect(out.write).toBe(outBefore);
    expect(forwarded).toEqual(["hello out\n", "hello err\n"]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("hello out\n");
    expect(text).toContain("hello err\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the tee rotates while running", () => {
    const path = join(tmp, "state", "tee2.log");
    const sink = { write: () => true } as unknown as NodeJS.WriteStream;
    const restore = installLogTee(path, 300, [sink]);
    for (let i = 0; i < 30; i++) sink.write(`line ${i} ${"y".repeat(30)}\n` as never);
    restore();
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(600);
  });
});

describe("auto svc tail", () => {
  test("readTail returns the last lines, and nothing for a missing file", () => {
    const path = join(tmp, "l.log");
    writeFileSync(path, Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n");
    expect(readTail(path, 3).text).toBe("l7\nl8\nl9\n");
    expect(readTail(join(tmp, "missing.log")).text).toBe("");
  });

  test("tailLog prints the tail then follows appends, and survives truncation", async () => {
    const path = join(tmp, "f.log");
    writeFileSync(path, "one\ntwo\n");
    const chunks: string[] = [];
    const ctl = new AbortController();
    const done = tailLog({ path, lines: 10, follow: true, out: (c) => chunks.push(c), signal: ctl.signal });
    await Bun.sleep(500);
    appendFileSync(path, "three\n");
    await Bun.sleep(600);
    writeFileSync(path, "four\n"); // truncated / rotated
    await Bun.sleep(600);
    ctl.abort();
    await done;
    expect(chunks.join("")).toBe("one\ntwo\nthree\nfour\n");
  }, 10_000);

  test("tailLog without follow just prints and returns", async () => {
    const path = join(tmp, "g.log");
    writeFileSync(path, "a\nb\n");
    const chunks: string[] = [];
    await tailLog({ path, follow: false, out: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("a\nb\n");
  });
});

describe("waitForHealthz", () => {
  test("returns once the server answers, including 503 (degraded)", async () => {
    let status = 503;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x", { status }) });
    cleanup.push(() => server.stop(true));
    const res = await waitForHealthz(`http://127.0.0.1:${server.port}`, { timeoutMs: 3000, intervalMs: 20 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(503);
    status = 200;
    const res2 = await waitForHealthz(`http://127.0.0.1:${server.port}`, { timeoutMs: 3000, intervalMs: 20 });
    expect(res2.ok && res2.status).toBe(200);
  });

  test("times out when nothing listens, and gives up early when the launched process is gone", async () => {
    const dead = "http://127.0.0.1:1"; // nothing listens on port 1
    const t = await waitForHealthz(dead, { timeoutMs: 300, intervalMs: 20 });
    expect(t).toMatchObject({ ok: false, reason: "timeout" });
    const t0 = Date.now();
    const e = await waitForHealthz(dead, { timeoutMs: 10_000, intervalMs: 20, stillStarting: () => false });
    expect(e).toMatchObject({ ok: false, reason: "exited" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("auto svc stop", () => {
  function fakeSupervisor(behaviour: "exit-after-500ms" | "ignore-sigterm") {
    const dir = join(tmp, behaviour, "supervisor");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "main.ts");
    writeFileSync(
      script,
      behaviour === "exit-after-500ms"
        ? `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 500)); console.log("ready"); setInterval(() => {}, 1000);\n`
        : `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);\n`,
    );
    const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    cleanup.push(() => child.kill("SIGKILL"));
    return child;
  }

  async function ready(child: ReturnType<typeof fakeSupervisor>): Promise<void> {
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    reader.releaseLock();
  }

  const writeLock = (pid: number) => {
    const lock = join(tmp, "supervisor.lock");
    writeFileSync(lock, JSON.stringify({ pid, startedAt: Date.now(), entry: "" }), { mode: 0o600 });
    return lock;
  };

  test("waits until the supervisor has actually exited", async () => {
    const child = fakeSupervisor("exit-after-500ms");
    await ready(child);
    const lock = writeLock(child.pid);
    const t0 = Date.now();
    const code = await stopSupervisorProcess(lock, 10_000);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    // stopSupervisorProcess returns once the OS pid is gone; Bun fills in
    // exitCode when its event loop has processed the exit, which can be a tick later.
    await child.exited;
    expect(child.exitCode).not.toBeNull();
  }, 20_000);

  test("reports failure (does not claim success) when the supervisor will not exit", async () => {
    const child = fakeSupervisor("ignore-sigterm");
    await ready(child);
    const lock = writeLock(child.pid);
    const code = await stopSupervisorProcess(lock, 600);
    expect(code).toBe(1);
    expect(isPidAlive(child.pid)).toBe(true);
  }, 20_000);

  test("never signals a pid that is not a supervisor", async () => {
    const stranger = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => stranger.kill("SIGKILL"));
    const lock = writeLock(stranger.pid);
    expect(runningSupervisorPid(lock)).toBeNull();
    expect(await stopSupervisorProcess(lock, 500)).toBe(0);
    expect(isPidAlive(stranger.pid)).toBe(true);
  });
});
