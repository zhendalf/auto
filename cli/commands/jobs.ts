// `auto jobs` — one line per job: state, triggers, last run and next run.

import type { Job } from "../client.ts";
import {
  color,
  fmtAgo,
  fmtIn,
  fmtTimeMinutes,
  getApiClient,
  globals,
  paintState,
  printJson,
  println,
  renderTable,
  requireSupervisor,
  status,
} from "../runtime.ts";

/** Earliest upcoming fire across the job's cron triggers, or null when nothing is scheduled. */
export function nextRunAt(job: Pick<Job, "triggers">): number | null {
  let best: number | null = null;
  for (const t of job.triggers) {
    const at = t.next_run_at;
    if (typeof at === "number" && (best === null || at < best)) best = at;
  }
  return best;
}

/** What the job is doing right now, in one word (or phrase). */
export function jobStateLabel(job: Job, now = Date.now()): string {
  let base = "enabled";
  if (!job.enabled) base = "disabled";
  else if (job.config_enabled === false) base = "disabled (config)";
  else if (typeof job.paused_until === "number" && job.paused_until > now) {
    base = `paused until ${fmtTimeMinutes(job.paused_until)}`;
  }
  const active = job.active_run?.state;
  if (active === "running" || active === "queued") {
    // A manual --force run can be active on a job that is off or paused; show both.
    return base === "enabled" ? active : `${active} (${base.split(" ")[0]})`;
  }
  return base;
}

function paintJobState(label: string, text: string): string {
  if (label.startsWith("running") || label.startsWith("queued") || label.startsWith("paused")) return color.yellow(text);
  if (label.startsWith("disabled")) return color.dim(text);
  return text;
}

/** "cron,webhook(off)": kinds of the job's triggers, with "(off)" on the disabled ones. */
export function triggerSummary(job: Pick<Job, "triggers">): string {
  if (job.triggers.length === 0) return "-";
  return job.triggers.map((t) => `${t.kind}${t.enabled ? "" : "(off)"}`).join(",");
}

export function lastRunLabel(job: Pick<Job, "last_run">, now = Date.now()): string {
  const last = job.last_run;
  if (!last) return "-";
  return `${last.state} ${fmtAgo(last.finished_at, now)}`;
}

export function nextRunLabel(job: Pick<Job, "triggers">, now = Date.now()): string {
  const at = nextRunAt(job);
  return at === null ? "-" : `${fmtTimeMinutes(at)} (${fmtIn(at, now)})`;
}

export function formatJobsTable(list: Job[], now = Date.now()): string {
  return renderTable<Job>(
    [
      {
        header: "NAME",
        cell: (j) => j.name,
      },
      {
        header: "STATE",
        cell: (j) => jobStateLabel(j, now),
        paint: (j, padded) => paintJobState(jobStateLabel(j, now), padded),
      },
      { header: "TRIGGERS", cell: (j) => triggerSummary(j) },
      {
        header: "LAST RUN",
        cell: (j) => lastRunLabel(j, now),
        paint: (j, padded) => (j.last_run ? paintState(j.last_run.state, padded) : color.dim(padded)),
      },
      { header: "NEXT RUN", cell: (j) => nextRunLabel(j, now) },
    ],
    list,
  );
}

export async function runJobs(): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);
  const list = await client.jobs();
  if (globals().json) {
    printJson(list);
    return 0;
  }
  if (list.length === 0) {
    status("no jobs configured; add one with `auto create <name> --add`");
    return 0;
  }
  println(formatJobsTable(list));
  return 0;
}
