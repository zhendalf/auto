import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, openSync, ftruncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorkspace, runAuto, type Workspace } from "./cli-harness.ts";

const made: Workspace[] = [];
function fresh(): Workspace {
  const ws = makeWorkspace(1);
  made.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of made.splice(0)) ws.cleanup();
});

type Check = { name: string; status: string; message: string; remedy?: string; data?: Record<string, unknown> };

async function doctorJson(ws: Workspace): Promise<{ code: number; ok: boolean; checks: Check[]; stdout: string }> {
  const r = await runAuto(ws, ["--json", "doctor"]);
  const parsed = JSON.parse(r.stdout) as { ok: boolean; checks: Check[] };
  return { code: r.code, ...parsed, stdout: r.stdout };
}

const byName = (checks: Check[], name: string): Check => {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}: ${checks.map((x) => x.name).join(", ")}`);
  return c;
};

describe("auto doctor", () => {
  test("--json has a stable shape and stdout is only JSON", async () => {
    const ws = fresh();
    const d = await doctorJson(ws);
    expect(d.stdout.trim().split("\n")).toHaveLength(1);
    expect(typeof d.ok).toBe("boolean");
    expect(d.checks.length).toBeGreaterThanOrEqual(9);
    for (const c of d.checks) {
      expect(typeof c.name).toBe("string");
      expect(["OK", "WARN", "FAIL", "INFO"]).toContain(c.status);
      expect(typeof c.message).toBe("string");
    }
    const names = d.checks.map((c) => c.name);
    for (const expected of [
      "Bun version",
      "Workspace",
      "Watchdog registered",
      "Watchdog entry",
      "Supervisor reachable",
      "Token file",
      "Config valid",
      "Database",
      "`auto` on PATH",
      "Disk usage",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("on a machine with nothing set up: exit 1, and every FAIL says what to run", async () => {
    const ws = fresh();
    const d = await doctorJson(ws);
    expect(d.code).toBe(1);
    expect(d.ok).toBe(false);
    const failing = d.checks.filter((c) => c.status === "FAIL");
    expect(failing.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Workspace", "Watchdog registered", "Supervisor reachable", "Token file", "Database"]),
    );
    for (const c of failing) expect(c.remedy?.length ?? 0).toBeGreaterThan(5);
    expect(byName(d.checks, "Workspace").remedy).toContain("auto init");
    expect(byName(d.checks, "Watchdog registered").remedy).toContain("auto install");
    expect(byName(d.checks, "Supervisor reachable").remedy).toContain("auto install");
    expect(byName(d.checks, "Bun version").status).toBe("OK");
  });

  test("the text report prints a one-line fix under each failing check", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["doctor"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\]\s+Workspace: .*\n\s+fix: run `auto init`/);
    expect(r.stdout).toContain("[OK]");
    expect(r.stdout).toContain("[INFO]");
    expect(r.stderr).toContain("check");
  });

  test("a valid workspace is checked offline when no supervisor is running", async () => {
    const ws = fresh();
    expect((await runAuto(ws, ["init"])).code).toBe(0);
    const d = await doctorJson(ws);
    expect(byName(d.checks, "Workspace").status).toBe("OK");
    const config = byName(d.checks, "Config valid");
    expect(config.status).toBe("OK");
    expect(config.message).toContain("1 job");
    expect(config.message).toContain("offline");
  });

  test("an invalid config is a FAIL with a fix", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    writeFileSync(join(ws.home, "auto.config.ts"), 'export default [{ id: "Bad ID" }];\n');
    const d = await doctorJson(ws);
    const config = byName(d.checks, "Config valid");
    expect(config.status).toBe("FAIL");
    expect(config.remedy).toContain("auto config check");
  });

  test("the disk usage line is INFO with sizes, and WARN above 1 GB", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    mkdirSync(join(ws.data, "runs", "2026"), { recursive: true });
    writeFileSync(join(ws.data, "runs", "2026", "a.log"), "hello");
    let disk = byName((await doctorJson(ws)).checks, "Disk usage");
    expect(disk.status).toBe("INFO");
    expect(disk.message).toMatch(/database .*run logs .* in 1 file/);
    expect(disk.data).toMatchObject({ runs_files: 1, runs_bytes: 5 });

    // A sparse 1.2 GB file counts by size but uses no disk.
    const big = join(ws.data, "runs", "2026", "big.log");
    const fd = openSync(big, "w");
    ftruncateSync(fd, Math.floor(1.2 * 1024 ** 3));
    closeSync(fd);
    disk = byName((await doctorJson(ws)).checks, "Disk usage");
    expect(disk.status).toBe("WARN");
    expect(disk.remedy).toBeTruthy();
    // a WARN does not fail doctor on its own
    expect(disk.data?.total_bytes as number).toBeGreaterThan(1024 ** 3);
  });

  test("a token file readable by others is a WARN with the chmod fix", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const token = join(ws.data, ".token");
    writeFileSync(token, "abc");
    chmodSync(token, 0o644);
    const c = byName((await doctorJson(ws)).checks, "Token file");
    expect(c.status).toBe("WARN");
    expect(c.remedy).toContain("chmod 600");
    chmodSync(token, 0o600);
    expect(byName((await doctorJson(ws)).checks, "Token file").status).toBe("OK");
  });

  test("a corrupt database is a FAIL", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    writeFileSync(join(ws.data, "automations.db"), "this is not a database, just text padding ".repeat(100));
    const c = byName((await doctorJson(ws)).checks, "Database");
    expect(c.status).toBe("FAIL");
    expect(c.remedy?.length).toBeGreaterThan(5);
  });

  test("a watchdog entry that points at a missing supervisor is a FAIL that says to reinstall", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const runtime = join(ws.home, ".auto-runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, "supervisor.ts"),
      'const supervisor = await import("/nonexistent/checkout/supervisor/main.ts");\nexport default supervisor.default;\n',
    );
    const c = byName((await doctorJson(ws)).checks, "Watchdog entry");
    expect(c.status).toBe("FAIL");
    expect(c.message).toContain("/nonexistent/checkout/supervisor/main.ts");
    expect(c.remedy).toContain("auto install");
  });
});
