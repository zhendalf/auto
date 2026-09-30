import { afterEach, describe, expect, test } from "bun:test";
import { serviceEntryInput, renderServiceEntry } from "../supervisor/bun-cron-service.ts";
import { svcInstall, svcStart, type SvcDeps } from "../cli/commands/svc.ts";

// The command logic of `auto svc start` / `auto install`, with stand-ins for
// everything that would register a watchdog or start a supervisor. Nothing
// here touches the real installation.

const written: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);
function capture(): void {
  written.length = 0;
  process.stderr.write = ((chunk: string | Uint8Array, cb?: () => void) => {
    written.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
}
afterEach(() => {
  process.stderr.write = origWrite;
});

type Calls = { installed: number; started: number; waited: number };

function deps(over: Partial<SvcDeps> = {}): { deps: SvcDeps; calls: Calls } {
  const calls: Calls = { installed: 0, started: 0, waited: 0 };
  return {
    calls,
    deps: {
      configExists: () => true,
      runningPid: () => null,
      portInUse: async () => false,
      installService: async () => void calls.installed++,
      startNow: () => (calls.started++, 4242),
      waitForHealthz: async () => (calls.waited++, { ok: true, status: 200 }) as any,
      isAlive: () => true,
      ...over,
    },
  };
}

async function run<T>(fn: () => Promise<T>): Promise<{ code: T; text: string }> {
  capture();
  // The stand-in write calls its callback at once, so nothing is left to flush.
  const code = await fn();
  process.stderr.write = origWrite;
  return { code, text: written.join("") };
}

for (const [name, command] of [["svc start", svcStart], ["install", svcInstall]] as const) {
  describe(`auto ${name}`, () => {
    test("without a workspace config it says to run `auto init` and does nothing else", async () => {
      const { deps: d, calls } = deps({ configExists: () => false });
      const { code, text } = await run(() => command(d));
      expect(code).toBe(1);
      expect(text).toContain("workspace config not found");
      expect(text).toContain("run `auto init` first");
      expect(calls).toEqual({ installed: 0, started: 0, waited: 0 });
    });

    test("a port that something else already serves stops before anything is registered", async () => {
      const { deps: d, calls } = deps({ portInUse: async () => true });
      expect((await run(() => command(d))).code).toBe(1);
      expect(calls.installed).toBe(0);
      expect(calls.started).toBe(0);
    });

    test("a normal start registers the watchdog, starts the supervisor and waits for it", async () => {
      const { deps: d, calls } = deps();
      const { code, text } = await run(() => command(d));
      expect(code).toBe(0);
      expect(text).toContain("supervisor starting pid=4242");
      expect(calls).toEqual({ installed: 1, started: 1, waited: 1 });
    });
  });
}

describe("the dashboard address is printed where people look", () => {
  test("once the supervisor answers, the last lines say where the dashboard is", async () => {
    // Use the real waitUntilUp path: only the health probe is a stand-in.
    const { deps: d } = deps({ waitForHealthz: async () => ({ ok: true, status: 200 }) as any });
    const { text } = await run(() => svcStart(d));
    expect(text).toMatch(/supervisor is up at http:\/\/127\.0\.0\.1:\d+/);
    expect(text).toMatch(/Dashboard: http:\/\/127\.0\.0\.1:\d+\/\n/);
  });

  test("a supervisor that is already running gets the Dashboard line too, and is not started again", async () => {
    const { deps: d, calls } = deps({ runningPid: () => 99 });
    const { code, text } = await run(() => svcStart(d));
    expect(code).toBe(0);
    expect(text).toContain("supervisor already running pid=99");
    expect(text).toMatch(/Dashboard: http:\/\/127\.0\.0\.1:\d+\//);
    expect(calls).toEqual({ installed: 0, started: 0, waited: 0 });
  });

  test("a degraded supervisor still prints the address, with a pointer to the cause", async () => {
    const { deps: d } = deps({ waitForHealthz: async () => ({ ok: true, status: 503 }) as any });
    const { text } = await run(() => svcStart(d));
    expect(text).toContain("degraded");
    expect(text).toContain("Dashboard:");
  });
});

describe("what the watchdog entry bakes in", () => {
  test("the install-time PATH and the optional settings are carried into the entry", () => {
    const input = serviceEntryInput({
      PATH: "/opt/homebrew/bin:/usr/bin",
      AUTO_ALLOWED_HOSTS: "auto.example:7777",
      AUTO_RETENTION_DAYS: "30",
      AUTO_RETENTION_MIN_RUNS: "10",
      UNRELATED: "x",
    });
    expect(input.path).toBe("/opt/homebrew/bin:/usr/bin");
    expect(input.optionalEnv).toEqual({ AUTO_ALLOWED_HOSTS: "auto.example:7777", AUTO_RETENTION_DAYS: "30", AUTO_RETENTION_MIN_RUNS: "10" });
    const source = renderServiceEntry(input);
    expect(source).toContain('process.env.PATH = "/opt/homebrew/bin:/usr/bin";');
    expect(source).toContain('process.env.AUTO_ALLOWED_HOSTS = "auto.example:7777";');
    expect(source).not.toContain("UNRELATED");
  });

  test("an empty PATH or unset options add nothing", () => {
    const input = serviceEntryInput({ PATH: "" });
    expect(input.path).toBeNull();
    expect(input.optionalEnv).toEqual({});
    expect(renderServiceEntry(input)).not.toContain("process.env.PATH");
  });
});
