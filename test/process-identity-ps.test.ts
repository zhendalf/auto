import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const bin = mkdtempSync(join(tmpdir(), "fake-ps-"));
afterAll(() => rmSync(bin, { recursive: true, force: true }));

function fakePs(script: string): void {
  const path = join(bin, "ps");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

/** Run process-identity in a child whose PATH starts with the fake `ps`. */
function probe(expr: string): string {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import * as m from ${JSON.stringify(resolve(ROOT, "supervisor/process-identity.ts"))}; console.log(JSON.stringify(${expr}));`,
    ],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return JSON.parse(child.stdout.toString());
}

describe("commandLineOf when `ps` does not behave like procps/BSD ps", () => {
  test("a ps that rejects the flags (BusyBox style: usage on stderr, exit 1) is 'unknown', so a live supervisor is not called dead", () => {
    fakePs('echo "ps: unrecognized option: p" >&2\necho "BusyBox v1.36 usage: ps [-o COL1,COL2=HEADER]" >&2\nexit 1');
    expect(probe("m.commandLineOf(process.pid)")).toBeNull();
    // The pid is alive, so with an unknown command line it counts as a supervisor (plain liveness).
    expect(probe("m.classifySupervisorPid(process.pid)")).toBe("supervisor");
  });

  test("exit 1 with nothing on stderr still means 'no such process'", () => {
    fakePs("exit 1");
    expect(probe("m.commandLineOf(99999999)")).toBe("");
  });

  test("a normal answer is the command line", () => {
    fakePs('echo "  bun supervisor/main.ts  "');
    expect(probe("m.commandLineOf(process.pid)")).toBe("bun supervisor/main.ts");
    expect(probe("m.classifySupervisorPid(process.pid)")).toBe("supervisor");
  });

  test("a dead pid is dead whatever ps says", () => {
    fakePs("exit 1");
    expect(probe("m.classifySupervisorPid(99999999)")).toBe("dead");
  });
});
