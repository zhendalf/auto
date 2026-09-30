import { afterEach, describe, expect, test } from "bun:test";
import { CronAdapter, type CronAdapterEvent, type CronClock } from "../supervisor/adapters/cron.ts";
import type { Automation } from "../supervisor/config.ts";
import type { EnqueueResult, Runner, TriggerCtx } from "../supervisor/runner.ts";

// A supervisor started a moment after a minute boundary (the watchdog restarts
// it on one) must still run the fire of that minute, once, and must not repeat
// a fire that a previous supervisor already recorded.

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
  while (adapters.length) adapters.pop()!.stop();
});

type FakeTimer = { id: number; at: number; fn: () => void };
class FakeClock implements CronClock {
  timers: FakeTimer[] = [];
  private nextId = 1;
  constructor(public nowMs: number) {}
  now = () => this.nowMs;
  setTimeout = (fn: () => void, ms: number) => {
    const t = { id: this.nextId++, at: this.nowMs + ms, fn };
    this.timers.push(t);
    return t.id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  advanceTo(target: number): void {
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.nowMs = Math.max(this.nowMs, due.at);
      due.fn();
    }
    this.nowMs = Math.max(this.nowMs, target);
  }
}

function job(name: string, schedule: string): Automation {
  return {
    id: name,
    name,
    description: undefined,
    worker: `./${name}.ts`,
    triggers: [{ kind: "cron", id: "t", schedule }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 600_000,
    killGraceMs: 10_000,
    enabled: true,
  };
}

const adapters: CronAdapter[] = [];

function make(startAt: number, alreadyRan?: (triggerId: string, fireAt: number) => boolean) {
  const clock = new FakeClock(startAt);
  const fires: number[] = [];
  const events: CronAdapterEvent[] = [];
  const runner = {
    async enqueue(_name: string, ctx: TriggerCtx): Promise<EnqueueResult> {
      if (ctx.kind === "cron") fires.push(ctx.fire_at);
      return { kind: "started", run_id: `r${fires.length}` };
    },
  } as unknown as Runner;
  const adapter = new CronAdapter({ runner, clock, alreadyRan, onEvent: (e) => events.push(e) });
  adapters.push(adapter);
  return { clock, fires, events, adapter };
}

const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 0, 1, h, m, s, ms);

describe("the first arm after a start", () => {
  test("a fire of the minute the supervisor starts in still runs, once", async () => {
    process.env.TZ = "UTC";
    const { clock, fires, adapter } = make(at(12, 0, 0, 400), () => false);
    adapter.reconcile([job("noon", "0 12 * * *")]);
    await Bun.sleep(0);
    clock.advanceTo(at(12, 0, 5));
    await Bun.sleep(0);
    expect(fires).toEqual([at(12, 0)]);
    // ...and the schedule goes on to the next day, not again.
    clock.advanceTo(at(12, 30));
    expect(fires).toEqual([at(12, 0)]);
    expect(adapter.list()[0]!.next!.getTime()).toBe(Date.UTC(2026, 0, 2, 12, 0));
  });

  test("an every-minute schedule catches up one fire, not a burst", async () => {
    process.env.TZ = "UTC";
    const { clock, fires, adapter } = make(at(12, 0, 40), () => false);
    adapter.reconcile([job("minutely", "* * * * *")]);
    clock.advanceTo(at(12, 0, 50));
    await Bun.sleep(0);
    expect(fires).toEqual([at(12, 0)]);
    clock.advanceTo(at(12, 1, 1));
    await Bun.sleep(0);
    expect(fires).toEqual([at(12, 0), at(12, 1)]);
  });

  test("a fire that a run already records (a graceful restart right after it ran) is not repeated", async () => {
    process.env.TZ = "UTC";
    const asked: Array<[string, number]> = [];
    const { clock, fires, adapter } = make(at(12, 0, 7), (id, fireAt) => (asked.push([id, fireAt]), true));
    adapter.reconcile([job("noon", "0 12 * * *")]);
    clock.advanceTo(at(12, 0, 30));
    await Bun.sleep(0);
    expect(fires).toEqual([]);
    expect(asked).toEqual([["noon:t", at(12, 0)]]);
    expect(adapter.list()[0]!.next!.getTime()).toBe(Date.UTC(2026, 0, 2, 12, 0));
  });

  test("a fire more than a minute old is skipped, as before", async () => {
    process.env.TZ = "UTC";
    const { clock, fires, adapter } = make(at(12, 1, 30), () => false);
    adapter.reconcile([job("noon", "0 12 * * *")]);
    clock.advanceTo(at(12, 5));
    await Bun.sleep(0);
    expect(fires).toEqual([]);
  });

  test("only the first reconcile catches up: a schedule added or edited later does not fire at once", async () => {
    process.env.TZ = "UTC";
    const { clock, fires, adapter } = make(at(11, 0), () => false);
    adapter.reconcile([]);
    clock.advanceTo(at(12, 0, 20));
    adapter.reconcile([job("noon", "0 12 * * *")]); // saved 20 s after the 12:00 fire time
    clock.advanceTo(at(12, 1));
    await Bun.sleep(0);
    expect(fires).toEqual([]);
  });

  test("without an alreadyRan callback nothing changes (no catch-up)", async () => {
    process.env.TZ = "UTC";
    const { clock, fires, adapter } = make(at(12, 0, 0, 400));
    adapter.reconcile([job("noon", "0 12 * * *")]);
    clock.advanceTo(at(12, 0, 30));
    await Bun.sleep(0);
    expect(fires).toEqual([]);
  });
});
