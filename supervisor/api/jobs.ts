import type { Database } from "bun:sqlite";
import { z } from "zod";
import { nextCronFire } from "../adapters/cron.ts";
import { triggerManual } from "../adapters/manual.ts";
import type { Automation } from "../config.ts";
import { errorJson, json, type RouteHandler } from "./router.ts";
import { applyScheduling, parseJsonBody, type ApiCtx } from "./support.ts";

export type { ApiCtx };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JobRow = {
  job_id: string;
  name: string;
  enabled: number;
  paused_until: number | null;
  archived_at: number | null;
};

type TriggerRow = {
  trigger_id: string;
  job_id: string;
  kind: string;
  config_json: string;
  enabled: number;
  archived_at: number | null;
};

type LastRunRow = {
  run_id: string;
  state: string;
  finished_at: number | null;
};

type ActiveRunRow = {
  run_id: string;
  state: string;
  started_at: number | null;
};

type RecentRunRow = {
  run_id: string;
  job_id: string;
  state: string;
  trigger_kind: string;
  trigger_id: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  signal: string | null;
  log_path: string | null;
  definition_hash: string | null;
  skip_reason: string | null;
};

// Bounds for `auto pause`: at least a second, at most a year.
const PAUSE_MIN_MS = 1_000;
const PAUSE_MAX_MS = 31_536_000_000;

const RunBodySchema = z.object({
  force: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

const PauseBodySchema = z.object({
  duration_ms: z.number().min(PAUSE_MIN_MS).max(PAUSE_MAX_MS).optional(),
  until_iso: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jobRowByName(db: Database, name: string): JobRow | null {
  return db
    .query<JobRow, [string]>(
      `SELECT job_id, name, enabled, paused_until, archived_at
         FROM jobs
        WHERE name = ?`,
    )
    .get(name);
}

function triggersForJob(db: Database, jobId: string): TriggerRow[] {
  return db
    .query<TriggerRow, [string]>(
      `SELECT trigger_id, job_id, kind, config_json, enabled, archived_at
         FROM triggers
        WHERE job_id = ? AND archived_at IS NULL
        ORDER BY created_at, trigger_id`,
    )
    .all(jobId);
}

/**
 * The last run that actually ran. Skipped and cancelled-while-queued rows are
 * history but not results: a refused manual run or an overlap skip must not
 * replace "failed 28s ago" in the job list.
 */
function lastRunForJob(db: Database, jobId: string): LastRunRow | null {
  return db
    .query<LastRunRow, [string]>(
      `SELECT run_id, state, finished_at
         FROM runs
        WHERE job_id = ? AND state NOT IN ('queued','running','skipped','cancelled')
        ORDER BY enqueued_at DESC
        LIMIT 1`,
    )
    .get(jobId);
}

/** The run that is in flight for the job: the running one, else the oldest queued one. */
function activeRunForJob(db: Database, jobId: string): ActiveRunRow | null {
  return db
    .query<ActiveRunRow, [string]>(
      `SELECT run_id, state, started_at
         FROM runs
        WHERE job_id = ? AND state IN ('queued','running')
        ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, enqueued_at ASC
        LIMIT 1`,
    )
    .get(jobId);
}

function recentRunsForJob(db: Database, jobId: string, limit = 20): RecentRunRow[] {
  return db
    .query<RecentRunRow, [string, number]>(
      `SELECT run_id, job_id, state, trigger_kind, trigger_id, enqueued_at,
              started_at, finished_at, exit_code, signal, log_path, definition_hash, skip_reason
         FROM runs
        WHERE job_id = ?
        ORDER BY enqueued_at DESC
        LIMIT ?`,
    )
    .all(jobId, limit);
}

function shapeTrigger(
  ctx: ApiCtx,
  row: TriggerRow,
  jobRow: JobRow,
  automation: Automation,
  now: number,
): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const entry: Record<string, unknown> = {
    trigger_id: row.trigger_id,
    kind: row.kind,
    enabled: row.enabled === 1,
    ...parsed,
  };

  // Local id: the part of "<job name>:<trigger id>" after the first ":" (job
  // names cannot contain one).
  const localId = row.trigger_id.slice(row.trigger_id.indexOf(":") + 1);
  const trigger = automation.triggers.find((t) => t.id === localId);
  if (!trigger) return entry;

  if (trigger.kind === "cron") {
    // When it will next fire, or null if nothing is scheduled: the trigger or
    // the job is disabled, the job is paused, or no cron adapter is running
    // (degraded).
    const paused = jobRow.paused_until !== null && jobRow.paused_until > now;
    const scheduled =
      ctx.cronAdapter() !== null &&
      row.enabled === 1 &&
      jobRow.enabled === 1 &&
      automation.enabled &&
      !paused;
    entry.next_run_at = scheduled ? nextCronFire(trigger.schedule, now) : null;
    if (trigger.condition) {
      entry.condition = { checker: trigger.condition.checker, timeoutMs: trigger.condition.timeoutMs };
    }
  } else {
    entry.public_path = `/hooks/${trigger.path}`;
    entry.secretRef = trigger.auth.secretRef;
    entry.signatureHeader = trigger.auth.signatureHeader;
    entry.deliveryIdHeader = trigger.deliveryIdHeader ?? null;
    entry.contentTypes = trigger.contentTypes;
    entry.maxBodyBytes = trigger.maxBodyBytes;
    // Whether the secret has a value; never the value itself.
    entry.secret_present = ctx.registry()?.hasSecret(trigger.auth.secretRef) ?? false;
  }
  return entry;
}

function shapeJobEntry(
  ctx: ApiCtx,
  jobRow: JobRow,
  includeRecent: boolean,
  now: number,
): Record<string, unknown> | null {
  const reg = ctx.registry();
  if (!reg) return null;
  const automation = reg.activeJobs().find((j) => j.name === jobRow.name);
  if (!automation) return null;

  const triggers = triggersForJob(ctx.db, jobRow.job_id).map((t) =>
    shapeTrigger(ctx, t, jobRow, automation, now),
  );

  const last = lastRunForJob(ctx.db, jobRow.job_id);
  const active = activeRunForJob(ctx.db, jobRow.job_id);

  const entry: Record<string, unknown> = {
    id: automation.id,
    name: jobRow.name,
    description: automation.description ?? null,
    enabled: jobRow.enabled === 1,
    // `enabled: false` in the config file (independent of `auto disable`).
    config_enabled: automation.enabled,
    paused_until: jobRow.paused_until,
    archived_at: jobRow.archived_at,
    reentrancy: automation.reentrancy,
    queueDepth: automation.queueDepth,
    timeoutMs: automation.timeoutMs,
    killGraceMs: automation.killGraceMs,
    triggers,
    last_run: last
      ? {
          run_id: last.run_id,
          state: last.state,
          finished_at: last.finished_at,
        }
      : null,
    active_run: active
      ? { run_id: active.run_id, state: active.state, started_at: active.started_at }
      : null,
  };

  if (includeRecent) {
    entry.recent_runs = recentRunsForJob(ctx.db, jobRow.job_id, 20).map((r) => ({
      ...r,
      job_name: jobRow.name,
      duration_ms:
        r.started_at !== null && r.finished_at !== null ? r.finished_at - r.started_at : null,
    }));
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function makeJobsHandlers(ctx: ApiCtx): {
  list: RouteHandler;
  detail: RouteHandler;
  run: RouteHandler;
  enable: RouteHandler;
  disable: RouteHandler;
  pause: RouteHandler;
  unpause: RouteHandler;
} {
  /** The named job's row, or the 404 to send. Archived jobs do not exist for the API. */
  const findJob = (name: string): { row: JobRow } | { response: Response } => {
    const row = jobRowByName(ctx.db, name);
    if (!row || row.archived_at !== null) {
      return { response: errorJson(404, "not_found", { jobName: name }) };
    }
    return { row };
  };

  const list: RouteHandler = () => {
    const rows = ctx.db
      .query<JobRow, []>(
        `SELECT job_id, name, enabled, paused_until, archived_at
           FROM jobs
          WHERE archived_at IS NULL
          ORDER BY created_at, name`,
      )
      .all();
    const now = Date.now();
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const entry = shapeJobEntry(ctx, row, false, now);
      if (entry) out.push(entry);
    }
    return json(out);
  };

  const detail: RouteHandler = (_req, params) => {
    const found = findJob(params.name ?? "");
    if ("response" in found) return found.response;
    const entry = shapeJobEntry(ctx, found.row, true, Date.now());
    if (!entry) return errorJson(404, "not_found", { jobName: found.row.name });
    return json(entry);
  };

  const run: RouteHandler = async (req, params) => {
    const name = params.name ?? "";
    const reg = ctx.registry();
    const runner = ctx.runner();
    if (!reg || !runner) return errorJson(503, "not_ready");
    const found = findJob(name);
    if ("response" in found) return found.response;

    const body = await parseJsonBody(req, RunBodySchema);
    if (!body.ok) return body.response;

    const result = await triggerManual(runner, name, {
      force: body.value.force === true,
      reason: body.value.reason,
    });

    switch (result.outcome) {
      case "started":
        return json({ run_id: result.run_id }, { status: 200 });
      case "queued":
        return json(
          { run_id: result.run_id, position: result.position },
          { status: 202 },
        );
      case "conflict":
        return errorJson(409, "conflict", { running_run_id: result.running_run_id });
      case "skipped":
        return errorJson(422, "skipped", {
          run_id: result.run_id,
          reason: result.reason,
        });
      case "unknown_job":
        return errorJson(404, "not_found", { jobName: result.jobName });
    }
  };

  const setEnabled = (enabled: 0 | 1): RouteHandler => (_req, params) => {
    const found = findJob(params.name ?? "");
    if ("response" in found) return found.response;
    ctx.db.prepare(`UPDATE jobs SET enabled = ? WHERE job_id = ?`).run(enabled, found.row.job_id);
    applyScheduling(ctx);
    return json({ ok: true });
  };

  const pause: RouteHandler = async (req, params) => {
    const found = findJob(params.name ?? "");
    if ("response" in found) return found.response;

    const body = await parseJsonBody(req, PauseBodySchema);
    if (!body.ok) return body.response;
    const { duration_ms, until_iso } = body.value;

    const now = Date.now();
    let pausedUntil: number;
    if (duration_ms !== undefined && until_iso !== undefined) {
      return errorJson(400, "invalid_body", {
        details: "give either duration_ms or until_iso, not both",
      });
    } else if (duration_ms !== undefined) {
      pausedUntil = now + Math.floor(duration_ms);
    } else if (until_iso !== undefined) {
      const t = Date.parse(until_iso);
      if (!Number.isFinite(t)) return errorJson(400, "invalid_until_iso");
      if (t <= now) {
        return errorJson(400, "invalid_until_iso", { details: "until_iso must be in the future" });
      }
      if (t > now + PAUSE_MAX_MS) {
        return errorJson(400, "invalid_until_iso", {
          details: "until_iso must be within a year from now",
        });
      }
      pausedUntil = t;
    } else {
      return errorJson(400, "missing_duration_or_until");
    }

    ctx.db.prepare(`UPDATE jobs SET paused_until = ? WHERE job_id = ?`).run(pausedUntil, found.row.job_id);
    applyScheduling(ctx);
    return json({ ok: true, paused_until: pausedUntil });
  };

  const unpause: RouteHandler = (_req, params) => {
    const found = findJob(params.name ?? "");
    if ("response" in found) return found.response;
    ctx.db.prepare(`UPDATE jobs SET paused_until = NULL WHERE job_id = ?`).run(found.row.job_id);
    applyScheduling(ctx);
    return json({ ok: true });
  };

  return {
    list,
    detail,
    run,
    enable: setEnabled(1),
    disable: setEnabled(0),
    pause,
    unpause,
  };
}
