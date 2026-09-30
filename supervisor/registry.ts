import type { Database } from "bun:sqlite";
import { ConfigValidationError } from "./config.ts";
import type { Automation, Config, Trigger } from "./config.ts";
import type { Registry } from "./runner.ts";
import { uuidv4 } from "./db/ids.ts";
import { validateCronExpression } from "./adapters/cron.ts";

// Re-exported so existing imports from "./registry.ts" keep working; the class
// lives with the config it validates.
export { ConfigValidationError };

/** setTimeout cannot wait longer than this (a signed 32-bit millisecond count). */
const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReconciliationStats = {
  jobs:     { added: number; updated: number; archived: number; unchanged: number };
  triggers: { added: number; updated: number; archived: number; unchanged: number };
};

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

type JobRow = {
  job_id: string;
  name: string;
  enabled: number;
  paused_until: number | null;
  archived_at: number | null;
  last_seen_in_config_at: number;
  created_at: number;
};

type TriggerRow = {
  trigger_id: string;
  job_id: string;
  kind: string;
  config_json: string;
  enabled: number;
  last_seen_in_config_at: number;
  archived_at: number | null;
  updated_at: number;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function namespacedTriggerId(jobName: string, triggerId: string): string {
  return `${jobName}:${triggerId}`;
}

function stableTriggerJson(trigger: Trigger): string {
  // Stable key ordering for deterministic comparison.
  const obj = trigger as unknown as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// JobRegistry
// ---------------------------------------------------------------------------

/**
 * The set of jobs the supervisor knows, mirrored in the database.
 *
 * A job is identified by its NAME: `jobs.name` is the key that reconcile
 * matches on, and `<name>:<trigger id>` keys its triggers. The config's `id`
 * field is only a label. Renaming a job in the config therefore archives the
 * old row and creates a new one with fresh history and state.
 *
 * It also owns "scheduling state": which jobs and triggers are eligible to be
 * scheduled right now (config `enabled`, the DB enabled flag, `paused_until`).
 * Whatever applies that state (main.ts reconciles the cron and webhook
 * adapters) subscribes with onStateChange(); the API calls
 * notifyStateChanged() after every write, and a timer calls it when the
 * earliest pause runs out, so a pause ends by itself.
 */
export class JobRegistry implements Registry {
  private readonly db: Database;

  // name -> { jobId, job } cache for active (non-archived) jobs only.
  private cache = new Map<string, { jobId: string; job: Automation }>();
  // Preserve config order for activeJobs() iteration.
  private order: string[] = [];

  private readonly stateListeners = new Set<() => void>();
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly hasSecretFn: ((ref: string) => boolean) | null;

  constructor(opts: { db: Database; hasSecret?: (ref: string) => boolean }) {
    this.db = opts.db;
    this.hasSecretFn = opts.hasSecret ?? null;
  }

  // -------------------------------------------------------------------------
  // Scheduling state
  // -------------------------------------------------------------------------

  /** Subscribe to "scheduling state may have changed"; returns the unsubscribe function. */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Tell subscribers that job/trigger state changed (call after writing it),
   * and re-arm the pause-expiry timer. Every subscriber runs even if one
   * throws; the first error is rethrown afterwards. Returns how many ran.
   */
  notifyStateChanged(): number {
    let ran = 0;
    let firstError: unknown = null;
    for (const listener of [...this.stateListeners]) {
      ran++;
      try {
        listener();
      } catch (err) {
        firstError ??= err;
      }
    }
    this.armPauseTimer();
    if (firstError !== null) throw firstError;
    return ran;
  }

  /** Whether a webhook secret has a value (false when no probe was given). */
  hasSecret(ref: string): boolean {
    try {
      return this.hasSecretFn ? this.hasSecretFn(ref) : false;
    } catch {
      return false;
    }
  }

  /** Stop the pause timer and drop subscribers (shutdown). */
  close(): void {
    this.closed = true;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.stateListeners.clear();
  }

  /**
   * Arm one timer for the earliest `paused_until` still in the future, so the
   * job is scheduled again the moment its pause ends instead of at the next
   * unrelated reconcile. A pause longer than setTimeout can wait fires early
   * (clamped to 2^31-1 ms) and simply re-arms.
   */
  private armPauseTimer(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.closed) return;
    const now = Date.now();
    const row = this.db
      .query<{ next: number | null }, [number]>(
        `SELECT MIN(paused_until) AS next
           FROM jobs
          WHERE archived_at IS NULL AND paused_until IS NOT NULL AND paused_until > ?`,
      )
      .get(now);
    const next = row?.next ?? null;
    if (next === null) return;
    // +1 so the timer fires after `paused_until > now` has become false.
    const delay = Math.min(Math.max(next - now + 1, 1), MAX_TIMER_MS);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      try {
        this.notifyStateChanged();
      } catch (err) {
        process.stderr.write(
          `[registry] applying an expired pause failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }, delay);
    this.pauseTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  reconcile(config: Config): ReconciliationStats {
    // Validate every cron trigger pattern up-front. If any fail, throw before
    // touching the DB.
    const failures: string[] = [];
    for (const job of config) {
      for (const trigger of job.triggers) {
        if (trigger.kind !== "cron") continue;
        try {
          validateCronExpression(trigger.schedule);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`${job.name}:${trigger.id}: ${msg}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new ConfigValidationError(failures);
    }

    const stats: ReconciliationStats = {
      jobs:     { added: 0, updated: 0, archived: 0, unchanged: 0 },
      triggers: { added: 0, updated: 0, archived: 0, unchanged: 0 },
    };

    const now = Date.now();

    const txn = this.db.transaction(() => {
      // --- Jobs ---
      const existingJobs = this.db
        .query<JobRow, []>("SELECT * FROM jobs")
        .all();
      const jobsByName = new Map<string, JobRow>();
      for (const row of existingJobs) jobsByName.set(row.name, row);

      const seenJobNames = new Set<string>();

      for (const job of config) {
        seenJobNames.add(job.name);
        const existing = jobsByName.get(job.name);
        if (!existing) {
          // INSERT new
          const jobId = uuidv4();
          this.db
            .prepare(
              `INSERT INTO jobs
                 (job_id, name, enabled, paused_until, archived_at,
                  last_seen_in_config_at, created_at)
               VALUES (?, ?, 1, NULL, NULL, ?, ?)`,
            )
            .run(jobId, job.name, now, now);
          stats.jobs.added++;
        } else if (existing.archived_at !== null) {
          // UN-archive
          this.db
            .prepare(
              `UPDATE jobs
                  SET archived_at = NULL,
                      last_seen_in_config_at = ?
                WHERE job_id = ?`,
            )
            .run(now, existing.job_id);
          stats.jobs.updated++;
        } else {
          // Just update last_seen
          this.db
            .prepare(
              `UPDATE jobs
                  SET last_seen_in_config_at = ?
                WHERE job_id = ?`,
            )
            .run(now, existing.job_id);
          stats.jobs.unchanged++;
        }
      }

      // Archive jobs no longer in config.
      for (const row of existingJobs) {
        if (seenJobNames.has(row.name)) continue;
        if (row.archived_at !== null) continue; // already archived
        this.db
          .prepare(`UPDATE jobs SET archived_at = ? WHERE job_id = ?`)
          .run(now, row.job_id);
        stats.jobs.archived++;
      }

      // --- Triggers ---
      // Re-read job rows so we have job_ids for newly inserted/un-archived ones.
      const refreshedJobs = this.db
        .query<JobRow, []>("SELECT * FROM jobs")
        .all();
      const jobIdByName = new Map<string, string>();
      for (const row of refreshedJobs) jobIdByName.set(row.name, row.job_id);

      const existingTriggers = this.db
        .query<TriggerRow, []>("SELECT * FROM triggers")
        .all();
      const triggersById = new Map<string, TriggerRow>();
      for (const row of existingTriggers) triggersById.set(row.trigger_id, row);

      const seenTriggerIds = new Set<string>();

      for (const job of config) {
        const jobId = jobIdByName.get(job.name);
        if (!jobId) continue; // shouldn't happen; we just inserted/upserted
        for (const trigger of job.triggers) {
          const triggerId = namespacedTriggerId(job.name, trigger.id);
          seenTriggerIds.add(triggerId);
          const configJson = stableTriggerJson(trigger);
          const existing = triggersById.get(triggerId);
          if (!existing) {
            this.db
              .prepare(
                `INSERT INTO triggers
                   (trigger_id, job_id, kind, config_json, enabled,
                    last_seen_in_config_at, archived_at, updated_at, created_at)
                 VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
              )
              .run(triggerId, jobId, trigger.kind, configJson, now, now, now);
            stats.triggers.added++;
          } else {
            const wasArchived = existing.archived_at !== null;
            const configChanged = existing.config_json !== configJson;
            const jobChanged = existing.job_id !== jobId;
            if (wasArchived || configChanged || jobChanged) {
              this.db
                .prepare(
                  `UPDATE triggers
                      SET job_id = ?,
                          kind = ?,
                          config_json = ?,
                          archived_at = NULL,
                          last_seen_in_config_at = ?,
                          updated_at = ?
                    WHERE trigger_id = ?`,
                )
                .run(jobId, trigger.kind, configJson, now, now, triggerId);
              stats.triggers.updated++;
            } else {
              this.db
                .prepare(
                  `UPDATE triggers
                      SET last_seen_in_config_at = ?
                    WHERE trigger_id = ?`,
                )
                .run(now, triggerId);
              stats.triggers.unchanged++;
            }
          }
        }
      }

      // Archive triggers no longer in config.
      for (const row of existingTriggers) {
        if (seenTriggerIds.has(row.trigger_id)) continue;
        if (row.archived_at !== null) continue;
        this.db
          .prepare(`UPDATE triggers SET archived_at = ? WHERE trigger_id = ?`)
          .run(now, row.trigger_id);
        stats.triggers.archived++;
      }
    });

    txn();

    // Rebuild in-memory cache from the DB (post-commit).
    this.rebuildCache(config);
    this.armPauseTimer();

    return stats;
  }

  // -------------------------------------------------------------------------
  // Registry impl
  // -------------------------------------------------------------------------

  resolve(jobName: string): { jobId: string; job: Automation } | null {
    return this.cache.get(jobName) ?? null;
  }

  activeJobs(): Automation[] {
    const out: Automation[] = [];
    for (const name of this.order) {
      const entry = this.cache.get(name);
      if (entry) out.push(entry.job);
    }
    return out;
  }

  activeCronJobs(): Automation[] {
    return this.activeJobsForTriggerKind("cron");
  }

  activeWebhookJobs(): Automation[] {
    return this.activeJobsForTriggerKind("webhook");
  }

  /**
   * Every job that declares a webhook trigger, whatever its enabled or pause
   * state. The webhook adapter routes from this list so a disabled or paused
   * job answers 503 with Retry-After (the sender retries) instead of a 404
   * that looks permanent. Admission itself is refused by the runner, and by
   * the adapter for a disabled trigger (`webhookTriggerEnabled`).
   */
  webhookJobs(): Automation[] {
    const out: Automation[] = [];
    for (const name of this.order) {
      const entry = this.cache.get(name);
      if (!entry) continue;
      const triggers = entry.job.triggers.filter((t) => t.kind === "webhook");
      if (triggers.length > 0) out.push({ ...entry.job, triggers });
    }
    return out;
  }

  /** Whether the trigger's own DB flag allows it to fire (read per call, so a toggle is immediate). */
  webhookTriggerEnabled(jobName: string, localId: string): boolean {
    const row = this.db
      .query<{ enabled: number }, [string]>(
        `SELECT enabled FROM triggers WHERE trigger_id = ? AND archived_at IS NULL`,
      )
      .get(`${jobName}:${localId}`);
    return row?.enabled === 1;
  }

  private activeJobsForTriggerKind(kind: Trigger["kind"]): Automation[] {
    // Read enabled / archived flags for triggers from DB so per-trigger DB
    // overrides are honored.
    const rows = this.db
      .query<TriggerRow, [string]>(
        `SELECT * FROM triggers WHERE kind = ? AND archived_at IS NULL AND enabled = 1`,
      )
      .all(kind);
    const enabledByJobAndLocalId = new Map<string, Set<string>>();
    for (const row of rows) {
      // trigger_id = "<jobName>:<localId>"; split on first ":".
      const idx = row.trigger_id.indexOf(":");
      if (idx <= 0) continue;
      const jobName = row.trigger_id.slice(0, idx);
      const localId = row.trigger_id.slice(idx + 1);
      let set = enabledByJobAndLocalId.get(jobName);
      if (!set) {
        set = new Set();
        enabledByJobAndLocalId.set(jobName, set);
      }
      set.add(localId);
    }

    // Read job-level state from DB (enabled + paused_until). A job is excluded
    // from scheduling if it is disabled (in the config or the DB) or paused.
    const jobStateRows = this.db
      .query<{ name: string; enabled: number; paused_until: number | null }, []>(
        `SELECT name, enabled, paused_until FROM jobs WHERE archived_at IS NULL`,
      )
      .all();
    const now = Date.now();
    const blockedJobs = new Set<string>();
    for (const row of jobStateRows) {
      if (row.enabled === 0) blockedJobs.add(row.name);
      else if (row.paused_until !== null && row.paused_until > now) blockedJobs.add(row.name);
    }

    const out: Automation[] = [];
    for (const name of this.order) {
      if (blockedJobs.has(name)) continue;
      const entry = this.cache.get(name);
      if (!entry) continue;
      // `enabled: false` in the config: never schedule it (a disabled job's
      // schedule would otherwise write a skipped row on every fire and run
      // conditional checkers for nothing).
      if (!entry.job.enabled) continue;
      const enabledLocalIds = enabledByJobAndLocalId.get(name);
      if (!enabledLocalIds || enabledLocalIds.size === 0) continue;
      const filteredTriggers = entry.job.triggers.filter(
        (t) => t.kind === kind && enabledLocalIds.has(t.id),
      );
      if (filteredTriggers.length === 0) continue;
      out.push({ ...entry.job, triggers: filteredTriggers });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  snapshot(): {
    jobs: { jobId: string; name: string; enabled: number; archived_at: number | null }[];
    triggers: { trigger_id: string; job_id: string; kind: string; enabled: number; archived_at: number | null }[];
  } {
    const jobs = this.db
      .query<
        { job_id: string; name: string; enabled: number; archived_at: number | null },
        []
      >(
        `SELECT job_id, name, enabled, archived_at
           FROM jobs
          ORDER BY created_at, name`,
      )
      .all()
      .map((r) => ({
        jobId: r.job_id,
        name: r.name,
        enabled: r.enabled,
        archived_at: r.archived_at,
      }));
    const triggers = this.db
      .query<
        { trigger_id: string; job_id: string; kind: string; enabled: number; archived_at: number | null },
        []
      >(
        `SELECT trigger_id, job_id, kind, enabled, archived_at
           FROM triggers
          ORDER BY created_at, trigger_id`,
      )
      .all();
    return { jobs, triggers };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private rebuildCache(config: Config): void {
    this.cache.clear();
    this.order = [];
    const rows = this.db
      .query<JobRow, []>(
        `SELECT * FROM jobs WHERE archived_at IS NULL`,
      )
      .all();
    const jobIdByName = new Map<string, string>();
    for (const row of rows) jobIdByName.set(row.name, row.job_id);

    for (const job of config) {
      const jobId = jobIdByName.get(job.name);
      if (!jobId) continue; // shouldn't happen
      this.cache.set(job.name, { jobId, job });
      this.order.push(job.name);
    }
  }
}
