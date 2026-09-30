import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatDuration,
  formatRelative,
  formatTime,
  formatTimeWithZone,
  formatTimeoutMs,
  parseDurationInput,
  shortHash,
  shortId,
  timeZoneAbbreviation,
} from "../ui/src/util/format.ts";

describe("formatTimeoutMs", () => {
  test("keeps every unit, never rounds 90 minutes up to 2h", () => {
    expect(formatTimeoutMs(90 * 60_000)).toBe("1h 30m");
    expect(formatTimeoutMs(30 * 60_000)).toBe("30m");
    expect(formatTimeoutMs(2 * 3_600_000)).toBe("2h");
    expect(formatTimeoutMs(45_000)).toBe("45s");
    expect(formatTimeoutMs(90_000)).toBe("1m 30s");
    expect(formatTimeoutMs(26 * 3_600_000)).toBe("1d 2h");
    expect(formatTimeoutMs(3_630_000)).toBe("1h 30s");
  });
  test("edge cases", () => {
    expect(formatTimeoutMs(500)).toBe("500ms");
    expect(formatTimeoutMs(0)).toBe("—");
    expect(formatTimeoutMs(null)).toBe("—");
    expect(formatTimeoutMs(Number.NaN)).toBe("—");
  });
});

describe("formatTime", () => {
  test("uses a 24 hour clock and never prints 24:xx at midnight", () => {
    const midnight = Date.UTC(2026, 0, 5, 0, 7, 9);
    expect(formatTime(midnight, { timeZone: "UTC" })).toBe("2026-01-05 00:07:09");
    expect(formatTime(Date.UTC(2026, 0, 5, 23, 59, 59), { timeZone: "UTC" })).toBe("2026-01-05 23:59:59");
  });
  test("honours the requested zone", () => {
    const t = Date.UTC(2026, 6, 1, 12, 0, 0);
    expect(formatTime(t, { timeZone: "America/New_York" })).toBe("2026-07-01 08:00:00");
  });
  test("missing values are a dash", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
    expect(formatTime(Number.NaN)).toBe("—");
  });
  test("zone abbreviation is stated once and appended for tooltips", () => {
    const t = Date.UTC(2026, 6, 1, 12, 0, 0);
    expect(timeZoneAbbreviation(t, { timeZone: "America/New_York" })).toBe("EDT");
    expect(formatTimeWithZone(t, { timeZone: "America/New_York" })).toBe("2026-07-01 08:00:00 EDT");
    expect(formatTimeWithZone(null)).toBe("—");
  });
});

describe("formatRelative", () => {
  const now = 1_700_000_000_000;
  test("past", () => {
    expect(formatRelative(now - 5_000, now)).toBe("5s ago");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelative(now - 72 * 3_600_000, now)).toBe("3d ago");
  });
  test("future", () => {
    expect(formatRelative(now + 90_000, now)).toBe("in 1m");
    expect(formatRelative(now + 3 * 3_600_000, now)).toBe("in 3h");
  });
  test("small clock skew is not the future", () => {
    expect(formatRelative(now + 1_000, now)).toBe("just now");
  });
  test("a scheduled time a moment away is never 'just now'", () => {
    expect(formatRelative(now + 400, now, { upcoming: true })).toBe("now");
    expect(formatRelative(now + 1_500, now, { upcoming: true })).toBe("in 1s");
    expect(formatRelative(now + 5_000, now, { upcoming: true })).toBe("in 5s");
  });
  test("missing", () => {
    expect(formatRelative(null, now)).toBe("—");
  });
});

describe("formatDuration", () => {
  test("ranges", () => {
    expect(formatDuration(568)).toBe("568ms");
    expect(formatDuration(13_000)).toBe("13s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("ids", () => {
  const id = "01a0eee4-1c2d-7abc-8def-0123456789ab";
  test("short id is the last 8 hex digits, not the timestamp prefix", () => {
    expect(shortId(id)).toBe("456789ab");
    expect(shortId("01a0eee4-1c2d-7abc-8def-0123456789ac")).not.toBe(shortId(id));
  });
  test("short ids pass through", () => {
    expect(shortId("456789ab")).toBe("456789ab");
    expect(shortId(null)).toBe("—");
  });
  test("hash prefix", () => {
    expect(shortHash("abcdef0123456789")).toBe("abcdef01");
    expect(shortHash(null)).toBe("—");
  });
});

describe("formatBytes", () => {
  test("units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytes(null)).toBe("—");
  });
});

describe("parseDurationInput", () => {
  test("units", () => {
    expect(parseDurationInput("45m")).toBe(45 * 60_000);
    expect(parseDurationInput("2h30m")).toBe(150 * 60_000);
    expect(parseDurationInput("1d")).toBe(86_400_000);
    expect(parseDurationInput("90s")).toBe(90_000);
    expect(parseDurationInput("1.5h")).toBe(90 * 60_000);
    expect(parseDurationInput(" 1h 15m ")).toBe(75 * 60_000);
  });
  test("bare numbers are minutes", () => {
    expect(parseDurationInput("45")).toBe(45 * 60_000);
  });
  test("junk is null", () => {
    expect(parseDurationInput("")).toBeNull();
    expect(parseDurationInput("soon")).toBeNull();
    expect(parseDurationInput("5x")).toBeNull();
    expect(parseDurationInput("0m")).toBeNull();
    expect(parseDurationInput("h5")).toBeNull();
  });
});
