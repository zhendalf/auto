/** Filtering helpers for the Runs page. Pure, so the URL handling is testable. */

export const RUN_STATES = [
  "succeeded",
  "failed",
  "timed_out",
  "killed",
  "cancelled",
  "skipped",
  "queued",
  "running",
] as const;
export type RunStateName = (typeof RUN_STATES)[number];

export const PAGE_SIZES = [20, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** The state filter from `?state=`, or "" when it is missing or not a real state. */
export function parseStateParam(raw: string | null): RunStateName | "" {
  return (RUN_STATES as readonly string[]).includes(raw ?? "") ? (raw as RunStateName) : "";
}

/** The page size from `?limit=`, falling back to the default for anything unlisted. */
export function parseLimitParam(raw: string | null): number {
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

type Filterable = {
  run_id: string;
  job_name: string;
  trigger_kind: string;
  trigger_id: string | null;
  state: string;
};

/**
 * Client-side text filter over the rows already loaded: every space-separated
 * word must appear in the job name, the run id (with or without hyphens, so
 * the short id matches), the state or the trigger.
 */
export function filterRunsByText<T extends Filterable>(runs: T[], text: string): T[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return runs;
  return runs.filter((r) => {
    const hay = [
      r.job_name,
      r.run_id,
      r.run_id.replace(/-/g, ""),
      r.state,
      r.trigger_kind,
      r.trigger_id ?? "",
    ]
      .join("\n")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
