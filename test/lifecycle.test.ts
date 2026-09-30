import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireSingletonLock,
  liveLockHolder,
  LockHeld,
  readLock,
} from "../supervisor/lifecycle.ts";
import { runningSupervisorPid } from "../supervisor/bun-cron-service.ts";
import { classifySupervisorPid, isPidAlive } from "../supervisor/process-identity.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

let tmp: string;
let lockPath: string;
let cleanup: Array<() => void> = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  lockPath = join(tmp, "supervisor.lock");
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** A process whose command line looks like a supervisor (`bun <tmp>/supervisor/main.ts`). */
function spawnFakeSupervisor(): number {
  const dir = join(tmp, "fake", "supervisor");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "main.ts");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => child.kill("SIGKILL"));
  return child.pid;
}

/** A live process that is definitely not a supervisor. */
function spawnForeign(): number {
  const child = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => child.kill("SIGKILL"));
  return child.pid;
}

async function spawnAndReap(): Promise<number> {
  const child = Bun.spawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

function writeLock(pid: number, entry = "/x/supervisor/main.ts"): void {
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: Date.now() - 1000, entry }), { mode: 0o600 });
}

describe("acquireSingletonLock", () => {
  test("fresh acquire records pid, startedAt and entry, mode 0600, and release removes it", () => {
    const lock = acquireSingletonLock({ lockPath, entry: "/x/supervisor/main.ts" });
    const read = readLock(lockPath);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.info.pid).toBe(process.pid);
      expect(read.info.entry).toBe("/x/supervisor/main.ts");
      expect(read.info.startedAt).toBeGreaterThan(0);
    }
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    // Release is idempotent.
    lock.release();
  });

  test("a lock held by a live supervisor is refused", () => {
    const pid = spawnFakeSupervisor();
    writeLock(pid);
    let caught: unknown;
    try {
      acquireSingletonLock({ lockPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockHeld);
    expect((caught as LockHeld).holderPid).toBe(pid);
    // The holder's lock is untouched.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(pid);
    expect(liveLockHolder(lockPath)?.pid).toBe(pid);
    expect(runningSupervisorPid(lockPath)).toBe(pid);
  });

  test("a dead pid is taken over", async () => {
    const dead = await spawnAndReap();
    expect(isPidAlive(dead)).toBe(false);
    writeLock(dead);
    expect(liveLockHolder(lockPath)).toBeNull();
    expect(runningSupervisorPid(lockPath)).toBeNull();
    const lock = acquireSingletonLock({ lockPath });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  test("a live pid that is not a supervisor (pid reuse) is taken over and never trusted", () => {
    const foreign = spawnForeign();
    expect(isPidAlive(foreign)).toBe(true);
    writeLock(foreign);
    expect(classifySupervisorPid(foreign, "/x/supervisor/main.ts")).toBe("foreign");
    expect(liveLockHolder(lockPath)).toBeNull();
    expect(runningSupervisorPid(lockPath)).toBeNull();
    const lock = acquireSingletonLock({ lockPath });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock.release();
    // The stranger was never signalled.
    expect(isPidAlive(foreign)).toBe(true);
  });

  test("a stale lock naming our own pid (not held by us) is replaced", () => {
    writeLock(process.pid);
    const lock = acquireSingletonLock({ lockPath });
    expect(readLock(lockPath).kind).toBe("ok");
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a corrupt lock file is replaced", () => {
    writeFileSync(lockPath, "not json{{{", { mode: 0o600 });
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    expect(liveLockHolder(lockPath)).toBeNull();
    const lock = acquireSingletonLock({ lockPath });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  test("a legacy lock file with only a pid still resolves by pid identity", async () => {
    const dead = await spawnAndReap();
    writeFileSync(lockPath, JSON.stringify({ pid: dead }));
    expect(liveLockHolder(lockPath)).toBeNull();
    const lock = acquireSingletonLock({ lockPath });
    lock.release();
  });

  test("two starters racing on a stale lock: exactly one wins", async () => {
    const dead = await spawnAndReap();
    writeLock(dead);

    // Children are named supervisor/main.ts so they count as live supervisors
    // to each other, and they synchronize on a shared start instant.
    const dir = join(tmp, "racers", "supervisor");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "main.ts");
    writeFileSync(
      script,
      `import { acquireSingletonLock, LockHeld } from ${JSON.stringify(resolve(REPO_ROOT, "supervisor/lifecycle.ts"))};
const startAt = Number(process.env.START_AT);
while (Date.now() < startAt) {}
try {
  acquireSingletonLock({ lockPath: process.env.LOCK_PATH! });
  console.log("WON");
  await Bun.sleep(2500);
} catch (err) {
  console.log(err instanceof LockHeld ? "HELD" : "ERROR " + String(err));
}
`,
    );
    const startAt = Date.now() + 1500;
    const children = Array.from({ length: 5 }, () =>
      Bun.spawn([process.execPath, script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LOCK_PATH: lockPath, START_AT: String(startAt) },
      }),
    );
    cleanup.push(() => children.forEach((c) => c.kill("SIGKILL")));
    const outputs = await Promise.all(
      children.map(async (c) => (await new Response(c.stdout).text()).trim()),
    );
    await Promise.all(children.map((c) => c.exited));
    const wins = outputs.filter((o) => o === "WON").length;
    expect(outputs.filter((o) => o.startsWith("ERROR"))).toEqual([]);
    expect(wins).toBe(1);
    expect(outputs.filter((o) => o === "HELD").length).toBe(4);
  }, 20_000);

  test("two starters racing on a fresh (absent) lock: exactly one wins", async () => {
    const dir = join(tmp, "racers2", "supervisor");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "main.ts");
    writeFileSync(
      script,
      `import { acquireSingletonLock, LockHeld } from ${JSON.stringify(resolve(REPO_ROOT, "supervisor/lifecycle.ts"))};
while (Date.now() < Number(process.env.START_AT)) {}
try {
  acquireSingletonLock({ lockPath: process.env.LOCK_PATH! });
  console.log("WON");
  await Bun.sleep(2500);
} catch (err) {
  console.log(err instanceof LockHeld ? "HELD" : "ERROR " + String(err));
}
`,
    );
    const startAt = Date.now() + 1500;
    const children = Array.from({ length: 5 }, () =>
      Bun.spawn([process.execPath, script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LOCK_PATH: lockPath, START_AT: String(startAt) },
      }),
    );
    cleanup.push(() => children.forEach((c) => c.kill("SIGKILL")));
    const outputs = await Promise.all(
      children.map(async (c) => (await new Response(c.stdout).text()).trim()),
    );
    await Promise.all(children.map((c) => c.exited));
    expect(outputs.filter((o) => o === "WON").length).toBe(1);
    expect(outputs.filter((o) => o === "HELD").length).toBe(4);
  }, 20_000);
});

describe("classifySupervisorPid", () => {
  test("dead, supervisor and foreign", () => {
    expect(classifySupervisorPid(1, null, { isAlive: () => false })).toBe("dead");
    const cmd = (c: string) => ({ isAlive: () => true, commandLine: () => c });
    expect(classifySupervisorPid(5, null, cmd("/opt/bun /home/u/auto/supervisor/main.ts"))).toBe("supervisor");
    expect(classifySupervisorPid(5, null, cmd("bun run --cron-title=x /home/u/.auto/.auto-runtime/supervisor.ts"))).toBe("supervisor");
    expect(classifySupervisorPid(5, "/custom/entry.ts", cmd("bun /custom/entry.ts"))).toBe("supervisor");
    expect(classifySupervisorPid(5, "/custom/entry.ts", cmd("vim notes.txt"))).toBe("foreign");
  });

  test("falls back to plain liveness when the command line is unavailable", () => {
    expect(classifySupervisorPid(5, null, { isAlive: () => true, commandLine: () => null })).toBe("supervisor");
  });

  test("an empty command line means the process vanished", () => {
    expect(classifySupervisorPid(5, null, { isAlive: () => true, commandLine: () => "" })).toBe("dead");
  });
});
