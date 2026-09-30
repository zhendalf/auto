import type { ActiveRun, Job, Trigger } from "../api/types.ts";

/** Whether a pause is still in force at `now`. */
export function isPausedAt(pausedUntil: number | null | undefined, now: number): boolean {
  return pausedUntil != null && pausedUntil > now;
}

export type JobChipInfo = {
  label: string;
  tone: "ok" | "bad" | "warn" | "orange" | "info" | "neutral";
  /** Tooltip / extra detail. */
  title?: string;
  live?: boolean;
};

type ChipJob = Pick<Job, "enabled" | "paused_until"> & {
  config_enabled?: boolean;
  active_run?: ActiveRun | null;
};

/**
 * The state chips for a job, most important first: what it is doing right now
 * (running / queued), then why it will not start on its own (disabled, off in
 * the config file, paused), else "enabled".
 */
export function jobChips(job: ChipJob, now: number): JobChipInfo[] {
  const chips: JobChipInfo[] = [];
  if (job.active_run?.state === "running") {
    chips.push({ label: "running", tone: "warn", live: true });
  } else if (job.active_run?.state === "queued") {
    chips.push({ label: "queued", tone: "info" });
  }
  if (!job.enabled) {
    chips.push({ label: "disabled", tone: "neutral", title: "Disabled with `auto disable` or the dashboard" });
  } else if (job.config_enabled === false) {
    chips.push({ label: "off in config", tone: "neutral", title: "`enabled: false` in the config file" });
  } else if (isPausedAt(job.paused_until, now)) {
    chips.push({ label: "paused", tone: "warn" });
  } else if (chips.length === 0) {
    chips.push({ label: "enabled", tone: "ok" });
  }
  return chips;
}

/** Why a job would not start on its own, or null when it would. */
export function idleReason(job: ChipJob, now: number): "disabled" | "off in config" | "paused" | null {
  if (!job.enabled) return "disabled";
  if (job.config_enabled === false) return "off in config";
  if (isPausedAt(job.paused_until, now)) return "paused";
  return null;
}

/** The part of a trigger id after the job name: "job:nightly" -> "nightly". */
export function triggerLocalId(triggerId: string): string {
  const i = triggerId.indexOf(":");
  return i === -1 ? triggerId : triggerId.slice(i + 1);
}

/** The soonest scheduled fire across a job's cron triggers, or null. */
export function nextRunAt(triggers: Pick<Trigger, "next_run_at">[]): number | null {
  let best: number | null = null;
  for (const t of triggers) {
    const at = t.next_run_at;
    if (typeof at === "number" && (best === null || at < best)) best = at;
  }
  return best;
}

export type TriggerBadge = { kind: string; off: boolean; count: number; label: string };

/**
 * Trigger kinds for the job list. Triggers of the same kind and state are
 * grouped ("cron x2"), and a switched-off trigger is marked "(off)".
 */
export function triggerBadges(triggers: Pick<Trigger, "kind" | "enabled">[]): TriggerBadge[] {
  const groups = new Map<string, TriggerBadge>();
  for (const t of triggers) {
    const key = `${t.kind}|${t.enabled ? "on" : "off"}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { kind: t.kind, off: !t.enabled, count: 1, label: "" });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    label: `${g.kind}${g.count > 1 ? ` \u00d7${g.count}` : ""}${g.off ? " (off)" : ""}`,
  }));
}
