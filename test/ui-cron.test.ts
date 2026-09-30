import { describe, expect, test } from "bun:test";
import { describeCron } from "../ui/src/util/cron.ts";
import { filterRunsByText, parseLimitParam, parseStateParam } from "../ui/src/util/runsFilter.ts";

describe("describeCron", () => {
  const cases: [string, string | null][] = [
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/1 * * * *", "Every 1 minute"],
    ["0 * * * *", "Every hour, on the hour"],
    ["30 * * * *", "Every hour at :30"],
    ["0 */2 * * *", "Every 2 hours"],
    ["15 */6 * * *", "Every 6 hours at :15"],
    ["30 9 * * *", "Daily at 09:30"],
    ["0 9,17 * * *", "Daily at 09:00 and 17:00"],
    ["0 8 * * 1-5", "Weekdays at 08:00"],
    ["0 10 * * 6,0", "Weekends at 10:00"],
    ["0 7 * * 1", "On Mondays at 07:00"],
    ["0 7 * * 1,3,5", "On Mon, Wed and Fri at 07:00"],
    ["0 0 1 * *", "Monthly on the 1st at 00:00"],
    ["0 6 1,15 * *", "Monthly on the 1st and 15th at 06:00"],
    ["0 0 25 12 *", "On 25th of Dec, at 00:00"],
    ["@hourly", "Every hour, on the hour"],
    ["@daily", "Daily at 00:00"],
    ["@weekly", "On Sundays at 00:00"],
    // Not phrased: the raw expression is shown instead.
    ["0 0 1 * 1", null],
    ["0-30/5 * * * *", null],
    ["nonsense", null],
    ["", null],
  ];
  for (const [expr, expected] of cases) {
    test(`${JSON.stringify(expr)}`, () => {
      expect(describeCron(expr)).toBe(expected);
    });
  }
  test("null and undefined", () => {
    expect(describeCron(null)).toBeNull();
    expect(describeCron(undefined)).toBeNull();
  });
});

describe("runs filter", () => {
  test("state param must be a real state", () => {
    expect(parseStateParam("failed")).toBe("failed");
    expect(parseStateParam("bogus")).toBe("");
    expect(parseStateParam(null)).toBe("");
    expect(parseStateParam("lost")).toBe("");
  });

  test("limit param falls back to the default", () => {
    expect(parseLimitParam("100")).toBe(100);
    expect(parseLimitParam("7")).toBe(50);
    expect(parseLimitParam(null)).toBe(50);
    expect(parseLimitParam("abc")).toBe(50);
  });

  const rows = [
    { run_id: "01a0eee4-1c2d-7abc-8def-0123456789ab", job_name: "backup", trigger_kind: "cron", trigger_id: "backup:nightly", state: "failed" },
    { run_id: "01a0eee5-0000-7000-8000-00000000cafe", job_name: "sync files", trigger_kind: "manual", trigger_id: null, state: "succeeded" },
  ];
  test("matches job name, short id, state and trigger; all words must match", () => {
    expect(filterRunsByText(rows, "")).toBe(rows);
    expect(filterRunsByText(rows, "BACKUP")).toEqual([rows[0]!]);
    expect(filterRunsByText(rows, "456789ab")).toEqual([rows[0]!]);
    expect(filterRunsByText(rows, "cafe")).toEqual([rows[1]!]);
    expect(filterRunsByText(rows, "sync files")).toEqual([rows[1]!]);
    expect(filterRunsByText(rows, "backup succeeded")).toEqual([]);
    expect(filterRunsByText(rows, "nightly")).toEqual([rows[0]!]);
    expect(filterRunsByText(rows, "manual")).toEqual([rows[1]!]);
  });
});
