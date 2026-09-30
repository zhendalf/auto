// `auto runs` — list recent runs via GET /api/runs.

import { ApiError, type Run } from "../client.ts";
import {
  EX,
  fmtDuration,
  fmtTime,
  getApiClient,
  globals,
  paintState,
  printJson,
  println,
  renderTable,
  requireSupervisor,
  shortRunId,
  status,
} from "../runtime.ts";

export type RunsOptions = {
  job?: string;
  n?: string | number;
  state?: string;
};

function durationFor(row: Run): number | null {
  if (typeof row.duration_ms === "number") return row.duration_ms;
  if (typeof row.started_at !== "number") return null;
  const end = typeof row.finished_at === "number" ? row.finished_at : Date.now();
  return end - row.started_at;
}

export function formatRunsTable(rows: Run[]): string {
  // The reason column only appears when some run has one (skipped runs and
  // runs the supervisor ended itself), so an ordinary listing is unchanged.
  const why = rows.some((r) => r.skip_reason);
  return renderTable<Run>(
    [
      { header: "TIME", cell: (r) => fmtTime(r.enqueued_at) },
      { header: "RUN_ID", cell: (r) => shortRunId(r.run_id) },
      { header: "JOB", cell: (r) => r.job_name },
      { header: "KIND", cell: (r) => r.trigger_kind },
      { header: "STATE", cell: (r) => r.state, paint: (r, p) => paintState(r.state, p) },
      { header: "EXIT", cell: (r) => (r.exit_code === null ? "-" : String(r.exit_code)) },
      { header: "DURATION", cell: (r) => fmtDuration(durationFor(r)) },
      ...(why ? [{ header: "WHY", cell: (r: Run) => r.skip_reason ?? "-" }] : []),
    ],
    rows,
  );
}

export async function runRuns(opts: RunsOptions): Promise<number> {
  let limit = 20;
  if (opts.n !== undefined) {
    const n = typeof opts.n === "string" ? Number(opts.n) : opts.n;
    if (!Number.isInteger(n) || n <= 0) {
      status(`--limit must be a positive whole number, got '${String(opts.n)}'`);
      return EX.USAGE;
    }
    limit = Math.min(n, 500);
  }

  const client = getApiClient();
  await requireSupervisor(client);

  let rows: Run[];
  try {
    rows = await client.runs({ job: opts.job, state: opts.state, limit });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const body = err.body as { error?: string; allowed?: unknown } | null;
      if (body?.error === "invalid_state") {
        const allowed = Array.isArray(body.allowed) ? body.allowed.join(", ") : "running, succeeded, failed, ...";
        status(`unknown state '${opts.state ?? ""}'; use one of: ${allowed}`);
        return EX.USAGE;
      }
    }
    throw err;
  }

  // A job that does not exist is not "no runs" (in JSON mode either).
  if (rows.length === 0 && opts.job) {
    try {
      await client.job(opts.job);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        status(`unknown job: ${opts.job} (see \`auto jobs\`)`);
        return EX.ERR;
      }
      throw err;
    }
  }

  if (globals().json) {
    printJson(rows);
    return 0;
  }
  if (rows.length === 0) {
    status(opts.job || opts.state ? "no runs match" : "no runs yet; try `auto run <job>`");
    return 0;
  }
  println(formatRunsTable(rows));
  return 0;
}
