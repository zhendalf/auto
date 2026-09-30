// Retention sweeper: keeps the run history, run logs, webhook receipts and
// payload files from growing without bound.
//
// Policy (all ages are measured against `now`; AUTO_RETENTION_DAYS=0 keeps
// everything and turns the sweeper off):
//   - Runs: terminal runs older than AUTO_RETENTION_DAYS (default 90) are
//     removed together with their log file, but the newest
//     AUTO_RETENTION_MIN_RUNS (default 25) real runs of each job are always
//     kept, however old. "Real" means not skipped: a busy cron job that drops
//     most fires must not push its useful history out of the floor.
//   - Skipped runs (dropped fires: overlap, paused, ...) are only bookkeeping
//     and expire sooner: min(days, 14). No floor applies to them.
//   - queued/running rows are never touched. Neither is a run a condition
//     trigger still names as its pending run.
//   - Webhook receipts: older than max(days, 7) days, and never inside the
//     5-minute dedupe window. Receipts of a run that is still active stay.
//     A kept payload file goes with its receipt.
//   - Orphans: a run-log or payload file that no row refers to any more is
//     removed once it is older than the retention horizon.
//   - Date directories under runs/ that end up empty are removed once their
//     date is safely in the past.
//
// The log file is deleted before its row, so a row never points at a log this
// sweeper removed (if the row delete then fails, the next sweep finds the row,
// sees the file gone and finishes the job). Work happens in batches of a few
// hundred rows and yields to the event loop between them, so scheduling is
// never blocked. The sweeper never throws: failures are logged and counted.

import { Database } from "bun:sqlite";
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DEDUPE_WINDOW_MS } from "./adapters/webhook.ts";

const DAY_MS = 86_400_000;

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_RETENTION_MIN_RUNS = 25;
/** Skipped-run rows never outlive this many days. */
export const SKIPPED_MAX_DAYS = 14;
/** Webhook receipts are kept at least this many days. */
export const DELIVERY_MIN_DAYS = 7;
export const DEFAULT_BATCH_SIZE = 200;
export const FIRST_SWEEP_DELAY_MS = 60_000;
export const SWEEP_INTERVAL_MS = 6 * 3_600_000;
/** Upper bound accepted for AUTO_RETENTION_DAYS (100 years). */
const MAX_DAYS = 36_500;

// ---------------------------------------------------------------------------
// Settings and plan (pure)
// ---------------------------------------------------------------------------

export type RetentionSettings = {
  /** 0 = keep forever. */
  days: number;
  /** Newest real runs per job that are always kept. 0 = no floor. */
  minRuns: number;
};

function parseCount(
  name: string,
  raw: string | undefined,
  fallback: number,
  max: number,
  warn: (message: string) => void,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    warn(`${name}=${JSON.stringify(raw)} is not an integer from 0 to ${max}; using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Read AUTO_RETENTION_DAYS and AUTO_RETENTION_MIN_RUNS; bad values fall back to the defaults. */
export function parseRetentionEnv(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => process.stderr.write(`[retention] ${m}\n`),
): RetentionSettings {
  return {
    days: parseCount("AUTO_RETENTION_DAYS", env.AUTO_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, MAX_DAYS, warn),
    minRuns: parseCount("AUTO_RETENTION_MIN_RUNS", env.AUTO_RETENTION_MIN_RUNS, DEFAULT_RETENTION_MIN_RUNS, 100_000, warn),
  };
}

/** The cutoffs one sweep applies, all epoch ms; a row is prunable when it is older than its cutoff. */
export type RetentionPlan = {
  enabled: boolean;
  minRuns: number;
  /** Terminal, non-skipped runs enqueued before this. */
  runCutoff: number;
  /** Skipped runs enqueued before this. */
  skippedCutoff: number;
  /** Webhook receipts received before this (never later than now - dedupe window). */
  deliveryCutoff: number;
  /** Files no row refers to whose mtime is before this. */
  orphanCutoff: number;
  /** Empty runs/YYYY/MM/DD directories dated before this may be removed. */
  emptyDirCutoff: number;
};

export function planRetention(settings: RetentionSettings, now: number): RetentionPlan {
  const { days, minRuns } = settings;
  if (days <= 0) {
    return {
      enabled: false,
      minRuns,
      runCutoff: -Infinity,
      skippedCutoff: -Infinity,
      deliveryCutoff: -Infinity,
      orphanCutoff: -Infinity,
      emptyDirCutoff: -Infinity,
    };
  }
  return {
    enabled: true,
    minRuns,
    runCutoff: now - days * DAY_MS,
    skippedCutoff: now - Math.min(days, SKIPPED_MAX_DAYS) * DAY_MS,
    deliveryCutoff: Math.min(now - Math.max(days, DELIVERY_MIN_DAYS) * DAY_MS, now - DEDUPE_WINDOW_MS),
    orphanCutoff: now - days * DAY_MS,
    // A new run's log directory is named for its start date, so directories
    // from the last two local days may still be about to get a file.
    emptyDirCutoff: startOfLocalDay(now - 2 * DAY_MS),
  };
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type PruneResult = {
  dryRun: boolean;
  /** false when retention is off (AUTO_RETENTION_DAYS=0). */
  enabled: boolean;
  /** Runs removed, including skippedRuns. */
  runs: number;
  skippedRuns: number;
  webhookDeliveries: number;
  /** Run-log files removed with their rows. */
  runLogFiles: number;
  /** Kept payload files removed with their receipts. */
  payloadFiles: number;
  orphanLogFiles: number;
  orphanPayloadFiles: number;
  emptyDirs: number;
  bytesFreed: number;
  /** Failed steps; each is also written to stderr. */
  errors: number;
  durationMs: number;
};

function emptyResult(dryRun: boolean, enabled: boolean): PruneResult {
  return {
    dryRun,
    enabled,
    runs: 0,
    skippedRuns: 0,
    webhookDeliveries: 0,
    runLogFiles: 0,
    payloadFiles: 0,
    orphanLogFiles: 0,
    orphanPayloadFiles: 0,
    emptyDirs: 0,
    bytesFreed: 0,
    errors: 0,
    durationMs: 0,
  };
}

export function formatSummary(r: PruneResult): string {
  const mb = (r.bytesFreed / (1024 * 1024)).toFixed(1);
  if (!r.enabled) return "[retention] disabled (AUTO_RETENTION_DAYS=0): nothing removed";
  const logs = r.runLogFiles + r.orphanLogFiles;
  const payloads = r.payloadFiles + r.orphanPayloadFiles;
  const skipped = r.skippedRuns > 0 ? ` (${r.skippedRuns} skipped)` : "";
  const verb = r.dryRun ? "dry run, would remove" : "removed";
  const freed = r.dryRun ? "would free" : "freed";
  const failed = r.errors > 0 ? `, ${r.errors} errors` : "";
  return (
    `[retention] ${verb} ${r.runs} runs${skipped}, ${logs} log files, ` +
    `${r.webhookDeliveries} webhook deliveries, ${payloads} payload files, ` +
    `${r.emptyDirs} empty dirs, ${freed} ${mb} MB${failed} (${r.durationMs} ms)`
  );
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

type FileRemoval = { removed: boolean; bytes: number; failed: boolean };

/**
 * Remove one regular file that must sit inside `root`. A path that escapes the
 * root (lexically or through a symlink), a symlink, a directory or a file that
 * is already gone is left alone and reported as not removed, not failed; only a
 * real unlink error is `failed`.
 */
function removeFileWithin(root: string, path: string, dryRun: boolean): FileRemoval {
  const none: FileRemoval = { removed: false, bytes: 0, failed: false };
  const abs = resolve(path);
  if (!isWithin(root, abs)) return none;
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return none;
    // The directory chain could be a symlink out of the tree.
    const realRoot = realpathSync(root);
    if (!isWithin(realRoot, join(realpathSync(dirname(abs)), basename(abs)))) return none;
    if (!dryRun) unlinkSync(abs);
    return { removed: true, bytes: st.size, failed: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return none;
    process.stderr.write(`[retention] could not remove ${abs}: ${errText(err)}\n`);
    return { removed: false, bytes: 0, failed: true };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const yieldToLoop = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

// ---------------------------------------------------------------------------
// One sweep
// ---------------------------------------------------------------------------

export type PruneOptions = {
  /** Report what would be removed; delete nothing. */
  dryRun?: boolean;
  /** Clock for the cutoffs (epoch ms). */
  now?: number;
  /** Defaults to the AUTO_RETENTION_* environment. */
  settings?: RetentionSettings;
  /** Rows handled per batch before yielding to the event loop. */
  batchSize?: number;
  /** Polled between batches; a true return ends the sweep early. */
  shouldStop?: () => boolean;
};

type RunRow = { run_id: string; enqueued_at: number; log_path: string | null };
/** A prepared candidate query: (job, cutoff, cursor enqueued_at, cursor run_id, ceiling enqueued_at, ceiling run_id, limit). */
type RunSelect = { all(...params: [string, number, number, string, number, string, number]): RunRow[] };
type DeliveryRow = { receipt_id: string; received_at: number; payload_path: string | null };

const NON_TERMINAL = `'queued','running'`;
const RECEIPT_FILE_RE = /^[0-9a-f-]{8,64}\.payload$/;
const RUN_LOG_FILE_RE = /^[0-9a-f-]{8,64}\.log$/;

/**
 * Sweep once. `dataDir` is the data root (log_path and payload_path are stored
 * relative to it). Resolves with what was (or, for a dry run, would be)
 * removed; never rejects.
 */
export async function pruneOnce(db: Database, dataDir: string, opts: PruneOptions = {}): Promise<PruneResult> {
  const dryRun = opts.dryRun === true;
  const started = Date.now();
  const now = opts.now ?? started;
  const settings = opts.settings ?? parseRetentionEnv();
  const plan = planRetention(settings, now);
  const result = emptyResult(dryRun, plan.enabled);
  if (!plan.enabled) return result;

  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const stopped = (): boolean => opts.shouldStop?.() === true;
  const root = resolve(dataDir);
  const runsRoot = join(root, "runs");
  const payloadsRoot = join(root, "payloads");

  const step = async (name: string, work: () => Promise<void>): Promise<void> => {
    if (stopped()) return;
    try {
      await work();
    } catch (err) {
      result.errors++;
      process.stderr.write(`[retention] ${name} failed: ${errText(err)}\n`);
    }
  };

  await step("webhook deliveries", () => pruneDeliveries());
  await step("runs", () => pruneRuns());
  await step("orphan run logs", () => pruneOrphanLogs());
  await step("orphan payloads", () => pruneOrphanPayloads());
  await step("empty directories", async () => pruneEmptyDirs());

  result.durationMs = Date.now() - started;
  return result;

  // -- webhook deliveries ---------------------------------------------------

  async function pruneDeliveries(): Promise<void> {
    const select = db.query<DeliveryRow, [number, number, string, number]>(
      `SELECT receipt_id, received_at, payload_path FROM webhook_deliveries d
        WHERE received_at < ?1
          AND (received_at, receipt_id) > (?2, ?3)
          AND (run_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM runs r WHERE r.run_id = d.run_id AND r.state IN (${NON_TERMINAL})))
        ORDER BY received_at, receipt_id
        LIMIT ?4`,
    );
    const del = db.query(`DELETE FROM webhook_deliveries WHERE receipt_id = ?`);
    let cursor: [number, string] = [-1, ""];
    while (!stopped()) {
      const rows = select.all(plan.deliveryCutoff, cursor[0], cursor[1], batchSize);
      if (rows.length === 0) return;
      const last = rows[rows.length - 1]!;
      cursor = [last.received_at, last.receipt_id];
      const deletable: string[] = [];
      for (const row of rows) {
        if (row.payload_path) {
          const gone = removeFileWithin(payloadsRoot, resolve(root, row.payload_path), dryRun);
          if (gone.failed) {
            result.errors++;
            continue;
          }
          if (gone.removed) {
            result.payloadFiles++;
            result.bytesFreed += gone.bytes;
          }
        }
        deletable.push(row.receipt_id);
      }
      if (dryRun) {
        result.webhookDeliveries += deletable.length;
      } else {
        try {
          db.transaction(() => {
            for (const id of deletable) result.webhookDeliveries += del.run(id).changes;
          })();
        } catch (err) {
          result.errors++;
          process.stderr.write(`[retention] deleting webhook deliveries failed: ${errText(err)}\n`);
        }
      }
      await yieldToLoop();
    }
  }

  // -- runs -----------------------------------------------------------------

  async function pruneRuns(): Promise<void> {
    const jobs = db.query<{ job_id: string }, []>(`SELECT job_id FROM jobs`).all();
    // The newest `minRuns` real runs of a job are the floor: the run at that
    // rank marks the boundary, and only runs strictly older may go.
    const floorQuery = db.query<{ enqueued_at: number; run_id: string }, [string, number]>(
      `SELECT enqueued_at, run_id FROM runs
        WHERE job_id = ?1 AND state NOT IN (${NON_TERMINAL}, 'skipped')
        ORDER BY enqueued_at DESC, run_id DESC
        LIMIT 1 OFFSET ?2`,
    );
    const candidates = (stateClause: string): RunSelect =>
      db.query<RunRow, [string, number, number, string, number, string, number]>(
        `SELECT run_id, enqueued_at, log_path FROM runs
          WHERE job_id = ?1 AND ${stateClause}
            AND enqueued_at < ?2
            AND (enqueued_at, run_id) > (?3, ?4)
            AND (enqueued_at, run_id) < (?5, ?6)
            AND NOT EXISTS (SELECT 1 FROM condition_states c WHERE c.pending_run_id = runs.run_id)
          ORDER BY enqueued_at, run_id
          LIMIT ?7`,
      );
    const realCandidates = candidates(`state NOT IN (${NON_TERMINAL}, 'skipped')`);
    const skippedCandidates = candidates(`state = 'skipped'`);

    for (const { job_id: jobId } of jobs) {
      if (stopped()) return;
      // Real runs, honouring the floor.
      let ceiling: [number, string] = [Number.MAX_SAFE_INTEGER, ""];
      let proceed = true;
      if (plan.minRuns > 0) {
        const floor = floorQuery.get(jobId, plan.minRuns - 1);
        if (floor) ceiling = [floor.enqueued_at, floor.run_id];
        else proceed = false; // fewer real runs than the floor: keep them all
      }
      if (proceed) await removeRunBatches(jobId, realCandidates, plan.runCutoff, ceiling, false);
      await removeRunBatches(
        jobId,
        skippedCandidates,
        plan.skippedCutoff,
        [Number.MAX_SAFE_INTEGER, ""],
        true,
      );
    }
  }

  async function removeRunBatches(
    jobId: string,
    query: RunSelect,
    cutoff: number,
    ceiling: [number, string],
    skipped: boolean,
  ): Promise<void> {
    const nullDeliveries = db.query(`UPDATE webhook_deliveries SET run_id = NULL WHERE run_id = ?`);
    const del = db.query(`DELETE FROM runs WHERE run_id = ? AND state NOT IN (${NON_TERMINAL})`);
    let cursor: [number, string] = [-1, ""];
    while (!stopped()) {
      const rows = query.all(jobId, cutoff, cursor[0], cursor[1], ceiling[0], ceiling[1], batchSize);
      if (rows.length === 0) return;
      const last = rows[rows.length - 1]!;
      cursor = [last.enqueued_at, last.run_id];

      // Log first: a row is only deleted once its file is gone (or was never
      // there), so no row is left pointing at a log this sweep removed.
      const deletable: string[] = [];
      for (const row of rows) {
        if (row.log_path) {
          const gone = removeFileWithin(runsRoot, resolve(root, row.log_path), dryRun);
          if (gone.failed) {
            result.errors++;
            continue;
          }
          if (gone.removed) {
            result.runLogFiles++;
            result.bytesFreed += gone.bytes;
          }
        }
        deletable.push(row.run_id);
      }
      if (dryRun) {
        result.runs += deletable.length;
        if (skipped) result.skippedRuns += deletable.length;
      } else {
        try {
          db.transaction(() => {
            for (const id of deletable) {
              // Receipts keep their history; they just stop naming the run.
              nullDeliveries.run(id);
              const changes = del.run(id).changes;
              result.runs += changes;
              if (skipped) result.skippedRuns += changes;
            }
          })();
        } catch (err) {
          result.errors++;
          process.stderr.write(`[retention] deleting runs failed: ${errText(err)}\n`);
        }
      }
      await yieldToLoop();
    }
  }

  // -- orphan files ---------------------------------------------------------

  async function pruneOrphanLogs(): Promise<void> {
    const hasRun = db.query<{ one: number }, [string]>(`SELECT 1 AS one FROM runs WHERE run_id = ?`);
    let handled = 0;
    for (const year of listDir(runsRoot)) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const month of listDir(join(runsRoot, year))) {
        if (!/^\d{2}$/.test(month)) continue;
        for (const day of listDir(join(runsRoot, year, month))) {
          if (!/^\d{2}$/.test(day)) continue;
          // Files in a day directory were created on or after that day.
          if (new Date(Number(year), Number(month) - 1, Number(day)).getTime() > plan.orphanCutoff) continue;
          const dir = join(runsRoot, year, month, day);
          for (const name of listDir(dir)) {
            if (stopped()) return;
            if (!RUN_LOG_FILE_RE.test(name)) continue;
            if (++handled % batchSize === 0) await yieldToLoop();
            const file = join(dir, name);
            try {
              const st = lstatSync(file);
              if (!st.isFile() || st.mtimeMs >= plan.orphanCutoff) continue;
              if (hasRun.get(name.slice(0, -".log".length))) continue;
            } catch {
              continue;
            }
            const gone = removeFileWithin(runsRoot, file, dryRun);
            if (gone.failed) result.errors++;
            if (gone.removed) {
              result.orphanLogFiles++;
              result.bytesFreed += gone.bytes;
            }
          }
        }
      }
    }
  }

  async function pruneOrphanPayloads(): Promise<void> {
    const receiptKnown = db.query<{ one: number }, [string]>(
      `SELECT 1 AS one FROM webhook_deliveries WHERE receipt_id = ?`,
    );
    const activeRows = db
      .query<{ receipt_id: string | null }, []>(
        `SELECT json_extract(trigger_meta, '$.receipt_id') AS receipt_id FROM runs
          WHERE trigger_kind = 'webhook' AND state IN (${NON_TERMINAL})`,
      )
      .all();
    const active = new Set(activeRows.map((r) => r.receipt_id).filter((v): v is string => typeof v === "string"));
    let handled = 0;
    for (const dir of [payloadsRoot, join(payloadsRoot, "ephemeral")]) {
      for (const name of listDir(dir)) {
        if (stopped()) return;
        if (!RECEIPT_FILE_RE.test(name)) continue;
        if (++handled % batchSize === 0) await yieldToLoop();
        const receiptId = name.slice(0, -".payload".length);
        if (active.has(receiptId) || receiptKnown.get(receiptId)) continue;
        const file = join(dir, name);
        try {
          const st = lstatSync(file);
          if (!st.isFile() || st.mtimeMs >= plan.orphanCutoff) continue;
        } catch {
          continue;
        }
        const gone = removeFileWithin(payloadsRoot, file, dryRun);
        if (gone.failed) result.errors++;
        if (gone.removed) {
          result.orphanPayloadFiles++;
          result.bytesFreed += gone.bytes;
        }
      }
    }
  }

  // -- empty directories ----------------------------------------------------

  /** Remove empty runs/YYYY/MM/DD (then MM, YYYY) directories whose whole date range is old enough. */
  function pruneEmptyDirs(): void {
    const tryRemove = (dir: string): boolean => {
      // In a dry run only directories that are already empty are counted.
      if (listDir(dir).length > 0) return false;
      if (!dryRun) {
        try {
          rmdirSync(dir);
        } catch (err) {
          // ENOTEMPTY: a file arrived meanwhile. Anything else is worth a line.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOTEMPTY" && code !== "ENOENT") {
            result.errors++;
            process.stderr.write(`[retention] could not remove ${dir}: ${errText(err)}\n`);
          }
          return false;
        }
      }
      result.emptyDirs++;
      return true;
    };
    for (const year of listDir(runsRoot)) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = join(runsRoot, year);
      for (const month of listDir(yearDir)) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthDir = join(yearDir, month);
        for (const day of listDir(monthDir)) {
          if (!/^\d{2}$/.test(day)) continue;
          // The day directory covers [start of that day, start of the next).
          const nextDay = new Date(Number(year), Number(month) - 1, Number(day) + 1).getTime();
          if (nextDay <= plan.emptyDirCutoff) tryRemove(join(monthDir, day));
        }
        const nextMonth = new Date(Number(year), Number(month), 1).getTime();
        // A dry run leaves the day directories in place, so the month is not empty yet.
        if (nextMonth <= plan.emptyDirCutoff && !dryRun) tryRemove(monthDir);
      }
      const nextYear = new Date(Number(year) + 1, 0, 1).getTime();
      if (nextYear <= plan.emptyDirCutoff && !dryRun) tryRemove(yearDir);
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type RetentionOptions = {
  db: Database;
  dataDir: string;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  firstSweepDelayMs?: number;
  intervalMs?: number;
  batchSize?: number;
  /** Summary lines. Defaults to stdout. */
  log?: (line: string) => void;
};

export type RetentionHandle = {
  /** Run a sweep now (or join the one in flight). Never rejects. */
  pruneOnce(opts?: { dryRun?: boolean }): Promise<PruneResult>;
  /** Cancel the timer and wait for a sweep in flight to stop. Idempotent. */
  stop(): Promise<void>;
};

/** Start sweeping: first sweep after 60 s, then every 6 h, until stop(). */
export function startRetention(opts: RetentionOptions): RetentionHandle {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const settings = parseRetentionEnv(opts.env ?? process.env);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<PruneResult> | null = null;

  const sweep = (dryRun: boolean): Promise<PruneResult> => {
    // Real sweeps never overlap. A dry run only reads, so it always runs itself.
    if (!dryRun && inflight) return inflight;
    const run = (async () => {
      try {
        const result = await pruneOnce(opts.db, opts.dataDir, {
          dryRun,
          settings,
          batchSize: opts.batchSize,
          shouldStop: () => stopped,
        });
        if (result.enabled) log(formatSummary(result));
        return result;
      } catch (err) {
        // pruneOnce guards its own steps; this is the belt to those braces.
        process.stderr.write(`[retention] sweep failed: ${errText(err)}\n`);
        const failed = emptyResult(dryRun, true);
        failed.errors = 1;
        return failed;
      } finally {
        if (!dryRun) inflight = null;
      }
    })();
    if (!dryRun) inflight = run;
    return run;
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void sweep(false).then(() => schedule(opts.intervalMs ?? SWEEP_INTERVAL_MS));
    }, delayMs);
    timer.unref?.();
  };

  if (settings.days === 0) {
    log(formatSummary(emptyResult(false, false)));
  } else {
    schedule(opts.firstSweepDelayMs ?? FIRST_SWEEP_DELAY_MS);
  }

  return {
    pruneOnce: (o) => sweep(o?.dryRun === true),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inflight) await inflight.catch(() => {});
    },
  };
}
