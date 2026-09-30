import { describe, expect, test } from "bun:test";
import { PAUSE_MAX_MS, PAUSE_PRESETS, resolvePause } from "../ui/src/util/pause.ts";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("resolvePause", () => {
  test("presets pass through and are all within the API's bounds", () => {
    expect(resolvePause({ mode: "preset", ms: 3_600_000 }, NOW)).toEqual({ ok: true, durationMs: 3_600_000 });
    for (const p of PAUSE_PRESETS) expect(p.ms).toBeLessThanOrEqual(PAUSE_MAX_MS);
  });

  test("custom durations", () => {
    expect(resolvePause({ mode: "custom", text: "2h30m" }, NOW)).toEqual({ ok: true, durationMs: 150 * 60_000 });
    expect(resolvePause({ mode: "custom", text: "45" }, NOW)).toEqual({ ok: true, durationMs: 45 * 60_000 });
  });

  test("custom durations are validated", () => {
    expect(resolvePause({ mode: "custom", text: "later" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePause({ mode: "custom", text: "" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePause({ mode: "custom", text: "400d" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("one year") });
    expect(resolvePause({ mode: "custom", text: "0.1s" }, NOW)).toMatchObject({ ok: false });
  });

  test("until: a future local time becomes an ISO instant", () => {
    const local = "2026-06-02T09:30";
    const r = resolvePause({ mode: "until", local }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.untilIso).toBe(new Date(local).toISOString());
  });

  test("until: rejects empty, invalid, past and too-far times", () => {
    expect(resolvePause({ mode: "until", local: "" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePause({ mode: "until", local: "not a date" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePause({ mode: "until", local: "2020-01-01T00:00" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("future") });
    expect(resolvePause({ mode: "until", local: "2030-01-01T00:00" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("year") });
  });
});
