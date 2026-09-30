// `auto job <name>` — everything about one job: state, each trigger's
// schedule and next run, the last run and recent history.

import {
  color,
  fmtDuration,
  fmtIn,
  fmtSpan,
  fmtTime,
  fmtTimeMinutes,
  getApiClient,
  globals,
  paintState,
  plural,
  printJson,
  println,
  renderTable,
  requireSupervisor,
  shortRunId,
  status,
} from "../runtime.ts";
import { ApiError, type JobDetail, type RecentRun, type TriggerEntry } from "../client.ts";
import { jobStateLabel, nextRunAt } from "./jobs.ts";

function durationFor(r: RecentRun): number | null {
  if (typeof r.duration_ms === "number") return r.duration_ms;
  if (typeof r.started_at !== "number") return null;
  const end = typeof r.finished_at === "number" ? r.finished_at : Date.now();
  return end - r.started_at;
}

function formatRecentRuns(rows: RecentRun[]): string {
  const why = rows.some((r) => r.skip_reason);
  return renderTable<RecentRun>(
    [
      { header: "TIME", cell: (r) => fmtTime(r.enqueued_at) },
      { header: "RUN_ID", cell: (r) => shortRunId(r.run_id) },
      { header: "KIND", cell: (r) => r.trigger_kind },
      { header: "STATE", cell: (r) => r.state, paint: (r, p) => paintState(r.state, p) },
      { header: "EXIT", cell: (r) => (r.exit_code === null ? "-" : String(r.exit_code)) },
      { header: "DURATION", cell: (r) => fmtDuration(durationFor(r)) },
      ...(why ? [{ header: "WHY", cell: (r: RecentRun) => r.skip_reason ?? "-" }] : []),
    ],
    rows,
    "  ",
  );
}

function reentrancyLine(job: JobDetail): string {
  switch (job.reentrancy) {
    case "queue":
      return `queue (waits behind the running run; up to ${plural(job.queueDepth, "run")} queued)`;
    case "drop":
      return "drop (a trigger that fires while a run is in progress is skipped)";
    case "parallel":
      return "parallel (runs may overlap)";
    default:
      return job.reentrancy;
  }
}

/** The indented detail lines under one trigger. */
function triggerDetails(t: TriggerEntry, now: number): string[] {
  const lines: string[] = [];
  const detail = (label: string, value: string): void => {
    lines.push(`      ${label.padEnd(10)} ${value}`);
  };
  if (t.kind === "cron") {
    if (typeof t.schedule === "string") detail("schedule", t.schedule);
    if (typeof t.next_run_at === "number") {
      detail("next run", `${fmtTimeMinutes(t.next_run_at)} (${fmtIn(t.next_run_at, now)})`);
    } else {
      detail("next run", color.dim("- (not scheduled: trigger or job is off, or paused)"));
    }
    if (t.condition) detail("checker", `${t.condition.checker} (times out after ${fmtSpan(t.condition.timeoutMs)})`);
  } else if (t.kind === "webhook") {
    detail("endpoint", `POST ${t.public_path ?? `/hooks/${String(t.path ?? "")}`}`);
    if (t.secretRef) {
      const state =
        t.secret_present === true
          ? "  (set)"
          : t.secret_present === false
            ? `  NOT SET: run \`auto secret set ${t.secretRef}\``
            : "";
      detail("secret", `${t.secretRef}${state}`);
    }
    if (t.signatureHeader) detail("sig header", t.signatureHeader);
    if (t.deliveryIdHeader) detail("id header", t.deliveryIdHeader);
    if (typeof t.maxBodyBytes === "number") detail("max body", `${t.maxBodyBytes} bytes`);
  }
  return lines;
}

export async function runJob(name: string): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  let job: JobDetail;
  try {
    job = await client.job(name);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      status(`unknown job: ${name} (see \`auto jobs\`)`);
      return 1;
    }
    throw err;
  }

  if (globals().json) {
    printJson(job);
    return 0;
  }

  const now = Date.now();
  const next = nextRunAt(job);
  println(`JOB           ${job.name}`);
  println(`DESCRIPTION   ${job.description ?? "-"}`);
  println(`STATE         ${jobStateLabel(job, now)}`);
  if (job.active_run) {
    println(`ACTIVE RUN    ${shortRunId(job.active_run.run_id)}  ${job.active_run.state}`);
  }
  println(`NEXT RUN      ${next === null ? "-" : `${fmtTimeMinutes(next)} (${fmtIn(next, now)})`}`);
  println(`REENTRANCY    ${reentrancyLine(job)}`);
  println(`TIMEOUT       ${fmtSpan(job.timeoutMs)}  (kill grace ${fmtSpan(job.killGraceMs)})`);

  println("");
  println(`TRIGGERS (${job.triggers.length})`);
  if (job.triggers.length === 0) println(color.dim("  (none)"));
  for (const t of job.triggers) {
    const enabled = t.enabled ? "enabled" : color.dim("disabled");
    println(`  ${t.trigger_id}  ${t.kind}  ${enabled}`);
    for (const line of triggerDetails(t, now)) println(line);
  }

  println("");
  println(`LAST RUN`);
  if (!job.last_run) {
    println(color.dim(`  (no runs yet)`));
  } else {
    const last = job.last_run;
    const lastRecent = job.recent_runs.find((r) => r.run_id === last.run_id);
    const dur = lastRecent ? fmtDuration(durationFor(lastRecent)) : "-";
    const exit =
      lastRecent && typeof lastRecent.exit_code === "number" ? `exit ${lastRecent.exit_code}` : "-";
    println(
      `  ${fmtTime(last.finished_at)}  ${shortRunId(last.run_id)}  ${paintState(last.state, last.state)}  ${exit}  ${dur}`,
    );
  }

  println("");
  println(`RECENT RUNS (${job.recent_runs.length})`);
  if (job.recent_runs.length === 0) {
    println(color.dim(`  (none)`));
  } else {
    println(formatRecentRuns(job.recent_runs));
  }

  return 0;
}
