import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The caller's environment minus every AUTO_* variable, so a developer's own settings cannot leak into a test. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("AUTO_")) env[k] = v;
  }
  env.AUTO_HOME = home;
  return env;
}

async function auto(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "cli/main.ts", ...args], {
    cwd: ROOT,
    env: cleanEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("workspace CLI", () => {
  test("source checkouts default to the standalone ~/.auto workspace", async () => {
    const noAuto = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("AUTO_")),
    ) as Record<string, string>;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      'const p = await import("./paths.ts"); console.log(JSON.stringify({workspace:p.WORKSPACE_ROOT,config:p.CONFIG_PATH,data:p.DATA_DIR}))',
    ], {
      cwd: ROOT,
      env: noAuto,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({
      workspace: join(process.env.HOME!, ".auto"),
      config: join(process.env.HOME!, ".auto", "auto.config.ts"),
      data: join(process.env.HOME!, ".auto", "data"),
    });
  });

  test("init creates an isolated starter workspace and config check accepts it", async () => {
    const home = mkdtempSync(join(tmpdir(), "auto-workspace-"));
    temporary.push(home);

    const initialized = await auto(home, ["init"]);
    expect(initialized.code).toBe(0);
    expect(existsSync(join(home, "auto.config.ts"))).toBe(true);
    expect(existsSync(join(home, "jobs", "hello-world.ts"))).toBe(true);
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("data/");

    const checked = await auto(home, ["config", "check"]);
    expect(checked.code).toBe(0);
    // A friendly summary, not the supervisor's internal `--check` line.
    expect(checked.stdout).toContain("config valid: 1 job, 1 trigger");
    expect(checked.stdout).not.toContain("migrations_pending");
  });

  test("create rejects unsafe names and creates a worker for a valid name", async () => {
    const home = mkdtempSync(join(tmpdir(), "auto-workspace-"));
    temporary.push(home);

    expect((await auto(home, ["create", "../oops"])).code).toBe(2);
    // No workspace yet: nothing is created and the user is told to run init.
    const early = await auto(home, ["create", "weekly-report"]);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("auto init");
    expect(existsSync(join(home, "jobs"))).toBe(false);
    expect((await auto(home, ["init"])).code).toBe(0);
    const created = await auto(home, ["create", "weekly-report"]);
    expect(created.code).toBe(0);
    expect(existsSync(join(home, "jobs", "weekly-report.ts"))).toBe(true);
  });

  test("config check maps validation failures to CLI exit 1 and reports missing workers", async () => {
    const home = mkdtempSync(join(tmpdir(), "auto-workspace-"));
    temporary.push(home);
    await auto(home, ["init"]);
    const configPath = join(home, "auto.config.ts");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace("./jobs/hello-world.ts", "./jobs/missing.ts"),
    );

    const checked = await auto(home, ["config", "check"]);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain("workspace files missing");
    expect(checked.stderr).toContain("./jobs/missing.ts");
  });

  test("AUTO_PORT changes the CLI's default supervisor URL", async () => {
    const home = mkdtempSync(join(tmpdir(), "auto-workspace-"));
    temporary.push(home);
    const child = Bun.spawn([process.execPath, "cli/main.ts", "runs"], {
      cwd: ROOT,
      env: { ...cleanEnv(home), AUTO_PORT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(3);
    expect(stderr).toContain("http://127.0.0.1:1");
  });
});
