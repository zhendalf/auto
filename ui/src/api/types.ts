/**
 * The API's JSON shapes as the UI uses them. Kept free of DOM and React so the
 * pure helpers under util/ (and their tests) can import them.
 */

/** Where the next page of runs starts (send back as `before` / `before_id`). */
export type RunsCursor = { before: number; before_id: string };
export type RunsPage = { runs: Run[]; next: RunsCursor | null };

/** A slice of a run's log, read from a byte offset. */
export type LogChunk =
  | {
      kind: "data";
      bytes: Uint8Array;
      /** Total size of the log file when the slice was read. */
      size: number;
      state: string | null;
    }
  // No log file (yet): queued or skipped runs, or a run that wrote nothing.
  | { kind: "none"; size: 0; state: string | null; reason: "no_log" | "log_missing" }
  // The offset is past the end: the log was truncated or replaced.
  | { kind: "reset"; size: number; state: string | null };

export type Job = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** `enabled: false` in the config file, independent of the disable button. */
  config_enabled?: boolean;
  paused_until: number | null;
  archived_at: number | null;
  reentrancy: string;
  queueDepth: number;
  timeoutMs: number;
  killGraceMs: number;
  triggers: Trigger[];
  last_run: LastRun | null;
  /** The run in flight (running, else the oldest queued), or null. */
  active_run?: ActiveRun | null;
};
export type ActiveRun = { run_id: string; state: string; started_at: number | null };
export type Trigger = {
  trigger_id: string;
  kind: string;
  enabled: boolean;
  /** Cron: epoch ms of the next fire, null when nothing is scheduled (disabled, paused, degraded). */
  next_run_at?: number | null;
  /** Cron with a checker. */
  condition?: { checker: string; timeoutMs: number };
  /** Webhook: public path (/hooks/<path>). The secret value is never sent. */
  public_path?: string;
  secretRef?: string;
  signatureHeader?: string;
  deliveryIdHeader?: string | null;
  contentTypes?: string[];
  maxBodyBytes?: number;
  /** Whether the webhook secret currently has a value. */
  secret_present?: boolean;
  /** Cron: the five-field expression. */
  schedule?: string;
  [k: string]: unknown;
};
export type LastRun = { run_id: string; state: string; finished_at: number | null };
export type JobDetail = Job & { recent_runs: Run[] };
export type Run = {
  run_id: string;
  job_id: string;
  job_name: string;
  trigger_kind: string;
  trigger_id: string | null;
  state: string;
  exit_code: number | null;
  signal: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  log_path: string | null;
  definition_hash: string | null;
  /**
   * Why a run was skipped, or ended without a normal exit (overlap, paused,
   * disabled, supervisor_interrupted, spawn_error, ...). Null for an ordinary
   * run; absent on a supervisor older than this field.
   */
  skip_reason?: string | null;
};
export type RunDetail = Run & { trigger_meta: unknown };
/** `status` 200: started now. 202: queued behind a running one, at `position`. */
export type RunResult = { run_id: string; status: 200 | 202; position?: number };
/** A problem that does not stop the config from loading (for example a webhook secret that is not set). */
export type ConfigWarning = { code: string; job: string; trigger_id: string; message: string };
export type ReloadResult = {
  ok: true;
  jobs: number;
  triggers: number;
  warnings?: ConfigWarning[];
  changes?: { added: string[]; removed: string[]; changed: string[] };
};
export type ConfigStatus = {
  ok: boolean;
  loadedAt: number | null;
  lastError: { at: number; message: string } | null;
  jobs: number;
  triggers: number;
  degraded: { active: boolean; reason: { kind: string; message: string } | null };
  warnings?: ConfigWarning[];
};
