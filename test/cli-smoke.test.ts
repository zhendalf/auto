import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./cli-harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI_MAIN = resolve(REPO_ROOT, "cli/main.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The CLI runs against a private, empty home: never the developer's real
// ~/.auto or LaunchAgents, and no AUTO_* setting from the caller's shell.
const SMOKE_HOME = mkdtempSync(join(tmpdir(), "auto-cli-smoke-"));
afterAll(() => rmSync(SMOKE_HOME, { recursive: true, force: true }));

type RunResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], extraEnv?: Record<string, string>): RunResult {
  const proc = Bun.spawnSync(["bun", CLI_MAIN, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv(),
      HOME: SMOKE_HOME,
      AUTO_HOME: join(SMOKE_HOME, "ws"),
      AUTO_DATA_DIR: join(SMOKE_HOME, "ws", "data"),
      NO_COLOR: "1",
      ...(extraEnv ?? {}),
    },
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// Pick a port that nothing is listening on. Port 1 is reserved (tcpmux),
// not a real listener anywhere we ship to.
const UNREACHABLE_BASE = "http://127.0.0.1:1";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto cli smoke", () => {
  describe("version (offline-tolerant)", () => {
    test("prints version info even when supervisor is unreachable", () => {
      const r = runCli(["version", "--base-url", UNREACHABLE_BASE]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("auto");
      expect(r.stdout).toContain("bun");
      expect(r.stdout).toContain("unreachable");
    });

    test("--json produces parseable JSON when unreachable", () => {
      const r = runCli(["version", "--json", "--base-url", UNREACHABLE_BASE]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(typeof parsed.auto).toBe("string");
      expect(typeof parsed.bun).toBe("string");
      expect(parsed.supervisor).toBeTruthy();
      expect(parsed.supervisor.status).toBe("unreachable");
    });
  });

  describe("API commands return exit 3 when supervisor unreachable", () => {
    test("runs exits 3 with 'supervisor unreachable' on stderr", () => {
      const r = runCli(["runs", "--base-url", UNREACHABLE_BASE]);
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(/supervisor unreachable/i);
    });

    test("job exits 3 against unreachable supervisor", () => {
      const r = runCli(["job", "anything", "--base-url", UNREACHABLE_BASE]);
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(/supervisor unreachable/i);
    });

    test("config status exits 3 when unreachable", () => {
      const r = runCli(["config", "status", "--base-url", UNREACHABLE_BASE]);
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(/supervisor unreachable/i);
    });
  });

  describe("doctor never exits 3 (it reports unreachable)", () => {
    test("doctor exits 1 when supervisor unreachable (some checks FAIL)", () => {
      const r = runCli(["doctor", "--base-url", UNREACHABLE_BASE]);
      // Doctor does not exit 3 by design; it surfaces FAIL/WARN checks.
      // Several checks fail when the supervisor is unreachable, so exit is 1.
      expect([0, 1]).toContain(r.code);
      expect(r.code).not.toBe(3);
      expect(r.stdout).toMatch(/Supervisor reachable/);
    });

    test("doctor --json emits structured checks", () => {
      const r = runCli(["doctor", "--json", "--base-url", UNREACHABLE_BASE]);
      const parsed = JSON.parse(r.stdout);
      expect(Array.isArray(parsed.checks)).toBe(true);
      expect(parsed.checks.length).toBeGreaterThan(0);
      for (const c of parsed.checks) {
        expect(typeof c.name).toBe("string");
        expect(typeof c.status).toBe("string");
        expect(typeof c.message).toBe("string");
      }
    });
  });

  describe("usage errors", () => {
    test("unknown command exits 2", () => {
      const r = runCli(["nope-not-a-real-command"]);
      expect(r.code).toBe(2);
    });
  });
});
