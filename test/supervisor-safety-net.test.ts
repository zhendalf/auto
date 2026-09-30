import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSafetyNet } from "../supervisor/safety-net.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function harness() {
  const logs: string[] = [];
  const recorded: unknown[] = [];
  const fatals: number[] = [];
  const net = createSafetyNet({
    log: (l) => logs.push(l),
    recordError: (e) => void recorded.push(e),
    fatal: (c) => void fatals.push(c),
    exitCode: 70,
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  return { logs, recorded, fatals, net };
}

describe("safety net", () => {
  test("an unhandled rejection is logged with a timestamp and recorded, and the process keeps running", () => {
    const h = harness();
    h.net.onUnhandledRejection(new Error("write failed"));
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toContain("2026-01-02T03:04:05.000Z");
    expect(h.logs[0]).toContain("unhandled rejection");
    expect(h.logs[0]).toContain("write failed");
    expect(h.recorded.length).toBe(1);
    expect(h.fatals).toEqual([]);
  });

  test("an uncaught exception is recorded and triggers graceful teardown exactly once", () => {
    const h = harness();
    h.net.onUncaughtException(new Error("boom"));
    h.net.onUncaughtException(new Error("boom again"));
    expect(h.recorded.length).toBe(2);
    expect(h.fatals).toEqual([70]);
  });

  test("a failing recorder cannot raise a second error", () => {
    const net = createSafetyNet({
      log: () => {},
      recordError: () => {
        throw new Error("disk full");
      },
      fatal: () => {},
      exitCode: 70,
    });
    expect(() => net.onUnhandledRejection("x")).not.toThrow();
    expect(() => net.onUncaughtException("x")).not.toThrow();
  });

  test("non-Error reasons are described", () => {
    const h = harness();
    h.net.onUnhandledRejection({ code: 42 });
    h.net.onUnhandledRejection("plain string");
    expect(h.logs[0]).toContain('{"code":42}');
    expect(h.logs[1]).toContain("plain string");
  });

  test("installed for real: a rejected promise keeps the process alive, a throw exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "safety-net-"));
    try {
      const script = join(dir, "s.ts");
      writeFileSync(
        script,
        `import { createSafetyNet } from ${JSON.stringify(join(REPO_ROOT, "supervisor/safety-net.ts"))};
createSafetyNet({
  log: (l) => console.log("LOG " + l.split("\\n")[0]),
  recordError: () => {},
  fatal: (code) => { console.log("FATAL"); process.exit(code); },
  exitCode: 70,
}).install();
Promise.reject(new Error("rejected"));
await Bun.sleep(100);
console.log("STILL_ALIVE");
setTimeout(() => { throw new Error("thrown"); }, 10);
await Bun.sleep(1000);
console.log("NOT_REACHED");
`,
      );
      const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out).toContain("unhandled rejection");
      expect(out).toContain("STILL_ALIVE");
      expect(out).toContain("FATAL");
      expect(out).not.toContain("NOT_REACHED");
      expect(code).toBe(70);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
