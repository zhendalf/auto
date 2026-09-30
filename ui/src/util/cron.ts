/**
 * A human phrase for the common shapes of a five-field cron expression
 * ("Every 15 minutes", "Daily at 09:30", "Weekdays at 08:00"). Best effort:
 * anything it does not recognise returns null and callers show the raw
 * expression, which is always displayed next to the phrase anyway.
 */

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const plural = (n: number, unit: string) => (n === 1 ? unit : `${unit}s`);

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** A plain list of numbers ("1,15") or a single one. Null for ranges, steps and names. */
function numberList(field: string, min: number, max: number): number[] | null {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  const values = field.split(",").map(Number);
  return values.every((v) => v >= min && v <= max) ? values : null;
}

/** A step field such as `*` + `/15`, as 15, or null. */
function everyStep(field: string, max: number): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Day-of-week field to words, or null when it is not a shape we phrase. */
function weekdays(field: string): string | null {
  const norm = field.toLowerCase();
  const names: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const toNum = (t: string): number | null => {
    if (/^\d+$/.test(t)) {
      const n = Number(t) === 7 ? 0 : Number(t);
      return n >= 0 && n <= 6 ? n : null;
    }
    return names[t] ?? null;
  };
  if (norm === "1-5" || norm === "mon-fri") return "weekdays";
  if (norm === "0,6" || norm === "6,0" || norm === "sat,sun" || norm === "sun,sat" || norm === "6,7") {
    return "weekends";
  }
  const parts = norm.split(",");
  const days: number[] = [];
  for (const p of parts) {
    const n = toNum(p);
    if (n === null) return null;
    days.push(n);
  }
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 1) return `${DAY_NAMES[sorted[0]!]}s`;
  return joinList(sorted.map((d) => DAY_ABBR[d]!));
}

export function describeCron(expression: string | null | undefined): string | null {
  if (!expression) return null;
  const trimmed = expression.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const f = expanded.split(/\s+/);
  if (f.length !== 5) return null;
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];

  let when: string | null = null; // the time-of-day part
  const fixedMinute = /^\d+$/.test(minute) ? Number(minute) : null;
  const hours = numberList(hour, 0, 23);
  const minutes = numberList(minute, 0, 59);

  if (minute === "*" && hour === "*") {
    when = "every minute";
  } else if (everyStep(minute, 59) !== null && hour === "*") {
    const n = everyStep(minute, 59)!;
    when = `every ${n} ${plural(n, "minute")}`;
  } else if (fixedMinute !== null && fixedMinute <= 59 && hour === "*") {
    when = fixedMinute === 0 ? "every hour, on the hour" : `every hour at :${pad(fixedMinute)}`;
  } else if (fixedMinute !== null && fixedMinute <= 59 && everyStep(hour, 23) !== null) {
    const n = everyStep(hour, 23)!;
    when = `every ${n} ${plural(n, "hour")}${fixedMinute === 0 ? "" : ` at :${pad(fixedMinute)}`}`;
  } else if (minutes && hours) {
    const times: string[] = [];
    for (const h of hours) for (const m of minutes) times.push(`${pad(h)}:${pad(m)}`);
    if (times.length > 6) return null;
    when = `at ${joinList(times)}`;
  } else {
    return null;
  }

  const isTimeOfDay = when.startsWith("at ");
  const anyDom = dom === "*";
  const anyMonth = month === "*";
  const anyDow = dow === "*";

  let scope = "";
  if (anyDom && anyMonth && anyDow) {
    scope = isTimeOfDay ? "Daily " : "";
  } else if (anyDom && anyMonth) {
    const w = weekdays(dow);
    if (!w) return null;
    scope = w === "weekdays" || w === "weekends" ? `${cap(w)} ` : `On ${w} `;
  } else if (anyDow && anyMonth) {
    const days = numberList(dom, 1, 31);
    if (!days) return null;
    scope = `Monthly on the ${joinList(days.map(ordinal))} `;
  } else if (anyDow) {
    const days = numberList(dom, 1, 31);
    const months = numberList(month, 1, 12);
    if (!days || !months) return null;
    scope = `On ${joinList(days.map(ordinal))} of ${joinList(months.map((m) => MONTHS[m - 1]!))}, `;
  } else {
    // Day-of-month and day-of-week both set: cron runs on either. Say so.
    return null;
  }

  if (!scope) return cap(when);
  return `${scope}${when}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
