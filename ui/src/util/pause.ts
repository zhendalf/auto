import { parseDurationInput } from "./format.ts";

/** The API accepts pauses from one second to one year. */
export const PAUSE_MIN_MS = 1_000;
export const PAUSE_MAX_MS = 31_536_000_000;

export const PAUSE_PRESETS: { label: string; ms: number }[] = [
  { label: "30 minutes", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "4 hours", ms: 4 * 60 * 60_000 },
  { label: "12 hours", ms: 12 * 60 * 60_000 },
  { label: "24 hours", ms: 24 * 60 * 60_000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000 },
];

export type PauseChoice =
  | { mode: "preset"; ms: number }
  | { mode: "custom"; text: string }
  /** `local` is the value of an `<input type="datetime-local">`, e.g. "2026-09-30T14:30". */
  | { mode: "until"; local: string };

export type PauseRequestBody =
  | { ok: true; durationMs: number; untilIso?: undefined }
  | { ok: true; untilIso: string; durationMs?: undefined }
  | { ok: false; error: string };

/** Turn what the person picked into an API body, or say what is wrong with it. */
export function resolvePause(choice: PauseChoice, now: number): PauseRequestBody {
  if (choice.mode === "preset") return { ok: true, durationMs: choice.ms };

  if (choice.mode === "custom") {
    const ms = parseDurationInput(choice.text);
    if (ms === null) return { ok: false, error: "Enter a duration like 45m, 2h30m or 1d." };
    if (ms < PAUSE_MIN_MS) return { ok: false, error: "Pause for at least one second." };
    if (ms > PAUSE_MAX_MS) return { ok: false, error: "Pause for at most one year." };
    return { ok: true, durationMs: ms };
  }

  if (!choice.local) return { ok: false, error: "Pick the date and time to pause until." };
  const t = new Date(choice.local).getTime();
  if (!Number.isFinite(t)) return { ok: false, error: "That date and time is not valid." };
  if (t <= now) return { ok: false, error: "Pick a time in the future." };
  if (t > now + PAUSE_MAX_MS) return { ok: false, error: "Pick a time within the next year." };
  return { ok: true, untilIso: new Date(t).toISOString() };
}

/** The soonest pause end after `now` among these jobs, or null when none is still in the future. */
export function nextPauseExpiry(pausedUntil: Iterable<number | null | undefined>, now: number): number | null {
  let best: number | null = null;
  for (const at of pausedUntil) {
    if (typeof at === "number" && at > now && (best === null || at < best)) best = at;
  }
  return best;
}

/** setTimeout cannot wait longer than this (2^31 - 1 ms); longer waits fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long to wait so a timer fires just after `expiry`: the small pad keeps it
 * from firing a hair early, and the cap keeps a year-long pause from overflowing.
 */
export function expiryDelayMs(expiry: number, now: number, padMs = 300): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, expiry - now) + padMs);
}
