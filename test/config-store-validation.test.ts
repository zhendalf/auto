import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  ConfigValidationError,
  MAX_TIMER_MS,
  computeConfigWarnings,
  findMissingWorkspaceFiles,
  loadConfigOnce,
} from "../supervisor/config.ts";
import { ConfigValidationError as FromRegistry } from "../supervisor/registry.ts";

// Everything that makes a config unusable is rejected by the config
// validation itself, so hot reload and `--check` agree.

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a",
    name: "a",
    worker: "./jobs/a.ts",
    triggers: [{ kind: "cron", id: "t", schedule: "0 3 * * *" }],
    ...overrides,
  };
}

function problems(list: unknown[]): string[] {
  const parsed = ConfigSchema.safeParse(list);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("job names", () => {
  test.each([
    "a",
    "linear-sdk-cli-repo-sync",
    "molly-family-calendar-watch",
    "Nightly backup",
    "job_1.v2",
    "x".repeat(64),
    "Обновление",
  ])("accepts %p", (name) => {
    expect(problems([job({ name })])).toEqual([]);
  });

  test.each([
    ["empty", ""],
    ["colon", "a:b"],
    ["slash", "a/b"],
    ["backslash", "a\\b"],
    ["newline", "a\nb"],
    ["tab", "a\tb"],
    ["NUL", "a\u0000b"],
    ["leading space", " a"],
    ["trailing space", "a "],
    ["only dots", ".."],
    ["single dot", "."],
    ["question mark", "what?"],
    ["percent", "100%"],
    ["65 chars", "x".repeat(65)],
  ])("rejects %s", (_label, name) => {
    const found = problems([job({ name })]);
    expect(found.some((p) => p.startsWith("0.name:"))).toBe(true);
  });

  test("the message says what is allowed", () => {
    expect(problems([job({ name: "a:b" })])[0]).toContain('letters, digits, space, ".", "_" or "-"');
  });
});

describe("cron syntax", () => {
  test("a bad schedule is a config error at the trigger's schedule", () => {
    const found = problems([job({ triggers: [{ kind: "cron", id: "t", schedule: "61 * * * *" }] })]);
    expect(found[0]).toStartWith("0.triggers.0.schedule:");
    expect(found[0]).toContain("invalid cron pattern");
  });

  test("wrong field count and never-firing schedules", () => {
    expect(problems([job({ triggers: [{ kind: "cron", id: "t", schedule: "* * * *" }] })]).length).toBe(1);
    expect(problems([job({ triggers: [{ kind: "cron", id: "t", schedule: "0 0 31 2 *" }] })]).length).toBe(1);
  });

  test("macros and lists are fine", () => {
    expect(problems([job({ triggers: [{ kind: "cron", id: "t", schedule: "@daily" }] })])).toEqual([]);
    expect(problems([job({ triggers: [{ kind: "cron", id: "t", schedule: "*/5 9-17 * * MON-FRI" }] })])).toEqual([]);
  });
});

describe("limits", () => {
  test("timeoutMs and killGraceMs cap at the setTimeout limit", () => {
    expect(problems([job({ timeoutMs: MAX_TIMER_MS, killGraceMs: MAX_TIMER_MS })])).toEqual([]);
    expect(problems([job({ timeoutMs: MAX_TIMER_MS + 1 })]).some((p) => p.startsWith("0.timeoutMs"))).toBe(true);
    expect(problems([job({ killGraceMs: MAX_TIMER_MS + 1 })]).some((p) => p.startsWith("0.killGraceMs"))).toBe(true);
  });

  test("queueDepth caps at 1000", () => {
    expect(problems([job({ queueDepth: 1000 })])).toEqual([]);
    expect(problems([job({ queueDepth: 1001 })]).some((p) => p.startsWith("0.queueDepth"))).toBe(true);
    expect(problems([job({ queueDepth: 0 })]).length).toBe(1);
  });
});

describe("workspace files", () => {
  let ws: string;
  let configPath: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "config-validation-"));
    mkdirSync(join(ws, "jobs"));
    configPath = join(ws, "auto.config.ts");
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const write = (jobs: unknown[]) => writeFileSync(configPath, `export default ${JSON.stringify(jobs)};\n`);
  const load = () => loadConfigOnce({ configPath, workspaceRoot: ws });

  test("a missing worker is rejected with the job and field named", async () => {
    write([job()]);
    const err = await load().catch((e) => e);
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err.failures[0]).toContain('job "a", worker');
    expect(err.failures[0]).toContain("./jobs/a.ts does not exist");
    expect(err.message).toStartWith("workspace files missing:");
  }, 15_000);

  test("a directory is not a worker", async () => {
    mkdirSync(join(ws, "jobs", "a.ts"));
    write([job()]);
    const err = await load().catch((e) => e);
    expect(err.failures[0]).toContain("is not a file");
  }, 15_000);

  test("a missing condition checker names the trigger", async () => {
    writeFileSync(join(ws, "jobs", "a.ts"), "");
    write([
      job({
        triggers: [{ kind: "cron", id: "t", schedule: "0 3 * * *", condition: { checker: "./jobs/check.ts" } }],
      }),
    ]);
    const err = await load().catch((e) => e);
    expect(err.failures).toEqual([expect.stringContaining('job "a", trigger "t", condition.checker')]);
  }, 15_000);

  test("every problem is listed, and schema errors name the job, trigger and field", async () => {
    write([
      job({ name: "bad:name", worker: "../escape.ts" }),
      job({ id: "b", name: "b", triggers: [{ kind: "cron", id: "daily", schedule: "x" }] }),
    ]);
    const err = await load().catch((e) => e);
    const text = (err.failures as string[]).join("\n");
    expect(text).toContain('job "bad:name", name');
    expect(text).toContain('job "bad:name", worker');
    expect(text).toContain('job "b", trigger "daily", schedule');
  }, 15_000);

  test("checkFiles: false skips only the existence check", async () => {
    write([job()]);
    expect((await loadConfigOnce({ configPath, workspaceRoot: ws, checkFiles: false })).config).toHaveLength(1);
  }, 15_000);

  test("findMissingWorkspaceFiles reports each missing file once", () => {
    const parsed = ConfigSchema.parse([job()]);
    expect(findMissingWorkspaceFiles(parsed, ws)).toHaveLength(1);
    writeFileSync(join(ws, "jobs", "a.ts"), "");
    expect(findMissingWorkspaceFiles(parsed, ws)).toEqual([]);
  });

  describe("disabled jobs whose files are gone", () => {
    test("do not make the config invalid, so the healthy jobs still start", async () => {
      writeFileSync(join(ws, "jobs", "a.ts"), "");
      write([job(), job({ id: "old", name: "old", worker: "./jobs/deleted.ts", enabled: false })]);
      const { config } = await loadConfigOnce({ configPath, workspaceRoot: ws });
      expect(config.map((j) => j.name)).toEqual(["a", "old"]);
    }, 15_000);

    test("the same missing worker on an ENABLED job still rejects the config", async () => {
      writeFileSync(join(ws, "jobs", "a.ts"), "");
      write([job(), job({ id: "old", name: "old", worker: "./jobs/deleted.ts" })]);
      await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/job "old", worker: \.\/jobs\/deleted\.ts does not exist/);
    }, 15_000);

    test("findMissingWorkspaceFiles skips them and computeConfigWarnings reports them once per job", () => {
      const parsed = ConfigSchema.parse([
        job({ enabled: false, triggers: [{ kind: "cron", id: "t", schedule: "0 3 * * *", condition: { checker: "./jobs/a/check.ts" } }] }),
      ]);
      expect(findMissingWorkspaceFiles(parsed, ws)).toEqual([]);
      const warnings = computeConfigWarnings(parsed, undefined, ws);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ code: "missing_file", job: "a" });
      expect(warnings[0]!.message).toContain("./jobs/a.ts does not exist");
      expect(warnings[0]!.message).toContain("./jobs/a/check.ts does not exist");
      // Without a workspace root nothing is probed; once the files exist the warning goes.
      expect(computeConfigWarnings(parsed)).toEqual([]);
      mkdirSync(join(ws, "jobs", "a"), { recursive: true });
      writeFileSync(join(ws, "jobs", "a.ts"), "");
      writeFileSync(join(ws, "jobs", "a", "check.ts"), "");
      expect(computeConfigWarnings(parsed, undefined, ws)).toEqual([]);
    });
  });
});

describe("compatibility", () => {
  test("ConfigValidationError is the same class from registry.ts", () => {
    expect(FromRegistry).toBe(ConfigValidationError);
    const e = new ConfigValidationError(["x", "y"]);
    expect(e.message).toBe("x; y");
    expect(e.failures).toEqual(["x", "y"]);
  });

  test("warnings need a secret probe; without one there are none", () => {
    const parsed = ConfigSchema.parse([
      job({
        triggers: [
          {
            kind: "webhook",
            id: "in",
            path: "p",
            auth: { profile: "hmac-sha256", secretRef: "s", signatureHeader: "X-Sig" },
          },
        ],
      }),
    ]);
    expect(computeConfigWarnings(parsed)).toEqual([]);
    expect(computeConfigWarnings(null, () => false)).toEqual([]);
    expect(computeConfigWarnings(parsed, () => false)).toHaveLength(1);
    expect(computeConfigWarnings(parsed, () => true)).toEqual([]);
    // A probe that throws counts as "not present".
    expect(computeConfigWarnings(parsed, () => { throw new Error("x"); })).toHaveLength(1);
  });
});
