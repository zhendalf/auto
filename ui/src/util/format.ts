/**
 * Pure formatting helpers used across the UI. No DOM or React access here so
 * components stay simple and these stay trivially testable. Functions that
 * depend on the clock take an optional `now`, and those that depend on the
 * time zone an optional `timeZone`, so tests do not need to fake either.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // h23, not hour12:false: some engines render midnight as "24:xx" with
      // the latter.
      hourCycle: "h23",
      timeZone,
    });
    formatters.set(key, fmt);
  }
  return fmt;
}

/** Render an absolute local timestamp like "2026-04-30 22:14:01". */
export function formatTime(
  epochMs: number | null | undefined,
  opts: { timeZone?: string } = {},
): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return "—";
  // Reassemble the parts so the layout is the same in every locale.
  const parts = timeFormatter(opts.timeZone).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * The zone the timestamps are shown in, like "PDT" or "GMT+2". It is stated
 * once (footer, tooltips) instead of on every cell.
 */
export function timeZoneAbbreviation(
  epochMs: number = Date.now(),
  opts: { timeZone?: string } = {},
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: opts.timeZone,
  }).formatToParts(new Date(epochMs));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** Absolute time with the zone, for tooltips: "2026-04-30 22:14:01 PDT". */
export function formatTimeWithZone(
  epochMs: number | null | undefined,
  opts: { timeZone?: string } = {},
): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return "—";
  const zone = timeZoneAbbreviation(epochMs, opts);
  return `${formatTime(epochMs, opts)}${zone ? ` ${zone}` : ""}`;
}

/**
 * Coarse "5s ago" / "12m ago" / "3h ago" / "2d ago", or "in 5m" for a time
 * that has not happened yet (a next run, a pause that is still running).
 */
export function formatRelative(
  epochMs: number | null | undefined,
  now: number = Date.now(),
  opts: { upcoming?: boolean } = {},
): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return "—";
  const delta = now - epochMs;
  const future = delta < 0;
  const sec = Math.floor(Math.abs(delta) / 1000);
  if (future && sec < 2) {
    // For a scheduled time, being about to happen is the truth. For something
    // that already happened, a browser clock a moment behind the supervisor's
    // must not read as "in the future".
    return opts.upcoming ? (sec < 1 ? "now" : `in ${sec}s`) : "just now";
  }
  const text = coarseSpan(sec);
  return future ? `in ${text}` : `${text} ago`;
}

function coarseSpan(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Render a duration as "568ms" / "13s" / "3m12s" / "1h23m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h${min}m` : `${hr}h`;
}

/**
 * Every non-zero unit of a limit, so a 90 minute timeout reads "1h 30m" and
 * never a rounded "2h": "45s", "1m 30s", "1h 30m", "2h", "1d 2h".
 * Sub-second remainders are dropped except for values under one second.
 */
export function formatTimeoutMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  let sec = Math.floor(ms / 1000);
  const units: [string, number][] = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ];
  const out: string[] = [];
  for (const [label, size] of units) {
    const n = Math.floor(sec / size);
    if (n > 0) out.push(`${n}${label}`);
    sec -= n * size;
  }
  return out.join(" ");
}

/**
 * The id shown everywhere except the run page's header: the last 8 hex digits
 * of the UUID. The leading digits of a UUIDv7 are timestamp bits, so runs
 * started in the same minute would all share a prefix.
 */
export function shortId(uuid: string | null | undefined): string {
  if (!uuid) return "—";
  const hex = uuid.replace(/-/g, "");
  return hex.length <= 8 ? hex : hex.slice(-8);
}

/** First 8 characters of a content hash. Unlike ids, hashes have no timestamp prefix. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.length <= 8 ? hash : hash.slice(0, 8);
}

/** "1.5 MiB" style byte counts for log sizes. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Parse a duration typed by a person: "45m", "2h30m", "1d", "90s", "1.5h", or
 * a bare number of minutes ("45"). Returns milliseconds, or null when the
 * text is not a duration.
 */
export function parseDurationInput(text: string): number | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60_000);
  const re = /(\d+(?:\.\d+)?)(d|h|m|s)/y;
  const perUnit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  let pos = 0;
  while (pos < raw.length) {
    re.lastIndex = pos;
    const m = re.exec(raw);
    if (!m) return null;
    total += Number(m[1]) * perUnit[m[2]!]!;
    pos = re.lastIndex;
  }
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}
