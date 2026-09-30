import { describe, expect, test } from "bun:test";
import { idleReason, isPausedAt, jobChips, nextRunAt, triggerBadges, triggerLocalId } from "../ui/src/util/jobs.ts";

const NOW = 1_700_000_000_000;
const base = { enabled: true, paused_until: null as number | null, config_enabled: true, active_run: null };

describe("jobChips", () => {
  test("plain enabled job", () => {
    expect(jobChips(base, NOW).map((c) => c.label)).toEqual(["enabled"]);
  });
  test("running shows first, with the live marker, and replaces 'enabled'", () => {
    const chips = jobChips({ ...base, active_run: { run_id: "r", state: "running", started_at: NOW } }, NOW);
    expect(chips.map((c) => c.label)).toEqual(["running"]);
    expect(chips[0]!.live).toBe(true);
  });
  test("running and disabled are both shown", () => {
    const chips = jobChips({ ...base, enabled: false, active_run: { run_id: "r", state: "running", started_at: NOW } }, NOW);
    expect(chips.map((c) => c.label)).toEqual(["running", "disabled"]);
  });
  test("queued", () => {
    expect(jobChips({ ...base, active_run: { run_id: "r", state: "queued", started_at: null } }, NOW)[0]!.label).toBe("queued");
  });
  test("config-disabled and paused", () => {
    expect(jobChips({ ...base, config_enabled: false }, NOW).map((c) => c.label)).toEqual(["off in config"]);
    expect(jobChips({ ...base, paused_until: NOW + 60_000 }, NOW).map((c) => c.label)).toEqual(["paused"]);
  });
  test("an expired pause is no pause", () => {
    expect(jobChips({ ...base, paused_until: NOW - 1 }, NOW).map((c) => c.label)).toEqual(["enabled"]);
    expect(isPausedAt(NOW - 1, NOW)).toBe(false);
    expect(isPausedAt(null, NOW)).toBe(false);
    expect(isPausedAt(NOW + 1, NOW)).toBe(true);
  });
  test("config_enabled missing (older supervisor) counts as on", () => {
    expect(jobChips({ enabled: true, paused_until: null }, NOW).map((c) => c.label)).toEqual(["enabled"]);
  });
});

describe("idleReason", () => {
  test("priority: disabled, off in config, paused", () => {
    expect(idleReason({ ...base, enabled: false, paused_until: NOW + 1 }, NOW)).toBe("disabled");
    expect(idleReason({ ...base, config_enabled: false }, NOW)).toBe("off in config");
    expect(idleReason({ ...base, paused_until: NOW + 1 }, NOW)).toBe("paused");
    expect(idleReason(base, NOW)).toBeNull();
  });
});

describe("triggers", () => {
  test("local id is everything after the first colon", () => {
    expect(triggerLocalId("backup:nightly")).toBe("nightly");
    expect(triggerLocalId("nightly")).toBe("nightly");
  });
  test("next run is the soonest across cron triggers, ignoring null and missing", () => {
    expect(nextRunAt([{ next_run_at: null }, { next_run_at: 300 }, { next_run_at: 200 }, {}])).toBe(200);
    expect(nextRunAt([])).toBeNull();
    expect(nextRunAt([{ next_run_at: null }])).toBeNull();
  });
  test("badges mark switched-off triggers and group repeats", () => {
    expect(
      triggerBadges([
        { kind: "cron", enabled: true },
        { kind: "webhook", enabled: false },
        { kind: "cron", enabled: true },
        { kind: "cron", enabled: false },
      ]),
    ).toEqual([
      { kind: "cron", off: false, count: 2, label: "cron \u00d72" },
      { kind: "webhook", off: true, count: 1, label: "webhook (off)" },
      { kind: "cron", off: true, count: 1, label: "cron (off)" },
    ]);
  });
});
