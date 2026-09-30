import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEntryToConfigSource, addEntryToConfigFile, jobEntryText } from "../cli/config-file.ts";
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

const read = (ws: Workspace, ...p: string[]) => readFileSync(join(ws.home, ...p), "utf8");

describe("auto init", () => {
  test("creates a commented starter config, the worker, data dirs and .gitignore, then prints next steps", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["init"]);
    expect(r.code).toBe(0);
    const config = read(ws, "auto.config.ts");
    expect(config).toMatch(/^\/\/ Auto workspace configuration\./);
    expect(config).toContain("auto config check");
    expect(read(ws, "jobs", "hello-world.ts")).toContain("Hello from Auto");
    expect(read(ws, ".gitignore")).toContain("data/");
    expect(statSync(join(ws.data, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(ws.data).mode & 0o777).toBe(0o700);
    for (const step of ["auto config check", "auto install", "auto doctor", "auto ui"]) {
      expect(r.stderr).toContain(step);
    }
    // the starter is valid
    expect((await runAuto(ws, ["config", "check"])).code).toBe(0);
  });

  test("running it again changes nothing and says so", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const before = read(ws, "auto.config.ts");
    // an edit the user made must survive
    writeFileSync(join(ws.home, "auto.config.ts"), before + "\n// my note\n");
    const r = await runAuto(ws, ["init"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("nothing to create");
    expect(read(ws, "auto.config.ts")).toBe(before + "\n// my note\n");
  });

  test("a partly created workspace gets only the missing pieces", async () => {
    const ws = fresh();
    mkdirSync(join(ws.home, "jobs"), { recursive: true });
    writeFileSync(join(ws.home, "jobs", "hello-world.ts"), "console.log('mine');\n");
    writeFileSync(join(ws.home, ".gitignore"), "node_modules/\n");
    const r = await runAuto(ws, ["init"]);
    expect(r.code).toBe(0);
    // config was missing: created; the user's worker was kept
    expect(existsSync(join(ws.home, "auto.config.ts"))).toBe(true);
    expect(read(ws, "jobs", "hello-world.ts")).toBe("console.log('mine');\n");
    // the existing .gitignore keeps its line and gains the missing ones
    const ignore = read(ws, ".gitignore");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain("data/");
    expect(ignore).toContain(".auto-runtime/");
    expect(existsSync(join(ws.data, "state"))).toBe(true);
    // and running it once more leaves the .gitignore alone
    await runAuto(ws, ["init"]);
    expect(read(ws, ".gitignore")).toBe(ignore);
  });

  test("an existing config is never overwritten and gets no starter worker", async () => {
    const ws = fresh();
    mkdirSync(ws.home, { recursive: true });
    writeFileSync(join(ws.home, "auto.config.ts"), "export default [];\n");
    const r = await runAuto(ws, ["init"]);
    expect(r.code).toBe(0);
    expect(read(ws, "auto.config.ts")).toBe("export default [];\n");
    expect(existsSync(join(ws.home, "jobs", "hello-world.ts"))).toBe(false);
    expect(existsSync(join(ws.data, "state"))).toBe(true);
  });

  test("--json reports what was created", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["--json", "init"]);
    const out = JSON.parse(r.stdout);
    expect(out.workspace).toBe(ws.home);
    expect(out.created.some((p: string) => p.endsWith("auto.config.ts"))).toBe(true);
    const again = JSON.parse((await runAuto(ws, ["--json", "init"])).stdout);
    expect(again.created).toEqual([]);
  });
});

describe("auto config check before init", () => {
  test("tells the user to run `auto init` instead of a module-not-found error", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["config", "check"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("run `auto init`");
    expect(r.stderr).not.toMatch(/Cannot find module|ResolveMessage|error: Module not found/i);
    expect(r.stdout).toBe("");
  });

  test("--json says the config is missing", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["--json", "config", "check"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "config_missing" });
  });

  test("config edit before init also points at init", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["config", "edit"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("auto init");
  });
});

describe("auto create", () => {
  test("without --add it writes the worker and prints an entry with the right path and default cron", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const before = read(ws, "auto.config.ts");
    const r = await runAuto(ws, ["create", "weekly-report"]);
    expect(r.code).toBe(0);
    expect(read(ws, "jobs", "weekly-report.ts")).toContain("weekly-report completed");
    expect(r.stdout).toContain('worker: "./jobs/weekly-report.ts"');
    expect(r.stdout).toContain('schedule: "0 9 * * *"');
    expect(r.stderr).toContain(join(ws.home, "auto.config.ts"));
    expect(r.stderr).toContain("--add");
    expect(read(ws, "auto.config.ts")).toBe(before);
  });

  test("--cron sets the schedule in the printed entry", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const r = await runAuto(ws, ["create", "nightly", "--cron", "15 2 * * *"]);
    expect(r.stdout).toContain('schedule: "15 2 * * *"');
  });

  test("--add appends the job, validates it, and the config still checks out", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const r = await runAuto(ws, ["create", "weekly-report", "--add", "--cron", "0 8 * * 1"]);
    expect(r.code).toBe(0);
    const config = read(ws, "auto.config.ts");
    expect(config).toContain('name: "weekly-report"');
    expect(config).toContain('schedule: "0 8 * * 1"');
    expect(config).toContain("// Auto workspace configuration."); // header kept
    expect(config.trimEnd().endsWith("];")).toBe(true);
    const check = await runAuto(ws, ["config", "check"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("2 jobs");
    // no candidate file left behind
    expect(readdirSync(ws.home).filter((f) => f.includes("candidate"))).toEqual([]);
  });

  test("--add works on an empty array and on a last element without a trailing comma", async () => {
    const ws = fresh();
    mkdirSync(ws.home, { recursive: true });
    writeFileSync(join(ws.home, "auto.config.ts"), "export default [];\n");
    expect((await runAuto(ws, ["create", "first", "--add"])).code).toBe(0);
    expect((await runAuto(ws, ["check-nothing"])).code).toBe(2);
    expect((await runAuto(ws, ["config", "check"])).stdout).toContain("1 job,");

    writeFileSync(
      join(ws.home, "auto.config.ts"),
      read(ws, "auto.config.ts").replace(/,\n\];\n$/, "\n];\n"),
    );
    expect((await runAuto(ws, ["create", "second", "--add"])).code).toBe(0);
    expect((await runAuto(ws, ["config", "check"])).stdout).toContain("2 jobs");
  });

  test("--add refuses a name that is already in the config, and changes nothing", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const before = read(ws, "auto.config.ts");
    const r = await runAuto(ws, ["create", "hello-world", "--add"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already in");
    expect(read(ws, "auto.config.ts")).toBe(before);
    // also without --add
    expect((await runAuto(ws, ["create", "hello-world"])).code).toBe(1);
  });

  test("a config that is not the standard array shape gets the snippet and the reason, and stays untouched", async () => {
    const ws = fresh();
    mkdirSync(join(ws.home, "jobs"), { recursive: true });
    const source = "const jobs = [];\nexport default jobs;\n";
    writeFileSync(join(ws.home, "auto.config.ts"), source);
    const r = await runAuto(ws, ["create", "nightly", "--add"]);
    // --add was asked for and not done: a script must see a failure, even though the entry is printed.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not added");
    expect(r.stderr).toContain("was kept");
    expect(r.stderr).toContain("standard `export default [ ... ];` shape");
    expect(r.stdout).toContain('name: "nightly"');
    expect(read(ws, "auto.config.ts")).toBe(source);
    expect(existsSync(join(ws.home, "jobs", "nightly.ts"))).toBe(true);
  });

  test("--add against a config that does not validate leaves the config alone and removes the worker it just made", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const broken = read(ws, "auto.config.ts").replace("./jobs/hello-world.ts", "./jobs/missing.ts");
    writeFileSync(join(ws.home, "auto.config.ts"), broken);
    const r = await runAuto(ws, ["create", "nightly", "--add"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not added");
    expect(r.stderr).toContain("./jobs/missing.ts");
    expect(read(ws, "auto.config.ts")).toBe(broken);
    expect(existsSync(join(ws.home, "jobs", "nightly.ts"))).toBe(false);
    expect(readdirSync(ws.home).filter((f) => f.includes("candidate"))).toEqual([]);
  });

  test("--add without a config says to run `auto init` and creates nothing", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["create", "nightly", "--add"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("auto init");
    expect(existsSync(join(ws.home, "jobs", "nightly.ts"))).toBe(false);
  });

  test("bad names and bad cron are usage errors that create nothing", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    for (const name of ["../oops", "Upper", "a b", "-lead", "x".repeat(65)]) {
      expect((await runAuto(ws, ["create", name])).code).toBe(2);
    }
    const r = await runAuto(ws, ["create", "fine", "--cron", "every day"]);
    expect(r.code).toBe(2);
    expect(existsSync(join(ws.home, "jobs", "fine.ts"))).toBe(false);
  });

  test("an existing worker file is not overwritten; --add can still register it", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    writeFileSync(join(ws.home, "jobs", "mine.ts"), "console.log('keep me');\n");
    expect((await runAuto(ws, ["create", "mine"])).code).toBe(1);
    expect(read(ws, "jobs", "mine.ts")).toBe("console.log('keep me');\n");
    expect((await runAuto(ws, ["create", "mine", "--add"])).code).toBe(0);
    expect(read(ws, "jobs", "mine.ts")).toBe("console.log('keep me');\n");
    expect(read(ws, "auto.config.ts")).toContain('name: "mine"');
  });

  test("--json describes the outcome", async () => {
    const ws = fresh();
    await runAuto(ws, ["init"]);
    const r = await runAuto(ws, ["--json", "create", "j1", "--add"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: "j1", added: true, cron: "0 9 * * *" });
  });
});

describe("adding an entry to the config file", () => {
  const entry = jobEntryText("new-job", "0 9 * * *");

  test("appendEntryToConfigSource handles the standard shapes", () => {
    expect(appendEntryToConfigSource("export default [];\n", entry)).toMatchObject({ ok: true });
    const withOne = "export default [\n  { a: 1 },\n];\n";
    const r = appendEntryToConfigSource(withOne, entry);
    expect(r.ok && r.source).toContain("{ a: 1 },\n  {\n    id: \"new-job\"");
    const noComma = appendEntryToConfigSource("export default [\n  { a: 1 }\n];", entry);
    expect(noComma.ok && noComma.source).toContain("{ a: 1 },\n");
    expect(appendEntryToConfigSource("export default foo();\n", entry)).toMatchObject({ ok: false });
    expect(appendEntryToConfigSource("export default [1]; // hi\n", entry)).toMatchObject({ ok: false });
    expect(appendEntryToConfigSource("export default [];\nexport default [];\n", entry)).toMatchObject({ ok: false });
  });

  test("a failed validation rolls back: the config is byte-for-byte unchanged and no candidate is left", async () => {
    const ws = fresh();
    mkdirSync(ws.home, { recursive: true });
    const path = join(ws.home, "auto.config.ts");
    const original = "export default [\n  // keep me\n];\n";
    writeFileSync(path, original, { mode: 0o640 });
    let candidateSeen = "";
    const result = await addEntryToConfigFile(entry, {
      configPath: path,
      validate: async (candidate) => {
        candidateSeen = readFileSync(candidate, "utf8");
        return { ok: false, error: "job \"new-job\": something is wrong" };
      },
    });
    expect(result).toEqual({ ok: false, kind: "invalid", reason: 'job "new-job": something is wrong' });
    expect(candidateSeen).toContain('name: "new-job"'); // it did validate the modified text
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(ws.home).sort()).toEqual(["auto.config.ts"]);
  });

  test("a passing validation replaces the file atomically and keeps its mode", async () => {
    const ws = fresh();
    mkdirSync(ws.home, { recursive: true });
    const path = join(ws.home, "auto.config.ts");
    writeFileSync(path, "export default [];\n", { mode: 0o640 });
    const result = await addEntryToConfigFile(entry, { configPath: path, validate: async () => ({ ok: true }) });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toContain('name: "new-job"');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(ws.home)).toEqual(["auto.config.ts"]);
    rmSync(path);
  });
});
