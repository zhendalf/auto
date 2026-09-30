import type { Automation, CronTrigger } from "../config.ts";
import type { ConditionEvaluator } from "../condition-evaluator.ts";
import type { Runner, EnqueueResult } from "../runner.ts";

// ---------------------------------------------------------------------------
// Cron semantics
//
// Schedules are five-field cron expressions (minute hour day-of-month month
// day-of-week) or one of @yearly/@annually, @monthly, @weekly, @daily/@midnight,
// @hourly. Rules, independent of the Bun version:
//
//  - Time zone: the machine's local time zone (TZ / system setting), always.
//    Bun.cron.parse is deliberately NOT used: its documented time zone changed
//    between Bun 1.3 (UTC) and 1.4 (local), and package.json allows both.
//  - Day matching follows the standard cron rule: when BOTH day-of-month and
//    day-of-week are restricted (neither starts with "*") a day matches if
//    EITHER matches; otherwise both must match. "0 0 1 * MON" is "the 1st, and
//    every Monday".
//  - Day-of-week accepts 0-7 (0 and 7 are Sunday) and SUN-SAT; months accept
//    JAN-DEC (case-insensitive). Lists (a,b), ranges (a-b), steps (*/n, a-b/n,
//    a/n) are supported. Ranges must ascend.
//  - Daylight saving time: a wall-clock time that does not exist (spring
//    forward gap) fires once, shifted by the length of the gap (02:30 becomes
//    03:30). A wall-clock time that happens twice (fall back) fires once, at
//    the first occurrence, except that schedules whose hour field is a
//    wildcard ("*" or "*/n") also fire in the repeated hour, so "every hour"
//    keeps its rhythm.
//  - Sleeping machine: fires missed while the machine was asleep (or the
//    process was otherwise stalled for more than a minute) are SKIPPED, not
//    replayed. After waking, the schedule resumes at the next fire time after
//    "now"; there is never a catch-up burst. A fire that is at most one minute
//    late still runs, once. That includes the first arm after the supervisor
//    starts: a start a moment after a minute boundary (the watchdog restarts
//    it on one) still runs the fire of that minute, unless a run for exactly
//    that fire is already recorded (a graceful restart right after it ran).
// ---------------------------------------------------------------------------

export type CronAdapterEvent =
  | { kind: "scheduled"; jobName: string; trigger_id: string; pattern: string; next: Date | null }
  | { kind: "fired"; jobName: string; trigger_id: string; fire_at: number; result: { kind: string } }
  | { kind: "missed"; jobName: string; trigger_id: string; scheduled_at: number; late_ms: number }
  | { kind: "quiet"; jobName: string; trigger_id: string; fire_at: number }
  | { kind: "suppressed"; jobName: string; trigger_id: string; fire_at: number }
  | { kind: "fire_error"; jobName: string; trigger_id: string; error: string }
  | { kind: "stopped"; jobName: string; trigger_id: string };

/** Time source, injectable so tests can simulate long waits, DST and sleep. */
export type CronClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type CronAdapterOptions = {
  runner: Runner;
  conditionEvaluator?: ConditionEvaluator;
  onEvent?: (ev: CronAdapterEvent) => void;
  /** Defaults to the real clock. */
  clock?: CronClock;
  /**
   * Enables the start-up catch-up: on the first `reconcile`, a fire at most
   * one minute in the past runs once, unless this says a run for that exact
   * fire (`trigger_id` is `<job>:<trigger id>`) already exists.
   */
  alreadyRan?: (triggerId: string, fireAt: number) => boolean;
};

type CronJobHandle = { stop(): unknown };
type ScheduledEntry = {
  cron: CronSchedule;
  signature: string;
  job: Automation;
  trigger: CronTrigger;
  trigger_id: string;
};

/**
 * The wall clock is re-checked at least this often, however far away the next
 * fire is. That keeps every timer delay far below the 2^31-1 ms (~24.8 days)
 * limit past which setTimeout fires after 1 ms (a yearly schedule would
 * otherwise fire immediately), and bounds how stale a timer can be after the
 * machine sleeps or the system clock is changed.
 */
const MAX_WAIT_MS = 30_000;

/** A fire more than this late is treated as missed (see "Sleeping machine" above). */
const MISSED_FIRE_TOLERANCE_MS = 60_000;

const REAL_CLOCK: CronClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function namespacedTriggerId(jobName: string, triggerId: string): string {
  return `${jobName}:${triggerId}`;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * One trigger's timer loop. Computes the next fire instant itself and waits
 * for it in bounded chunks, comparing against the wall clock every time.
 */
class CronSchedule implements CronJobHandle {
  nextAt: number | null = null;
  private timer: unknown = null;
  private stopped = false;

  constructor(
    private readonly schedule: string,
    private readonly clock: CronClock,
    private readonly onFire: (scheduledAt: number) => void,
    private readonly onMissed: (scheduledAt: number, lateMs: number) => void,
  ) {}

  /**
   * `catchUp`: when the last fire at or before now is at most this many ms in
   * the past and `alreadyRan` does not know it, arm that fire (it runs at once).
   */
  start(catchUp?: { ms: number; alreadyRan: (fireAt: number) => boolean }): void {
    const now = this.clock.now();
    let from = now;
    if (catchUp) {
      const missed = nextCronFire(this.schedule, now - catchUp.ms);
      if (missed !== null && missed <= now && !catchUp.alreadyRan(missed)) from = now - catchUp.ms;
    }
    this.armFrom(from);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armFrom(from: number): void {
    this.nextAt = nextCronFire(this.schedule, from);
    if (this.nextAt !== null) this.wait();
  }

  private wait(): void {
    const remaining = this.nextAt! - this.clock.now();
    const delay = Math.min(Math.max(remaining, 0), MAX_WAIT_MS);
    this.timer = this.clock.setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped || this.nextAt === null) return;
    const now = this.clock.now();
    const due = this.nextAt;
    if (now < due) {
      // Early wake-up, an intermediate chunk of a long wait, or the clock was
      // moved back: keep waiting.
      this.wait();
      return;
    }
    const late = now - due;
    if (late > MISSED_FIRE_TOLERANCE_MS) {
      this.onMissed(due, late);
    } else {
      try {
        this.onFire(due);
      } catch {
        // handlers report their own errors; never break the schedule
      }
    }
    // Strictly after both the fire we just handled and "now": no double fire,
    // no replay of anything in between.
    if (!this.stopped) this.armFrom(Math.max(now, due));
  }
}

export class CronAdapter {
  private readonly entries = new Map<string, ScheduledEntry>();
  private readonly onEvent: (ev: CronAdapterEvent) => void;
  private readonly clock: CronClock;
  /** The next `reconcile` is the first since start (see `alreadyRan`). */
  private startingUp = true;

  constructor(private readonly opts: CronAdapterOptions) {
    this.onEvent = opts.onEvent ?? (() => {});
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  reconcile(jobs: Automation[]): void {
    const desired = new Set<string>();
    for (const job of jobs) {
      for (const candidate of job.triggers) {
        if (candidate.kind !== "cron") continue;
        const trigger = candidate;
        const key = namespacedTriggerId(job.name, trigger.id);
        const signature = JSON.stringify(trigger);
        desired.add(key);
        const existing = this.entries.get(key);
        if (existing?.signature === signature) continue;
        existing?.cron.stop();
        this.entries.delete(key);
        this.schedule(job, trigger, signature);
      }
    }
    for (const [key, entry] of [...this.entries]) {
      if (desired.has(key)) continue;
      entry.cron.stop();
      this.entries.delete(key);
      this.onEvent({ kind: "stopped", jobName: entry.job.name, trigger_id: entry.trigger_id });
    }
    this.startingUp = false;
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      entry.cron.stop();
      this.onEvent({ kind: "stopped", jobName: entry.job.name, trigger_id: entry.trigger_id });
    }
    this.entries.clear();
  }

  list(): { jobName: string; trigger_id: string; pattern: string; next: Date | null }[] {
    return [...this.entries.values()].map((entry) => ({
      jobName: entry.job.name,
      trigger_id: entry.trigger_id,
      pattern: entry.trigger.schedule,
      next: entry.cron.nextAt === null ? null : new Date(entry.cron.nextAt),
    }));
  }

  _get(jobName: string, triggerId: string): CronJobHandle | undefined {
    return this.entries.get(namespacedTriggerId(jobName, triggerId))?.cron;
  }

  async _fire(jobName: string, triggerId: string, fireAt = Date.now()): Promise<void> {
    const entry = this.entries.get(namespacedTriggerId(jobName, triggerId));
    if (!entry) throw new Error(`cron not scheduled: ${jobName}:${triggerId}`);
    await this.fire(entry.job, entry.trigger, fireAt);
  }

  private schedule(job: Automation, trigger: CronTrigger, signature: string): void {
    const triggerId = namespacedTriggerId(job.name, trigger.id);
    const cron = new CronSchedule(
      trigger.schedule,
      this.clock,
      (scheduledAt) => {
        void this.fire(job, trigger, scheduledAt);
      },
      (scheduledAt, lateMs) => {
        this.onEvent({ kind: "missed", jobName: job.name, trigger_id: triggerId, scheduled_at: scheduledAt, late_ms: lateMs });
      },
    );
    this.entries.set(triggerId, { cron, signature, job, trigger, trigger_id: triggerId });
    const alreadyRan = this.opts.alreadyRan;
    cron.start(
      this.startingUp && alreadyRan
        ? { ms: MISSED_FIRE_TOLERANCE_MS, alreadyRan: (fireAt) => alreadyRan(triggerId, fireAt) }
        : undefined,
    );
    this.onEvent({
      kind: "scheduled",
      jobName: job.name,
      trigger_id: triggerId,
      pattern: trigger.schedule,
      next: cron.nextAt === null ? null : new Date(cron.nextAt),
    });
  }

  private async fire(job: Automation, trigger: CronTrigger, fireAt: number): Promise<void> {
    const triggerId = namespacedTriggerId(job.name, trigger.id);
    try {
      if (trigger.condition && this.opts.conditionEvaluator) {
        const evaluated = await this.opts.conditionEvaluator.evaluate(job, trigger, fireAt);
        if (evaluated.kind === "quiet" || evaluated.kind === "suppressed") {
          this.onEvent({ kind: evaluated.kind, jobName: job.name, trigger_id: triggerId, fire_at: fireAt });
          return;
        }
        if (evaluated.kind === "error") throw new Error(evaluated.error);
        this.emitFired(job.name, triggerId, fireAt, evaluated.enqueue);
        return;
      }
      const result = await this.opts.runner.enqueue(job.name, {
        kind: "cron",
        trigger_id: trigger.id,
        fire_at: fireAt,
      });
      this.emitFired(job.name, triggerId, fireAt, result);
    } catch (err) {
      this.onEvent({ kind: "fire_error", jobName: job.name, trigger_id: triggerId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private emitFired(jobName: string, triggerId: string, fireAt: number, result: EnqueueResult): void {
    this.onEvent({ kind: "fired", jobName, trigger_id: triggerId, fire_at: fireAt, result: { kind: result.kind } });
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function validateCronExpression(pattern: string): void {
  if (typeof pattern !== "string" || pattern.trim().length === 0) throw new Error("cron pattern is empty");
  const trimmed = pattern.trim();
  if (!trimmed.startsWith("@") && trimmed.split(/\s+/).length !== 5) {
    throw new Error(`cron pattern must be 5 fields, got ${JSON.stringify(pattern)}`);
  }
  try {
    const parsed = parseCron(trimmed);
    if (nextFireFrom(parsed, Date.now()) === null) throw new Error("no future occurrence");
  } catch (err) {
    throw new Error(`invalid cron pattern ${JSON.stringify(pattern)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Epoch milliseconds of the first fire strictly after `from` (default: now),
 * in the machine's local time zone (see "Cron semantics" above), or null if
 * the expression is invalid or never fires (for example "0 0 31 2 *").
 * Use validateCronExpression to get the reason for an invalid one.
 */
export function nextCronFire(schedule: string, from: number = Date.now()): number | null {
  const parsed = parseCached(schedule);
  if (!parsed) return null;
  return nextFireFrom(parsed, from);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type ParsedCron = {
  minutes: number[];
  hours: number[];
  /** Days of month 1-31. */
  doms: Set<number>;
  /** Months 1-12. */
  months: Set<number>;
  /** Days of week 0-6 (7 already folded into 0). */
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** Hour field starts with "*": repeated DST hours fire again. */
  hourWildcard: boolean;
};

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseCron(pattern: string): ParsedCron {
  let expr = pattern.trim();
  if (expr.startsWith("@")) {
    const macro = MACROS[expr.toLowerCase()];
    if (!macro) throw new Error(`unrecognized macro ${expr}`);
    expr = macro;
  }
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron pattern must be 5 fields, got ${JSON.stringify(pattern)}`);
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  const dows = new Set(parseField(dowF, "day-of-week", 0, 7, DOW_NAMES, [0, 6]).map((v) => (v === 7 ? 0 : v)));
  return {
    minutes: parseField(minF, "minute", 0, 59),
    hours: parseField(hourF, "hour", 0, 23),
    doms: new Set(parseField(domF, "day-of-month", 1, 31)),
    months: new Set(parseField(monF, "month", 1, 12, MONTH_NAMES)),
    dows,
    domRestricted: !domF.startsWith("*"),
    dowRestricted: !dowF.startsWith("*"),
    hourWildcard: hourF.startsWith("*"),
  };
}

function parseField(
  text: string,
  label: string,
  lo: number,
  hi: number,
  names?: Record<string, number>,
  starRange: [number, number] = [lo, hi],
): number[] {
  const values = new Set<number>();
  const fail = (why: string): never => {
    throw new Error(`invalid ${label} field ${JSON.stringify(text)}: ${why}`);
  };
  const value = (token: string): number => {
    let n: number;
    if (/^\d+$/.test(token)) n = Number(token);
    else if (names && token.toLowerCase() in names) n = names[token.toLowerCase()]!;
    else return fail(`unrecognized value ${JSON.stringify(token)}`);
    if (n < lo || n > hi) fail(`value ${n} out of range ${lo}-${hi}`);
    return n;
  };

  for (const item of text.split(",")) {
    if (item.length === 0) fail("empty list item");
    const [base, stepText, ...extra] = item.split("/");
    if (extra.length > 0) fail(`bad step in ${JSON.stringify(item)}`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) fail("step must be a positive integer");
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (base === "*") {
      [from, to] = starRange;
    } else if (base!.includes("-")) {
      const parts = base!.split("-");
      if (parts.length !== 2) return fail(`bad range ${JSON.stringify(base)}`);
      from = value(parts[0]!);
      to = value(parts[1]!);
      if (from > to) fail(`range ${JSON.stringify(base)} must ascend`);
    } else {
      from = value(base!);
      to = stepText === undefined ? from : hi;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

const parseCache = new Map<string, ParsedCron | null>();

function parseCached(schedule: string): ParsedCron | null {
  if (typeof schedule !== "string") return null;
  const key = schedule.trim();
  if (parseCache.has(key)) return parseCache.get(key)!;
  let parsed: ParsedCron | null;
  try {
    parsed = parseCron(key);
  } catch {
    parsed = null;
  }
  if (parseCache.size >= 256) parseCache.clear();
  parseCache.set(key, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Next-fire computation
// ---------------------------------------------------------------------------

/** Longest possible gap between fires of a satisfiable schedule is 8 years (Feb 29 across a skipped leap year). */
const SEARCH_DAYS = 366 * 9;

function nextFireFrom(p: ParsedCron, from: number): number | null {
  if (!Number.isFinite(from)) return null;
  const start = new Date(from);
  const y = start.getFullYear();
  const m = start.getMonth();
  const d = start.getDate();
  for (let i = 0; i < SEARCH_DAYS; i++) {
    // Noon keeps this away from every DST edge, so the calendar fields are exact.
    const day = new Date(y, m, d + i, 12);
    if (!p.months.has(day.getMonth() + 1)) continue;
    const domOk = p.doms.has(day.getDate());
    const dowOk = p.dows.has(day.getDay());
    const matches = p.domRestricted && p.dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (!matches) continue;
    const t = firstFireOnDay(p, day.getFullYear(), day.getMonth(), day.getDate(), from, i === 0 ? start : null);
    if (t !== null) return t;
  }
  return null;
}

function offsetAt(y: number, m: number, d: number, h: number, mi: number): number {
  return new Date(y, m, d, h, mi).getTimezoneOffset();
}

/** Earliest fire on the given local calendar day that is strictly after `from`. */
function firstFireOnDay(
  p: ParsedCron,
  y: number,
  m: number,
  d: number,
  from: number,
  fromDate: Date | null,
): number | null {
  const transition = offsetAt(y, m, d - 1, 23, 59) !== offsetAt(y, m, d, 23, 59);

  if (!transition) {
    // Wall time maps 1:1 to instants today and increases with it, so the first
    // candidate after `from` is the answer.
    const fromHour = fromDate ? fromDate.getHours() : 0;
    const fromMinute = fromDate ? fromDate.getMinutes() : -1;
    for (const h of p.hours) {
      if (h < fromHour) continue;
      for (const mi of p.minutes) {
        if (h === fromHour && mi <= fromMinute) continue;
        const t = new Date(y, m, d, h, mi).getTime();
        if (t > from) return t;
      }
    }
    return null;
  }

  // DST change day. `new Date(y, m, d, h, mi)` resolves a wall time inside the
  // spring-forward gap to the shifted instant (02:30 -> 03:30) and a repeated
  // wall time to its first occurrence; that gives the fixed-hour behavior
  // documented above. Wildcard-hour schedules additionally fire in the
  // repeated hour. Candidates are not monotonic here, so take the minimum.
  let best: number | null = null;
  const consider = (t: number) => {
    if (t > from && (best === null || t < best)) best = t;
  };
  for (const h of p.hours) {
    for (const mi of p.minutes) {
      const t = new Date(y, m, d, h, mi).getTime();
      consider(t);
      if (p.hourWildcard) {
        for (const delta of [30 * 60_000, 60 * 60_000, 120 * 60_000]) {
          const again = new Date(t + delta);
          if (again.getDate() === d && again.getMonth() === m && again.getHours() === h && again.getMinutes() === mi) {
            consider(again.getTime());
          }
        }
      }
    }
  }
  return best;
}
