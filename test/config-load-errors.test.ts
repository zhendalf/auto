import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeConfigWarnings, ConfigSchema } from "../supervisor/config.ts";
import { describeLoadError } from "../supervisor/config-loader.ts";
import { summaryLine } from "../ui/src/util/configIssue.ts";

const ROOT = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "config-load-errors-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("a syntax error in auto.config.ts", () => {
  const bad = join(tmp, "bad.config.ts");
  writeFileSync(bad, 'export default [ {name: "x" ;\nthis is broken(\n');

  test("the loader reports the reason and the position, not only 'N errors building'", () => {
    const r = Bun.spawnSync([process.execPath, resolve(ROOT, "supervisor/config-loader.ts"), bad], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    const text = r.stderr.toString();
    expect(text).toMatch(/errors? building/);
    expect(text).toContain("line 1, column");
    expect(text).toContain('Expected "}" but found ";"');
    expect(text).toContain("this is broken(");
  });

  test("describeLoadError lists the diagnostics of an AggregateError, capped, and falls back to the stack", () => {
    const many = Object.assign(new AggregateError(Array.from({ length: 12 }, (_, i) => Object.assign(new Error(`problem ${i}`), { position: { line: i + 1, column: 2 } })), "12 errors building x"), {});
    const text = describeLoadError(many);
    expect(text.split("\n")[0]).toBe("12 errors building x");
    expect(text).toContain("line 1, column 2: problem 0");
    expect(text).toContain("... and 4 more");
    expect(describeLoadError(new Error("plain"))).toContain("plain");
    expect(describeLoadError("just text")).toBe("just text");
  });

  test("the banner line shows the first diagnostic, not the path", () => {
    const message = 'config file failed to load (exit 1):\n4 errors building "/a/very/long/path/auto.config.ts"\n  line 1, column 29: Expected "}" but found ";"';
    expect(summaryLine(message)).toBe('config file failed to load (exit 1): line 1, column 29: Expected "}" but found ";"');
  });
});

describe("the missing-secret warning", () => {
  test("is a whole sentence and names the secret for `auto secret set`", () => {
    const config = ConfigSchema.parse([
      {
        id: "h", name: "h", worker: "./jobs/h.ts",
        triggers: [{ kind: "webhook", id: "in", path: "myhook", auth: { profile: "hmac-sha256", secretRef: "my-secret", signatureHeader: "x-sig" } }],
      },
    ]);
    const [w] = computeConfigWarnings(config, () => false);
    expect(w!.code).toBe("missing_secret");
    expect(w!.message.endsWith("until it is set")).toBe(true);
    expect(w!.secret).toBe("my-secret");
  });
});
