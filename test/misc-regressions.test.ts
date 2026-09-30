import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, type ConfigInput } from "../index.ts";
import { readSecrets } from "../cli/commands/secret.ts";
import { ConfigSchema } from "../supervisor/config.ts";
import { SecretStore } from "../supervisor/secrets.ts";
import { makeWorkspace, runAuto, type Workspace } from "./cli-harness.ts";

const SECRET_VALUE = "topsecretvalue123";
const BROKEN = `{"version":1,"secrets":{"s1":${SECRET_VALUE}}}`;

const temps: string[] = [];
const made: Workspace[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  while (made.length) made.pop()!.cleanup();
});

describe("defineConfig accepts what an author actually writes", () => {
  test("a minimal job compiles (type-checked by `bunx tsc --noEmit`) and validates with defaults filled in", () => {
    // Before: the parameter was the schema OUTPUT type, so every defaulted field
    // (reentrancy, queueDepth, timeoutMs, killGraceMs, enabled) was required.
    const config = defineConfig([
      { id: "a", name: "a", worker: "./jobs/a.ts", triggers: [{ kind: "cron", id: "c", schedule: "* * * * *" }] },
    ]);
    const parsed = ConfigSchema.parse(config);
    expect(parsed[0]).toMatchObject({ reentrancy: "drop", queueDepth: 1, enabled: true });
  });

  test("a webhook trigger without its defaulted limits compiles too", () => {
    const input: ConfigInput = [
      {
        id: "h", name: "h", worker: "./jobs/h.ts",
        triggers: [{ kind: "webhook", id: "in", path: "in", auth: { profile: "hmac-sha256", secretRef: "s", signatureHeader: "x-sig" } }],
      },
    ];
    expect(ConfigSchema.parse(defineConfig(input))).toHaveLength(1);
  });
});

describe("a malformed secrets file never has its content echoed", () => {
  test("SecretStore.load reports the file, not the parser's quote of the value", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-leak-"));
    temps.push(dir);
    const path = join(dir, "secrets.json");
    writeFileSync(path, BROKEN, { mode: 0o600 });
    chmodSync(path, 0o600);
    let message = "";
    try {
      new SecretStore(path).load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("secrets file is not valid JSON");
    expect(message).toContain(path);
    expect(message).not.toContain(SECRET_VALUE);
  });

  test("the CLI's readSecrets says only that the file is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-leak-"));
    temps.push(dir);
    const path = join(dir, "secrets.json");
    writeFileSync(path, BROKEN, { mode: 0o600 });
    let message = "";
    try {
      readSecrets(path);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("is not valid JSON");
    expect(message).not.toContain(SECRET_VALUE);
  });

  test("`auto secret list` (text and --json) prints nothing from the broken file", async () => {
    const ws = makeWorkspace(1);
    made.push(ws);
    mkdirSync(ws.data, { recursive: true, mode: 0o700 });
    writeFileSync(join(ws.data, "secrets.json"), BROKEN, { mode: 0o600 });
    for (const args of [["secret", "list"], ["--json", "secret", "list"]]) {
      const r = await runAuto(ws, args);
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).not.toContain(SECRET_VALUE);
      expect(r.stderr).toContain("is not valid JSON");
    }
  });

  test("the supervisor's startup log does not contain it either", async () => {
    const ws = makeWorkspace(17991);
    made.push(ws);
    mkdirSync(ws.data, { recursive: true, mode: 0o700 });
    writeFileSync(join(ws.home, "auto.config.ts"), "export default [];\n");
    writeFileSync(join(ws.data, "secrets.json"), BROKEN, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "supervisor", "main.ts")], {
      cwd: ws.home, env: ws.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const res = await fetch("http://127.0.0.1:17991/healthz", { signal: AbortSignal.timeout(500) });
          if (res.status === 200 || res.status === 503) break;
        } catch { /* not up yet */ }
        if (child.exitCode !== null || Date.now() > deadline) throw new Error("supervisor did not start");
        await Bun.sleep(100);
      }
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
    const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    expect(output).toContain("secrets load failed");
    expect(output).not.toContain(SECRET_VALUE);
  }, 30_000);
});
