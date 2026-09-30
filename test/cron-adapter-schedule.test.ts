import { afterEach, describe, expect, test } from "bun:test";
import {
  CronAdapter,
  nextCronFire,
  validateCronExpression,
  type CronAdapterEvent,
  type CronClock,
} from "../supervisor/adapters/cron.ts";
import type { Automation } from "../supervisor/config.ts";
import type { EnqueueResult, Runner, TriggerCtx } from "../supervisor/runner.ts";

// ---------------------------------------------------------------------------
// Time zone control
// ---------------------------------------------------------------------------

const originalTZ = process.env.TZ;

function useTZ(tz: string): void {
  process.env.TZ = tz;
  // Fail loudly if this runtime ignores TZ changes; every assertion below
  // depends on it.
  const probe = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));
  const expected: Record<string, number> = {
    UTC: 0,
    "America/New_York": -240,
    "Asia/Kolkata": 330,
  };
  if (tz in expected) expect(0 - probe.getTimezoneOffset()).toBe(expected[tz]!);
}

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

/** Local wall-clock -> epoch ms, in the currently selected TZ. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

// ---------------------------------------------------------------------------
// nextCronFire
// ---------------------------------------------------------------------------

describe("nextCronFire: local time", () => {
  test("fires on local wall-clock time, not UTC", () => {
    useTZ("Asia/Kolkata");
    const t = nextCronFire("30 9 * * *", Date.UTC(2026, 6, 1, 0, 0))!;
    const d = new Date(t);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
    expect(iso(t)).toBe("2026-07-01T04:00:00.000Z"); // 09:30 IST

    useTZ("UTC");
    expect(iso(nextCronFire("30 9 * * *", Date.UTC(2026, 6, 1, 0, 0)))).toBe("2026-07-01T09:30:00.000Z");
  });

  test("result is strictly after `from` and minute-aligned", () => {
    useTZ("UTC");
    const from = Date.UTC(2026, 0, 1, 10, 15, 30, 500);
    expect(iso(nextCronFire("* * * * *", from))).toBe("2026-01-01T10:16:00.000Z");
    const exact = Date.UTC(2026, 0, 1, 10, 16, 0, 0);
    expect(iso(nextCronFire("* * * * *", exact))).toBe("2026-01-01T10:17:00.000Z");
    expect(iso(nextCronFire("*/15 * * * *", exact))).toBe("2026-01-01T10:30:00.000Z");
  });

  test("defaults `from` to now", () => {
    const t = nextCronFire("* * * * *")!;
    expect(t).toBeGreaterThan(Date.now());
    expect(t - Date.now()).toBeLessThanOrEqual(60_000);
  });

  test("returns null for invalid or never-firing expressions", () => {
    expect(nextCronFire("not a cron")).toBeNull();
    expect(nextCronFire("* * * * * *")).toBeNull();
    expect(nextCronFire("60 * * * *")).toBeNull();
    expect(nextCronFire("0 0 31 2 *")).toBeNull();
    expect(nextCronFire("")).toBeNull();
  });

  test("yearly and leap-day schedules", () => {
    useTZ("America/New_York");
    expect(iso(nextCronFire("0 0 1 1 *", local(2026, 6, 15)))).toBe(iso(local(2027, 1, 1)));
    expect(iso(nextCronFire("0 0 29 2 *", local(2026, 3, 1)))).toBe(iso(local(2028, 2, 29)));
    expect(iso(nextCronFire("@yearly", local(2026, 6, 15)))).toBe(iso(local(2027, 1, 1)));
  });
});

describe("nextCronFire: syntax", () => {
  test("names, lists, ranges, steps and macros", () => {
    useTZ("UTC");
    const from = Date.UTC(2026, 5, 3, 12, 0); // Wed 2026-06-03
    expect(iso(nextCronFire("0 9 * * MON-FRI", from))).toBe("2026-06-04T09:00:00.000Z");
    expect(iso(nextCronFire("0 9 * * sat,sun", from))).toBe("2026-06-06T09:00:00.000Z");
    expect(iso(nextCronFire("0 9 * * 0", from))).toBe("2026-06-07T09:00:00.000Z");
    expect(iso(nextCronFire("0 9 * * 7", from))).toBe("2026-06-07T09:00:00.000Z");
    expect(iso(nextCronFire("0 0 1 JUL *", from))).toBe("2026-07-01T00:00:00.000Z");
    expect(iso(nextCronFire("10-50/20 13 * * *", from))).toBe("2026-06-03T13:10:00.000Z");
    expect(iso(nextCronFire("5/30 13 * * *", from))).toBe("2026-06-03T13:05:00.000Z");
    expect(iso(nextCronFire("@hourly", from))).toBe("2026-06-03T13:00:00.000Z");
    expect(iso(nextCronFire("@daily", from))).toBe("2026-06-04T00:00:00.000Z");
    expect(iso(nextCronFire("@weekly", from))).toBe("2026-06-07T00:00:00.000Z");
    expect(iso(nextCronFire("@monthly", from))).toBe("2026-07-01T00:00:00.000Z");
  });

  test("validateCronExpression accepts the same syntax and rejects garbage", () => {
    for (const ok of ["* * * * *", "0 9 * * MON-FRI", "@daily", "@midnight", "0 0 * * 0-7", "*/5 0-6 1,15 * *", "  0 0 * * *  "]) {
      expect(() => validateCronExpression(ok)).not.toThrow();
    }
    for (const bad of ["", "   ", "not a cron", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8",
      "*/0 * * * *", "5-1 * * * *", "1,,3 * * * *", "@reboot", "@every 5m", "0 0 L * *", "a * * * *"]) {
      expect(() => validateCronExpression(bad)).toThrow();
    }
    expect(() => validateCronExpression("* * * * * *")).toThrow(/5 fields/);
    expect(() => validateCronExpression("0 0 31 2 *")).toThrow(/no future occurrence/);
  });
});

describe("nextCronFire: day-of-month OR day-of-week", () => {
  test("both restricted: either matches (not both)", () => {
    useTZ("UTC");
    // Feb 2026: the 13th is a Friday, the 6th is the first Friday.
    const from = Date.UTC(2026, 1, 1, 0, 0);
    const fires: string[] = [];
    let t = from;
    for (let i = 0; i < 6; i++) {
      t = nextCronFire("0 0 13 * FRI", t)!;
      fires.push(iso(t)!.slice(0, 10));
    }
    // Every Friday, plus the 13th of any month.
    expect(fires).toEqual(["2026-02-06", "2026-02-13", "2026-02-20", "2026-02-27", "2026-03-06", "2026-03-13"]);
    // An AND rule would have skipped straight to Friday 13 Feb 2026.
    expect(fires[0]).not.toBe("2026-02-13");
  });

  test("first-week-or-Monday style expressions", () => {
    useTZ("UTC");
    // Mon 2026-06-01 is both the 1st and a Monday; next is Mon the 8th (dow), then the 15th...
    expect(iso(nextCronFire("0 0 1-3 * MON", Date.UTC(2026, 5, 3, 1, 0)))).toBe("2026-06-08T00:00:00.000Z");
    expect(iso(nextCronFire("0 0 1-3 * MON", Date.UTC(2026, 5, 30, 1, 0)))).toBe("2026-07-01T00:00:00.000Z");
  });

  test("a wildcard-led field means AND semantics (the wildcard is always true)", () => {
    useTZ("UTC");
    // dom restricted, dow "*": only the 1st. dow restricted, dom "*": only Mondays.
    expect(iso(nextCronFire("0 0 15 * *", Date.UTC(2026, 5, 3)))).toBe("2026-06-15T00:00:00.000Z");
    expect(iso(nextCronFire("0 0 * * MON", Date.UTC(2026, 5, 3)))).toBe("2026-06-08T00:00:00.000Z");
    // "*/2" in dow (Sun, Tue, Thu, Sat) starts with "*", so it ANDs with the
    // day of month rather than ORing: the 15th, but only when it is such a day.
    // 15 Jun 2026 is a Monday; 15 Aug 2026 is a Saturday.
    expect(iso(nextCronFire("0 0 15 * */2", Date.UTC(2026, 5, 3)))).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("nextCronFire: daylight saving time (America/New_York)", () => {
  // 2026: spring forward Sun Mar 8 (02:00 EST -> 03:00 EDT), fall back Sun Nov 1 (02:00 EDT -> 01:00 EST).

  test("spring forward: a time inside the gap fires once, shifted by the gap", () => {
    useTZ("America/New_York");
    const first = nextCronFire("30 2 * * *", local(2026, 3, 7, 12))!;
    expect(iso(first)).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    const second = nextCronFire("30 2 * * *", first)!;
    expect(iso(second)).toBe("2026-03-09T06:30:00.000Z"); // back to 02:30 EDT next day
    // And the day before is unaffected.
    expect(iso(nextCronFire("30 2 * * *", local(2026, 3, 6, 12)))).toBe("2026-03-07T07:30:00.000Z"); // 02:30 EST
  });

  test("spring forward: hourly schedule fires once for the missing hour, no duplicate", () => {
    useTZ("America/New_York");
    const fires: string[] = [];
    let t = local(2026, 3, 8, 0, 30);
    for (let i = 0; i < 4; i++) {
      t = nextCronFire("0 * * * *", t)!;
      fires.push(iso(t)!);
    }
    expect(fires).toEqual([
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT (02:00 does not exist)
      "2026-03-08T08:00:00.000Z", // 04:00 EDT
      "2026-03-08T09:00:00.000Z",
    ]);
  });

  test("spring forward: */30 minutes never fires twice at the same instant", () => {
    useTZ("America/New_York");
    const seen = new Set<number>();
    let t = local(2026, 3, 8, 0, 0);
    for (let i = 0; i < 12; i++) {
      t = nextCronFire("*/30 * * * *", t)!;
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    // 00:30, 01:00, 01:30 EST then 03:00, 03:30 EDT: nothing in between.
    expect([...seen].slice(0, 5).map(iso)).toEqual([
      "2026-03-08T05:30:00.000Z",
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:30:00.000Z",
    ]);
  });

  test("fall back: a fixed time in the repeated hour fires once, at the first occurrence", () => {
    useTZ("America/New_York");
    const first = nextCronFire("30 1 * * *", local(2026, 10, 31, 12))!;
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    const next = nextCronFire("30 1 * * *", first)!;
    // NOT 06:30Z (01:30 EST on the same day): the next fire is the following day's 01:30 EST.
    expect(iso(next)).toBe("2026-11-02T06:30:00.000Z");
  });

  test("fall back: an every-hour schedule keeps firing through the repeated hour", () => {
    useTZ("America/New_York");
    const fires: string[] = [];
    let t = local(2026, 11, 1, 0, 30);
    for (let i = 0; i < 4; i++) {
      t = nextCronFire("0 * * * *", t)!;
      fires.push(iso(t)!);
    }
    expect(fires).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST (repeat)
      "2026-11-01T07:00:00.000Z", // 02:00 EST
      "2026-11-01T08:00:00.000Z",
    ]);
  });

  test("fall back: */20 minutes covers the repeated hour without duplicates", () => {
    useTZ("America/New_York");
    const seen: number[] = [];
    let t = Date.UTC(2026, 10, 1, 5, 0); // 01:00 EDT
    for (let i = 0; i < 6; i++) {
      t = nextCronFire("*/20 * * * *", t)!;
      seen.push(t);
    }
    expect(seen.map(iso)).toEqual([
      "2026-11-01T05:20:00.000Z",
      "2026-11-01T05:40:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:20:00.000Z",
      "2026-11-01T06:40:00.000Z",
      "2026-11-01T07:00:00.000Z",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("the Bun version does not matter: no Bun.cron.parse involved", () => {
    useTZ("America/New_York");
    const original = Bun.cron.parse;
    (Bun.cron as { parse: unknown }).parse = () => {
      throw new Error("Bun.cron.parse must not be used");
    };
    try {
      expect(nextCronFire("0 3 * * *", local(2026, 6, 1, 12))).toBe(local(2026, 6, 2, 3));
      expect(() => validateCronExpression("0 3 * * *")).not.toThrow();
    } finally {
      (Bun.cron as { parse: unknown }).parse = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduler behaviour with a fake clock
// ---------------------------------------------------------------------------

type FakeTimer = { id: number; at: number; fn: () => void };

class FakeClock implements CronClock {
  nowMs: number;
  timers: FakeTimer[] = [];
  delays: number[] = [];
  private nextId = 1;
  constructor(start: number) {
    this.nowMs = start;
  }
  now = () => this.nowMs;
  setTimeout = (fn: () => void, ms: number) => {
    this.delays.push(ms);
    const t = { id: this.nextId++, at: this.nowMs + ms, fn };
    this.timers.push(t);
    return t.id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  /** Run timers in order until the clock reaches `target` (timers may re-arm). */
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
  /** Move the wall clock without running anything (machine asleep), then fire what is pending. */
  sleepThrough(target: number): void {
    this.nowMs = target;
    const pending = [...this.timers].sort((a, b) => a.at - b.at)[0];
    if (pending) {
      this.timers = this.timers.filter((t) => t !== pending);
      pending.fn();
    }
  }
}

function makeJob(name: string, schedule: string): Automation {
  return {
    id: name,
    name,
    description: undefined,
    worker: `./${name}/worker.ts`,
    triggers: [{ kind: "cron", id: "t", schedule }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 600_000,
    killGraceMs: 10_000,
    enabled: true,
  };
}

const adapters: CronAdapter[] = [];

function scheduler(startAt: number) {
  const clock = new FakeClock(startAt);
  const calls: { jobName: string; ctx: TriggerCtx }[] = [];
  const events: CronAdapterEvent[] = [];
  const runner = {
    async enqueue(jobName: string, ctx: TriggerCtx): Promise<EnqueueResult> {
      calls.push({ jobName, ctx });
      return { kind: "started", run_id: `r${calls.length}` };
    },
  } as unknown as Runner;
  const adapter = new CronAdapter({ runner, clock, onEvent: (e) => events.push(e) });
  adapters.push(adapter);
  return { clock, calls, events, adapter };
}

afterEach(() => {
  while (adapters.length) adapters.pop()!.stop();
});

const fireTimes = (calls: { ctx: TriggerCtx }[]) =>
  calls.map((c) => (c.ctx.kind === "cron" ? c.ctx.fire_at : -1));

describe("CronAdapter scheduling", () => {
  test("no timer delay ever exceeds the setTimeout limit, and a far-off schedule still fires exactly on time", async () => {
    useTZ("UTC");
    const start = Date.UTC(2026, 0, 1, 12, 0);
    const { clock, calls, adapter } = scheduler(start);
    adapter.reconcile([makeJob("monthly", "0 0 1 * *")]); // ~30 days away: more than 2^31 ms
    const nextAt = Date.UTC(2026, 1, 1, 0, 0);
    expect(nextAt - start).toBeGreaterThan(2 ** 31 - 1);

    clock.advanceTo(nextAt - 1);
    expect(calls.length).toBe(0);
    clock.advanceTo(nextAt);
    await Bun.sleep(0);
    expect(fireTimes(calls)).toEqual([nextAt]);

    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(30_000); // and in practice far smaller
  });

  test("a yearly schedule ('0 0 1 1 *') does not fire right away", async () => {
    useTZ("UTC");
    const { clock, calls, adapter } = scheduler(Date.UTC(2026, 5, 1));
    adapter.reconcile([makeJob("yearly", "0 0 1 1 *")]);
    clock.advanceTo(Date.UTC(2026, 5, 2));
    await Bun.sleep(0);
    expect(calls.length).toBe(0);
    expect(iso(adapter.list()[0]!.next!.getTime())).toBe("2027-01-01T00:00:00.000Z");
  });

  test("with real timers, a yearly schedule does not fire within the first moments", async () => {
    // Regression guard for the setTimeout overflow (delay > 2^31-1 ms fires after ~1 ms).
    const calls: unknown[] = [];
    const runner = { async enqueue() { calls.push(1); return { kind: "started", run_id: "x" }; } } as unknown as Runner;
    const adapter = new CronAdapter({ runner });
    adapters.push(adapter);
    adapter.reconcile([makeJob("yearly-real", "0 0 1 1 *")]);
    await Bun.sleep(80);
    expect(calls.length).toBe(0);
    adapter.stop();
  });

  test("fires once per scheduled minute, with the scheduled time as fire_at", async () => {
    useTZ("UTC");
    const start = Date.UTC(2026, 0, 1, 10, 0, 20);
    const { clock, calls, adapter } = scheduler(start);
    adapter.reconcile([makeJob("everyminute", "* * * * *")]);
    clock.advanceTo(Date.UTC(2026, 0, 1, 10, 5, 0));
    await Bun.sleep(0);
    expect(fireTimes(calls)).toEqual([1, 2, 3, 4, 5].map((m) => Date.UTC(2026, 0, 1, 10, m, 0)));
  });

  test("an early wake-up does not fire early or twice", async () => {
    useTZ("UTC");
    const start = Date.UTC(2026, 0, 1, 10, 0, 20);
    const { clock, calls, adapter } = scheduler(start);
    adapter.reconcile([makeJob("early", "* * * * *")]);
    const due = Date.UTC(2026, 0, 1, 10, 1, 0);

    // Timer fires 5 ms early.
    clock.nowMs = due - 5;
    const early = clock.timers.shift()!;
    early.fn();
    await Bun.sleep(0);
    expect(calls.length).toBe(0);
    expect(clock.timers.length).toBe(1); // re-armed

    clock.advanceTo(due);
    await Bun.sleep(0);
    expect(fireTimes(calls)).toEqual([due]);
    clock.advanceTo(due + 100);
    await Bun.sleep(0);
    expect(calls.length).toBe(1);
  });

  test("after the machine sleeps, missed fires are skipped: one 'missed' event, no catch-up burst", async () => {
    useTZ("UTC");
    const start = Date.UTC(2026, 0, 1, 10, 0, 20);
    const { clock, calls, events, adapter } = scheduler(start);
    adapter.reconcile([makeJob("sleeper", "* * * * *")]);

    // Sleep two hours (120 missed minutes), then the pending timer wakes up.
    const wake = Date.UTC(2026, 0, 1, 12, 0, 20);
    clock.sleepThrough(wake);
    await Bun.sleep(0);

    expect(calls.length).toBe(0);
    const missed = events.filter((e) => e.kind === "missed");
    expect(missed.length).toBe(1);
    expect(missed[0]).toMatchObject({ kind: "missed", scheduled_at: Date.UTC(2026, 0, 1, 10, 1, 0) });

    // Normal service resumes at the next boundary after "now", exactly once.
    clock.advanceTo(Date.UTC(2026, 0, 1, 12, 1, 0));
    await Bun.sleep(0);
    expect(fireTimes(calls)).toEqual([Date.UTC(2026, 0, 1, 12, 1, 0)]);
  });

  test("a fire that is only a few seconds late still runs, once", async () => {
    useTZ("UTC");
    const start = Date.UTC(2026, 0, 1, 10, 0, 20);
    const { clock, calls, events, adapter } = scheduler(start);
    adapter.reconcile([makeJob("slightlylate", "* * * * *")]);

    clock.sleepThrough(Date.UTC(2026, 0, 1, 10, 1, 20)); // 20 s after the 10:01 fire
    await Bun.sleep(0);
    expect(fireTimes(calls)).toEqual([Date.UTC(2026, 0, 1, 10, 1, 0)]);
    expect(events.some((e) => e.kind === "missed")).toBe(false);

    clock.advanceTo(Date.UTC(2026, 0, 1, 10, 2, 0));
    await Bun.sleep(0);
    expect(calls.length).toBe(2);
  });

  test("a clock moved backwards does not replay earlier minutes", async () => {
    useTZ("UTC");
    const { clock, calls, adapter } = scheduler(Date.UTC(2026, 0, 1, 10, 0, 20));
    adapter.reconcile([makeJob("backwards", "* * * * *")]);
    clock.advanceTo(Date.UTC(2026, 0, 1, 10, 3, 0));
    await Bun.sleep(0);
    expect(calls.length).toBe(3);

    clock.nowMs = Date.UTC(2026, 0, 1, 9, 0, 0); // set back an hour
    clock.advanceTo(Date.UTC(2026, 0, 1, 10, 3, 30));
    await Bun.sleep(0);
    expect(calls.length).toBe(3); // nothing until wall time passes the next scheduled minute again
    clock.advanceTo(Date.UTC(2026, 0, 1, 10, 4, 0));
    await Bun.sleep(0);
    expect(calls.length).toBe(4);
  });

  test("stop() cancels pending timers; reconcile with a changed schedule replaces the old timer", async () => {
    useTZ("UTC");
    const { clock, calls, adapter } = scheduler(Date.UTC(2026, 0, 1, 10, 0, 20));
    adapter.reconcile([makeJob("swap", "* * * * *")]);
    expect(clock.timers.length).toBe(1);
    adapter.reconcile([makeJob("swap", "0 0 1 1 *")]);
    expect(clock.timers.length).toBe(1);
    clock.advanceTo(Date.UTC(2026, 0, 1, 10, 30, 0));
    await Bun.sleep(0);
    expect(calls.length).toBe(0); // the every-minute timer is gone

    adapter.stop();
    expect(clock.timers.length).toBe(0);
  });

  test("list() and the 'scheduled' event report the computed next fire time", () => {
    useTZ("America/New_York");
    const start = local(2026, 3, 7, 12);
    const { events, adapter } = scheduler(start);
    adapter.reconcile([makeJob("nextrun", "30 2 * * *")]);
    const expected = Date.UTC(2026, 2, 8, 7, 30); // 03:30 EDT on the spring-forward day
    expect(adapter.list()[0]!.next!.getTime()).toBe(expected);
    const scheduled = events.find((e) => e.kind === "scheduled");
    expect(scheduled && scheduled.kind === "scheduled" && scheduled.next?.getTime()).toBe(expected);
  });
});
