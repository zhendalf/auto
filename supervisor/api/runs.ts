import type { Database } from "bun:sqlite";
import type { Runner } from "../runner.ts";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DATA_DIR } from "../db/connection.ts";
import { errorJson, json, readBodyCapped, type RouteHandler } from "./router.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunsCtx = {
  db: Database;
  runner: () => Runner | null;
  /** Resolved data dir; logs are stored relative to this. */
  dataDir?: string;
};

type RunRow = {
  run_id: string;
  job_id: string;
  trigger_id: string | null;
  trigger_kind: string;
  state: string;
  exit_code: number | null;
  signal: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  log_path: string | null;
  trigger_meta: string | null;
  definition_hash: string | null;
  skip_reason: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 500;
/** Shortest run reference (hex digits, hyphens not counted) the API resolves. */
const REF_MIN_HEX = 6;
/** Cancel takes no body; anything larger than this is refused. */
const CANCEL_BODY_MAX_BYTES = 4 * 1024;

const RUN_STATES = new Set([
  "queued", "running", "succeeded", "failed", "timed_out", "killed", "cancelled", "skipped", "lost",
]);

function shapeRunSummary(row: RunRow & { job_name: string }): Record<string, unknown> {
  const startedAt = row.started_at;
  const finishedAt = row.finished_at;
  const durationMs =
    startedAt !== null && finishedAt !== null ? finishedAt - startedAt : null;
  return {
    run_id: row.run_id,
    job_id: row.job_id,
    job_name: row.job_name,
    trigger_kind: row.trigger_kind,
    trigger_id: row.trigger_id,
    state: row.state,
    exit_code: row.exit_code,
    signal: row.signal,
    enqueued_at: row.enqueued_at,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    log_path: row.log_path,
    definition_hash: row.definition_hash,
    // Why a run was skipped, or ended abnormally on the supervisor's side
    // (overlap, disabled, paused, queue_full, supervisor_interrupted,
    // supervisor_shutdown, spawn_error, ...); null for an ordinary run.
    skip_reason: row.skip_reason,
  };
}

const RUN_SELECT = `SELECT r.run_id, r.job_id, r.trigger_id, r.trigger_kind, r.state, r.exit_code, r.signal,
              r.enqueued_at, r.started_at, r.finished_at, r.log_path, r.trigger_meta, r.definition_hash, r.skip_reason,
              j.name AS job_name
         FROM runs r JOIN jobs j ON j.job_id = r.job_id`;

type Found =
  | { kind: "ok"; row: RunRow & { job_name: string } }
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ambiguous"; candidates: string[] };

/** Hex digits -> the hyphenated UUID text prefix they spell (8-4-4-4-12). */
function hyphenate(hex: string): string {
  const cuts = [8, 12, 16, 20];
  let out = "";
  for (let i = 0; i < hex.length; i++) {
    if (cuts.includes(i)) out += "-";
    out += hex[i];
  }
  return out;
}

/**
 * Resolve a run reference: the exact full id, else a unique prefix, else a
 * unique suffix of the id with hyphens removed (the short display id is the
 * last 8 hex digits, because the leading digits of a UUIDv7 are timestamp
 * bits). References are hex digits and hyphens only, at least REF_MIN_HEX
 * digits; they are compared as plain strings, never as LIKE patterns, and
 * hyphen placement in the input does not matter.
 */
function findRun(db: Database, raw: string): Found {
  const ref = raw.toLowerCase();
  const hex = ref.replace(/-/g, "");
  if (!/^[0-9a-f-]+$/.test(ref) || hex.length < REF_MIN_HEX || hex.length > 32) return { kind: "invalid" };
  const canonical = hyphenate(hex);

  const exact = db.query<RunRow & { job_name: string }, [string]>(`${RUN_SELECT} WHERE r.run_id = ?`).get(canonical);
  if (exact) return { kind: "ok", row: exact };

  // Run ids only contain [0-9a-f-], so "<prefix>g" sorts after every id that
  // starts with the prefix; this keeps the lookup on the primary-key index.
  const byPrefix = db
    .query<RunRow & { job_name: string }, [string, string]>(
      `${RUN_SELECT} WHERE r.run_id >= ?1 AND r.run_id <= ?2 ORDER BY r.run_id LIMIT 11`,
    )
    .all(canonical, canonical + "g");
  if (byPrefix.length === 1) return { kind: "ok", row: byPrefix[0]! };
  if (byPrefix.length > 1) return { kind: "ambiguous", candidates: byPrefix.slice(0, 10).map((c) => c.run_id) };

  const bySuffix = db
    .query<RunRow & { job_name: string }, [string, number]>(
      `${RUN_SELECT} WHERE substr(replace(r.run_id, '-', ''), -?2) = ?1 ORDER BY r.run_id LIMIT 11`,
    )
    .all(hex, hex.length);
  if (bySuffix.length === 0) return { kind: "none" };
  if (bySuffix.length === 1) return { kind: "ok", row: bySuffix[0]! };
  return { kind: "ambiguous", candidates: bySuffix.slice(0, 10).map((c) => c.run_id) };
}

/** Error response for a failed lookup, or null when the run was found. */
function notFoundResponse(found: Found): Response | null {
  switch (found.kind) {
    case "ok": return null;
    case "invalid":
      return errorJson(400, "invalid_run_id", {
        message: `run reference must be at least ${REF_MIN_HEX} hex digits (0-9, a-f, hyphens allowed)`,
      });
    case "none": return errorJson(404, "not_found");
    case "ambiguous": return errorJson(409, "ambiguous_prefix", { candidates: found.candidates });
  }
}

/** Non-negative decimal integer within the safe range, or null. */
function parseUint(raw: string): number | null {
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Real path of `file` when it is a regular file inside `dir`, else null. */
function containedFile(dir: string, file: string): string | null {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(file);
    if (!real.startsWith(root + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function makeRunsHandlers(ctx: RunsCtx): {
  list: RouteHandler;
  detail: RouteHandler;
  log: RouteHandler;
  cancel: RouteHandler;
} {
  const dataDir = ctx.dataDir ?? DATA_DIR;

  const list: RouteHandler = (_req, _params, url) => {
    const job = url.searchParams.get("job");
    const state = url.searchParams.get("state");
    const limitRaw = url.searchParams.get("limit");
    const beforeRaw = url.searchParams.get("before");
    const beforeIdRaw = url.searchParams.get("before_id");

    if (state !== null && state !== "" && !RUN_STATES.has(state)) {
      return errorJson(400, "invalid_state", { allowed: [...RUN_STATES] });
    }
    let limit = LIMIT_DEFAULT;
    if (limitRaw !== null) {
      const n = parseUint(limitRaw);
      if (n === null || n <= 0) return errorJson(400, "invalid_limit");
      limit = Math.min(n, LIMIT_MAX);
    }
    let before: number | null = null;
    if (beforeRaw !== null) {
      const n = parseUint(beforeRaw);
      if (n === null || n <= 0) return errorJson(400, "invalid_before");
      before = n;
    }
    let beforeId: string | null = null;
    if (beforeIdRaw !== null) {
      // before_id refines before: it makes the cursor a (enqueued_at, run_id) tuple.
      if (before === null) return errorJson(400, "invalid_before_id", { message: "before_id requires before" });
      if (!/^[0-9a-f-]{1,36}$/.test(beforeIdRaw)) return errorJson(400, "invalid_before_id");
      beforeId = beforeIdRaw;
    }

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (job) {
      where.push("j.name = ?");
      params.push(job);
    }
    if (state) {
      where.push("r.state = ?");
      params.push(state);
    }
    if (before !== null && beforeId !== null) {
      // Runs sharing a millisecond are ordered (and paged) by run_id.
      where.push("(r.enqueued_at < ? OR (r.enqueued_at = ? AND r.run_id < ?))");
      params.push(before, before, beforeId);
    } else if (before !== null) {
      where.push("r.enqueued_at < ?");
      params.push(before);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // One extra row tells whether another page exists.
    params.push(limit + 1);

    const rows = ctx.db
      .query<RunRow & { job_name: string }, (string | number)[]>(
        `${RUN_SELECT}
           ${whereSql}
          ORDER BY r.enqueued_at DESC, r.run_id DESC
          LIMIT ?`,
      )
      .all(...params);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    // The body stays a bare array; the cursor for the next page travels in
    // headers (absent on the last page). Send both back as before/before_id.
    const headers: Record<string, string> = {};
    if (more) {
      const last = page[page.length - 1]!;
      headers["x-next-before"] = String(last.enqueued_at);
      headers["x-next-before-id"] = last.run_id;
    }
    return json(page.map(shapeRunSummary), { headers });
  };

  const detail: RouteHandler = (_req, params) => {
    const id = params.run_id ?? "";
    if (!id) return errorJson(400, "missing_run_id");
    const found = findRun(ctx.db, id);
    const failure = notFoundResponse(found);
    if (failure) return failure;
    const row = (found as Extract<Found, { kind: "ok" }>).row;
    const summary = shapeRunSummary(row);
    let triggerMeta: unknown = null;
    if (row.trigger_meta) {
      try {
        triggerMeta = JSON.parse(row.trigger_meta);
      } catch {
        triggerMeta = row.trigger_meta;
      }
    }
    return json({ ...summary, trigger_meta: triggerMeta });
  };

  const log: RouteHandler = async (_req, params, url) => {
    const id = params.run_id ?? "";
    if (!id) return errorJson(400, "missing_run_id");
    let offset = 0;
    const offsetRaw = url.searchParams.get("offset");
    if (offsetRaw !== null) {
      const n = parseUint(offsetRaw);
      if (n === null) return errorJson(400, "invalid_offset");
      offset = n;
    }
    const found = findRun(ctx.db, id);
    const failure = notFoundResponse(found);
    if (failure) return failure;
    const row = (found as Extract<Found, { kind: "ok" }>).row;
    // Lets a follower tell "no log yet" from "finished without output".
    const stateHeaders = { "x-run-state": row.state };
    if (!row.log_path) return errorJson(404, "no_log", undefined, { ...stateHeaders, "x-log-size": "0" });
    const abs = containedFile(dataDir, resolve(dataDir, row.log_path));
    if (!abs) return errorJson(404, "log_missing", undefined, { ...stateHeaders, "x-log-size": "0" });
    try {
      const file = Bun.file(abs);
      // Size is read once; the slice is pinned to it so the body and
      // X-Log-Size agree even while the log is still being written.
      const size = file.size;
      const headers = { ...stateHeaders, "x-log-size": String(size) };
      if (offset > size) return errorJson(416, "offset_out_of_range", { size }, headers);
      return new Response(file.slice(offset, size), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Log-Offset": String(offset),
          ...headers,
        },
      });
    } catch {
      return errorJson(500, "log_read_failed");
    }
  };

  const cancel: RouteHandler = async (req, params) => {
    const id = params.run_id ?? "";
    if (!id) return errorJson(400, "missing_run_id");
    // Cancel takes no body. Whatever is sent is read (capped, chunked included)
    // and discarded so an oversize or malformed upload is refused, not trusted.
    const body = await readBodyCapped(req, CANCEL_BODY_MAX_BYTES);
    if (!body.ok) {
      return body.reason === "too_large" ? errorJson(413, "payload_too_large") : errorJson(400, "bad_request");
    }
    const runner = ctx.runner();
    if (!runner) return errorJson(503, "not_ready");

    const found = findRun(ctx.db, id);
    const failure = notFoundResponse(found);
    if (failure) return failure;

    const row = (found as Extract<Found, { kind: "ok" }>).row;
    const result = await runner.cancel(row.run_id);
    if (!result.ok) {
      // previous_state will be the final state already in DB; treat as already finished.
      return errorJson(409, "already_finished", { previous_state: result.previous_state });
    }
    return json({ ok: true, previous_state: result.previous_state });
  };

  return { list, detail, log, cancel };
}

export type { RunsCtx };
