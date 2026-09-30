import { afterEach, describe, expect, test } from "bun:test";
import { CronAdapter, validateCronExpression, type CronAdapterEvent } from "../supervisor/adapters/cron.ts";
import type { Automation } from "../supervisor/config.ts";
import type { EnqueueResult, Runner, TriggerCtx } from "../supervisor/runner.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type EnqueueCall = { jobName: string; ctx: TriggerCtx };

function makeFakeRunner(result: EnqueueResult = { kind: "started", run_id: "test" }): {
  runner: Runner;
  calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  const runner = {
    async enqueue(jobName: string, ctx: TriggerCtx): Promise<EnqueueResult> {
      calls.push({ jobName, ctx });
      return result;
    },
  } as unknown as Runner;
  return { runner, calls };
}

function makeJob(name: string, triggers: { id: string; schedule: string }[]): Automation {
  return {
    id: name,
    name,
    description: undefined,
    worker: `./${name}/worker.ts`,
    triggers: triggers.map((t) => ({ kind: "cron" as const, id: t.id, schedule: t.schedule })),
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 600_000,
    killGraceMs: 10_000,
    enabled: true,
  };
}

// Track all adapters created in a test so we can stop them on teardown even if
// an assertion throws.
const liveAdapters: CronAdapter[] = [];

function newAdapter(opts: { onEvent?: (ev: CronAdapterEvent) => void } = {}): {
  adapter: CronAdapter;
  runner: Runner;
  calls: EnqueueCall[];
  events: CronAdapterEvent[];
} {
  const { runner, calls } = makeFakeRunner();
  const events: CronAdapterEvent[] = [];
  const adapter = new CronAdapter({
    runner,
    onEvent: (ev) => {
      events.push(ev);
      opts.onEvent?.(ev);
    },
  });
  liveAdapters.push(adapter);
  return { adapter, runner, calls, events };
}

afterEach(() => {
  while (liveAdapters.length > 0) {
    const a = liveAdapters.pop();
    try {
      a?.stop();
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// validateCronExpression
// ---------------------------------------------------------------------------

describe("validateCronExpression", () => {
  test("accepts canonical 5-field patterns", () => {
    expect(() => validateCronExpression("30 3 * * *")).not.toThrow();
    expect(() => validateCronExpression("* * * * *")).not.toThrow();
    expect(() => validateCronExpression("0 0 1 1 *")).not.toThrow();
  });

  test("rejects invalid patterns", () => {
    expect(() => validateCronExpression("not a cron")).toThrow();
    // Only five fields are supported (no seconds field).
    expect(() => validateCronExpression("* * * * * *")).toThrow(/5 fields/);
    expect(() => validateCronExpression("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reconcile lifecycle
// ---------------------------------------------------------------------------

describe("CronAdapter.reconcile", () => {
  test("adds, removes, and replaces schedules across reconcile calls", () => {
    const { adapter } = newAdapter();
    const job1 = makeJob("job1", [{ id: "a", schedule: "0 * * * *" }]);
    const job2 = makeJob("job2", [{ id: "a", schedule: "30 * * * *" }]);

    adapter.reconcile([job1]);
    let entries = adapter.list();
    expect(entries.length).toBe(1);
    expect(entries[0]!.jobName).toBe("job1");
    expect(entries[0]!.trigger_id).toBe("job1:a");
    expect(entries[0]!.pattern).toBe("0 * * * *");

    adapter.reconcile([job1, job2]);
    entries = adapter.list();
    expect(entries.length).toBe(2);
    const names = entries.map((e) => e.jobName).sort();
    expect(names).toEqual(["job1", "job2"]);

    adapter.reconcile([job2]);
    entries = adapter.list();
    expect(entries.length).toBe(1);
    expect(entries[0]!.jobName).toBe("job2");

    adapter.stop();
    expect(adapter.list().length).toBe(0);
  });

  test("changing the pattern for an existing key replaces the cron instance", () => {
    const { adapter } = newAdapter();
    const v1 = makeJob("rotater", [{ id: "main", schedule: "0 * * * *" }]);
    const v2 = makeJob("rotater", [{ id: "main", schedule: "*/15 * * * *" }]);

    adapter.reconcile([v1]);
    const before = adapter._get("rotater", "main");
    expect(before).toBeDefined();
    expect(adapter.list()[0]!.pattern).toBe("0 * * * *");

    adapter.reconcile([v2]);
    const after = adapter._get("rotater", "main");
    expect(after).toBeDefined();
    expect(after).not.toBe(before); // new schedule handle proves replacement
    expect(adapter.list()[0]!.pattern).toBe("*/15 * * * *");
  });

  test("reconcile is idempotent when pattern is unchanged (no replacement)", () => {
    const { adapter } = newAdapter();
    const job = makeJob("steady", [{ id: "main", schedule: "0 * * * *" }]);
    adapter.reconcile([job]);
    const before = adapter._get("steady", "main");
    adapter.reconcile([job]);
    const after = adapter._get("steady", "main");
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// End-to-end fire (via the adapter's _fire test hook)
// ---------------------------------------------------------------------------

describe("CronAdapter handler wiring", () => {
  // The natural end-to-end is to schedule a `* * * * *` cron and wait for it
  // to fire, but a one-minute wait is unacceptable in CI (the timer-driven path
  // is covered with a fake clock in cron-adapter-schedule.test.ts). `_fire`
  // invokes the same handler directly, which still exercises the full enqueue
  // + onEvent path including fire_at, namespaced trigger_id, and result mapping.
  test("manually triggering a cron fires runner.enqueue with the right TriggerCtx", async () => {
    const { adapter, calls, events } = newAdapter();
    const job = makeJob("ping", [{ id: "default", schedule: "0 * * * *" }]);
    adapter.reconcile([job]);

    const t0 = Date.now();
    await adapter._fire("ping", "default");
    const t1 = Date.now();

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.jobName).toBe("ping");
    expect(call.ctx.kind).toBe("cron");
    if (call.ctx.kind !== "cron") throw new Error("expected cron ctx");
    // Adapter passes the LOCAL trigger id; the runner re-namespaces it as
    // `<jobName>:<trigger.id>` before persisting (see runner.ts triggerIdFor).
    expect(call.ctx.trigger_id).toBe("default");
    expect(call.ctx.fire_at).toBeGreaterThanOrEqual(t0);
    expect(call.ctx.fire_at).toBeLessThanOrEqual(t1);

    const fired = events.find((e) => e.kind === "fired");
    expect(fired).toBeDefined();
    if (!fired || fired.kind !== "fired") throw new Error("expected fired event");
    expect(fired.jobName).toBe("ping");
    expect(fired.trigger_id).toBe("ping:default");
    expect(fired.result.kind).toBe("started");
  });
});
