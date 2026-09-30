import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import type { Automation, Config } from "../supervisor/config.ts";

// What the registry hands to the schedulers (config enabled flag, DB flags,
// pauses) and the timer that ends a pause by itself.

let tmp: string;
let db: Database;
let registry: JobRegistry;

function makeJob(name: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id: name,
    name,
    worker: `./${name}/worker.ts`,
    triggers: [{ kind: "cron", id: "t", schedule: "* * * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 600_000,
    killGraceMs: 10_000,
    enabled: true,
    ...overrides,
  };
}

const webhookTrigger = {
  kind: "webhook" as const,
  id: "in",
  path: "orders",
  auth: { profile: "hmac-sha256" as const, secretRef: "s", signatureHeader: "x-sig", signaturePrefix: "sha256=" },
  contentTypes: ["application/json"],
  maxBodyBytes: 1024,
  keepPayload: false,
};

const names = (jobs: Automation[]) => jobs.map((j) => j.name);

async function until(check: () => boolean, ms = 6_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not reached in time");
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "registry-scheduling-"));
  db = new Database(join(tmp, "test.db"));
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  registry = new JobRegistry({ db });
});

afterEach(() => {
  registry.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("config-level enabled: false", () => {
  test("is never handed to the cron or webhook adapters, but is still listed", () => {
    const config: Config = [
      makeJob("on"),
      makeJob("off", { enabled: false }),
      makeJob("hook-off", { enabled: false, triggers: [webhookTrigger] }),
    ];
    registry.reconcile(config);
    expect(names(registry.activeJobs())).toEqual(["on", "off", "hook-off"]);
    expect(names(registry.activeCronJobs())).toEqual(["on"]);
    expect(names(registry.activeWebhookJobs())).toEqual([]);
    // The webhook adapter still routes it so the sender gets a retryable 503.
    expect(names(registry.webhookJobs())).toEqual(["hook-off"]);
  });

  test("turning enabled back on in the config schedules it again", () => {
    registry.reconcile([makeJob("j", { enabled: false })]);
    expect(names(registry.activeCronJobs())).toEqual([]);
    registry.reconcile([makeJob("j", { enabled: true })]);
    expect(names(registry.activeCronJobs())).toEqual(["j"]);
  });

  test("DB-level disable and trigger-level disable still exclude a job", () => {
    registry.reconcile([makeJob("j")]);
    db.run("UPDATE jobs SET enabled = 0 WHERE name = 'j'");
    expect(names(registry.activeCronJobs())).toEqual([]);
    db.run("UPDATE jobs SET enabled = 1 WHERE name = 'j'");
    expect(names(registry.activeCronJobs())).toEqual(["j"]);
    db.run("UPDATE triggers SET enabled = 0 WHERE trigger_id = 'j:t'");
    expect(names(registry.activeCronJobs())).toEqual([]);
  });
});

describe("state change notification", () => {
  test("runs every subscriber, returns the count, and rethrows the first error afterwards", () => {
    registry.reconcile([makeJob("j")]);
    const calls: string[] = [];
    registry.onStateChange(() => calls.push("a"));
    registry.onStateChange(() => {
      calls.push("b");
      throw new Error("first");
    });
    registry.onStateChange(() => {
      calls.push("c");
      throw new Error("second");
    });
    expect(() => registry.notifyStateChanged()).toThrow("first");
    expect(calls).toEqual(["a", "b", "c"]);
  });

  test("unsubscribing stops delivery; no subscribers means a count of 0", () => {
    let n = 0;
    const off = registry.onStateChange(() => n++);
    expect(registry.notifyStateChanged()).toBe(1);
    off();
    expect(registry.notifyStateChanged()).toBe(0);
    expect(n).toBe(1);
  });

  test("hasSecret uses the probe; without one it is false; a throwing probe is false", () => {
    expect(registry.hasSecret("x")).toBe(false);
    const withProbe = new JobRegistry({ db, hasSecret: (ref) => ref === "yes" });
    expect(withProbe.hasSecret("yes")).toBe(true);
    expect(withProbe.hasSecret("no")).toBe(false);
    const throwing = new JobRegistry({ db, hasSecret: () => { throw new Error("x"); } });
    expect(throwing.hasSecret("x")).toBe(false);
  });
});

describe("a pause ends by itself", () => {
  test("subscribers run when paused_until passes and the job is schedulable again", async () => {
    registry.reconcile([makeJob("j"), makeJob("other")]);
    const seen: string[][] = [];
    registry.onStateChange(() => seen.push(names(registry.activeCronJobs())));

    // What the pause API does: write, then notify.
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'j'", [Date.now() + 1_200]);
    registry.notifyStateChanged();
    expect(seen.at(-1)).toEqual(["other"]);

    const notifiedAt = seen.length;
    await until(() => seen.length > notifiedAt);
    expect(seen.at(-1)).toEqual(["j", "other"]);
    expect(names(registry.activeCronJobs())).toEqual(["j", "other"]);
  }, 15_000);

  test("the earliest pause across jobs wins, then the next one re-arms", async () => {
    registry.reconcile([makeJob("late"), makeJob("early")]);
    const seen: string[][] = [];
    registry.onStateChange(() => seen.push(names(registry.activeCronJobs())));
    const now = Date.now();
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'late'", [now + 2_400]);
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'early'", [now + 800]);
    registry.notifyStateChanged();

    await until(() => seen.some((s) => s.includes("early")));
    expect(seen.at(-1)).toEqual(["early"]);
    await until(() => seen.at(-1)?.length === 2);
    expect(seen.at(-1)).toEqual(["late", "early"]);
  }, 15_000);

  test("a reconcile re-arms the timer for pauses already in the database (supervisor restart)", async () => {
    registry.reconcile([makeJob("j")]);
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'j'", [Date.now() + 900]);
    let fired = 0;
    registry.onStateChange(() => fired++);
    registry.reconcile([makeJob("j")]);
    await until(() => fired > 0);
    expect(names(registry.activeCronJobs())).toEqual(["j"]);
  }, 15_000);

  test("unpausing before the end leaves nothing armed that changes anything", async () => {
    registry.reconcile([makeJob("j")]);
    let fired = 0;
    registry.onStateChange(() => fired++);
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'j'", [Date.now() + 600]);
    registry.notifyStateChanged();
    db.run("UPDATE jobs SET paused_until = NULL WHERE name = 'j'");
    registry.notifyStateChanged();
    const afterUnpause = fired;
    await Bun.sleep(900);
    expect(fired).toBe(afterUnpause);
  }, 15_000);

  test("close() clears the timer", async () => {
    registry.reconcile([makeJob("j")]);
    let fired = 0;
    registry.onStateChange(() => fired++);
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'j'", [Date.now() + 500]);
    registry.notifyStateChanged();
    const before = fired;
    registry.close();
    await Bun.sleep(800);
    expect(fired).toBe(before);
  }, 15_000);

  test("a pause longer than setTimeout can wait does not fire immediately", async () => {
    registry.reconcile([makeJob("j")]);
    let fired = 0;
    registry.onStateChange(() => fired++);
    // 40 days: over the 2^31-1 ms limit, where a raw setTimeout fires after 1 ms.
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'j'", [Date.now() + 40 * 86_400_000]);
    registry.notifyStateChanged();
    const before = fired;
    await Bun.sleep(400);
    expect(fired).toBe(before);
    expect(names(registry.activeCronJobs())).toEqual([]);
  }, 15_000);

  test("a subscriber that throws when a pause ends does not crash the process", async () => {
    registry.reconcile([makeJob("j")]);
    let calls = 0;
    registry.onStateChange(() => {
      calls++;
      if (calls > 1) throw new Error("adapter failed");
    });
    db.run("UPDATE jobs SET paused_until = ? WHERE name = 'j'", [Date.now() + 500]);
    registry.notifyStateChanged();
    await until(() => calls > 1);
    await Bun.sleep(50);
    expect(calls).toBe(2);
  }, 15_000);
});
