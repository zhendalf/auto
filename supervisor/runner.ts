import type { Database, Statement } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { resolve as resolvePath, relative as relativePath } from "node:path";
import { Buffer } from "node:buffer";
import type { Subprocess } from "bun";
import type { Automation } from "./config.ts";
import { allowlistedEnv, processGroupSpawnOption, signalProcessGroup } from "./child-process.ts";
import { DATA_DIR } from "./db/connection.ts";
import { uuidv7 } from "./db/ids.ts";
import { LogCapture, type Secret } from "./log-capture.ts";
import { isGroupAlive } from "./process-identity.ts";

// ---------------------------------------------------------------------------
// Shutdown contract (shared with supervisor/main.ts)
// ---------------------------------------------------------------------------

/**
 * Default grace period main.ts passes to `Runner.shutdown()`: how long running
 * workers get between SIGTERM and SIGKILL (per job it is further capped by the
 * job's own killGraceMs).
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/**
 * `Runner.shutdown(graceMs)` always resolves within graceMs plus this slack,
 * even if a worker cannot be killed or the database wedges: after
 * graceMs + FORCE_FINALIZE_AFTER_MS any run still unsettled is finalized
 * forcibly.
 */
export const SHUTDOWN_SETTLE_SLACK_MS = 2_000;
const FORCE_FINALIZE_AFTER_MS = 1_500;

/**
 * Extra time main.ts should allow on top of graceMs before its own
 * process.exit failsafe fires. It must exceed SHUTDOWN_SETTLE_SLACK_MS plus
 * the time to stop the HTTP server and close the DB, or the failsafe would cut
 * the runner off while it is still recording final run states.
 */
export const SHUTDOWN_HARD_DEADLINE_SLACK_MS = 5_000;

export function shutdownHardDeadlineMs(graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS): number {
  return graceMs + SHUTDOWN_HARD_DEADLINE_SLACK_MS;
}

/** How long to keep reading a worker's stdout/stderr after it has exited. */
const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

/** setTimeout treats delays above 2^31-1 ms (~24.8 days) as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TriggerCtx =
  | { kind: "cron";    trigger_id: string; fire_at: number; meta?: unknown }
  | { kind: "manual";  reason?: string }
  | { kind: "webhook"; trigger_id: string; meta: unknown; payloadPath?: string }
  | { kind: "watch";   trigger_id: string; meta: unknown };

export type EnqueueOpts = { force?: boolean };

export type SkipReason = "overlap" | "queue_full" | "disabled" | "paused" | "shutdown";

export type EnqueueResult =
  | { kind: "started";  run_id: string }
  | { kind: "queued";   run_id: string; position: number }
  | { kind: "skipped";  run_id: string; reason: SkipReason }
  | { kind: "conflict"; running_run_id: string };

export type RunFinishedEvent = {
  run_id: string;
  job_id: string;
  state: "succeeded" | "failed" | "timed_out" | "killed";
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  /** Why the run ended abnormally on the supervisor's side (spawn_error, finalize_error, supervisor_shutdown). */
  reason?: string;
};

export type Registry = {
  resolve(jobName: string): { jobId: string; job: Automation } | null;
};

export type RunnerOptions = {
  db: Database;
  registry: Registry;
  secrets?: () => Secret[];
  /** Resolved absolute path; used as worker cwd. */
  workspaceRoot: string;
  /** Defaults to process.execPath. */
  bunPath?: string;
  /** The data root that log_path is stored relative to (per Q-06). Defaults to DATA_DIR. */
  dataDir?: string;
  /** Defaults to <dataDir>/runs. */
  logsDir?: string;
  /** Hook for tests/mocks. Defaults to real Bun.spawn. */
  spawn?: typeof Bun.spawn;
  /** stdout+stderr capture cap. Defaults to 5 MiB. */
  maxLogBytes?: number;
  /**
   * How long to keep draining stdout/stderr after the worker has exited.
   * A background child that inherited the pipes would otherwise keep them
   * open forever. Defaults to 3 s.
   */
  drainTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type RunHandleState = "queued" | "running";

/** One stdout/stderr reader; `cancel()` abandons it when the pipe never closes. */
type Drain = { done: Promise<void>; cancel(): void };

type RunHandle = {
  runId: string;
  jobId: string;
  jobName: string;
  job: Automation;
  ctx: TriggerCtx;
  state: RunHandleState;
  startedAt: number | null;
  child: Subprocess<"ignore", "pipe", "pipe"> | null;
  capture: LogCapture | null;
  logRelPath: string | null;
  drains: Drain[] | null;
  // Lifecycle flags so the exit handler picks the right terminal state.
  cancelledByUser: boolean;
  timedOut: boolean;
  shutdownKilled: boolean;
  // Set once the DB row is final and the handle has left the runner's maps;
  // whoever gets there first (normal exit path or forced shutdown) wins.
  finalized: boolean;
  // Timers (cleared on natural exit).
  termTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  killDeadline: number | null;
  // Resolved when the run is completely settled (after capture flush + DB update).
  finished: Promise<void>;
  finishResolve: () => void;
};

type PerJobState = {
  running: Set<RunHandle>;
  queue: RunHandle[];
};

type FinalSummary = {
  state: RunFinishedEvent["state"];
  exit_code: number | null;
  signal: string | null;
  reason: string | null;
  finishedAt: number;
};

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

// While shutting down the post-exit waits are shortened; shutdown() has its
// own hard bound on top of these.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 300;
const POST_KILL_DRAIN_WAIT_MS = 1_000;
const POST_CANCEL_DRAIN_WAIT_MS = 500;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class Runner extends EventEmitter {
  private readonly db: Database;
  private readonly registry: Registry;
  private readonly secrets: () => Secret[];
  private readonly workspaceRoot: string;
  private readonly bunPath: string;
  private readonly dataDir: string;
  private readonly logsDir: string;
  private readonly spawn: typeof Bun.spawn;
  private readonly maxLogBytes: number;
  private readonly drainTimeoutMs: number;

  // Job-name keyed in-memory state.
  private readonly perJob = new Map<string, PerJobState>();
  // run_id → RunHandle, for cancel lookup and `active()`.
  private readonly byRunId = new Map<string, RunHandle>();

  // Once set, no run is admitted or promoted from a queue any more.
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  // SIGKILLs owed to process groups whose leader already exited after a
  // deliberate stop; a member that ignored SIGTERM must not outlive them.
  private readonly pendingReaps = new Set<{ pid: number; timer: ReturnType<typeof setTimeout> }>();

  private readonly stmts: {
    insertNew: Statement;
    insertSkip: Statement;
    markStart: Statement;
    markFinished: Statement;
    markCancelledQueued: Statement;
    selectRun: Statement;
    selectJobState: Statement;
  };

  constructor(opts: RunnerOptions) {
    super();
    this.db = opts.db;
    this.registry = opts.registry;
    this.secrets = opts.secrets ?? (() => []);
    this.workspaceRoot = opts.workspaceRoot;
    this.bunPath = opts.bunPath ?? process.execPath;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.logsDir = opts.logsDir ?? `${this.dataDir}/runs`;
    this.spawn = opts.spawn ?? Bun.spawn;
    this.maxLogBytes = opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    this.stmts = {
      insertNew: this.db.prepare(
        `INSERT INTO runs (
           run_id, job_id, trigger_id, trigger_kind, state,
           enqueued_at, trigger_meta, worker_path, cwd, definition_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertSkip: this.db.prepare(
        `INSERT INTO runs (
           run_id, job_id, trigger_id, trigger_kind, state, skip_reason,
           enqueued_at, finished_at, trigger_meta, worker_path, cwd, definition_hash
         ) VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?, ?)`,
      ),
      markStart: this.db.prepare(
        `UPDATE runs
            SET started_at = ?, state = 'running', pid = ?, log_path = ?
          WHERE run_id = ?`,
      ),
      // skip_reason doubles as the "why" for runs the supervisor itself ended
      // (spawn_error, finalize_error, supervisor_shutdown, cancelled, ...).
      // The state guard keeps a late writer from clobbering a row someone else
      // (e.g. crash recovery) already finalized.
      markFinished: this.db.prepare(
        `UPDATE runs
            SET finished_at = ?, state = ?, signal = ?, exit_code = ?,
                skip_reason = COALESCE(?, skip_reason)
          WHERE run_id = ? AND state IN ('queued', 'running')`,
      ),
      markCancelledQueued: this.db.prepare(
        `UPDATE runs
            SET state = 'cancelled', finished_at = ?, skip_reason = ?
          WHERE run_id = ? AND state = 'queued'`,
      ),
      selectRun: this.db.prepare(
        `SELECT state FROM runs WHERE run_id = ?`,
      ),
      selectJobState: this.db.prepare(
        `SELECT enabled, paused_until FROM jobs WHERE job_id = ?`,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  override on(ev: string, listener: (...args: any[]) => void): this {
    return super.on(ev, listener);
  }

  override off(ev: string, listener: (...args: any[]) => void): this {
    return super.off(ev, listener);
  }

  active(): { jobId: string; runId: string; state: "queued" | "running"; startedAt: number | null }[] {
    const out: { jobId: string; runId: string; state: "queued" | "running"; startedAt: number | null }[] = [];
    for (const h of this.byRunId.values()) {
      out.push({ jobId: h.jobId, runId: h.runId, state: h.state, startedAt: h.startedAt });
    }
    return out;
  }

  /**
   * Admission control. Order of checks:
   *  1. unknown job → throws;
   *  2. shutting down → skipped(shutdown) (every trigger, force included);
   *  3. job disabled (config `enabled: false` or the DB flag) → skipped(disabled);
   *  4. job paused (DB `paused_until` in the future) → skipped(paused);
   *  5. reentrancy policy → started / queued / skipped(overlap|queue_full),
   *     or `conflict` for a manual run on a busy job.
   * Steps 3-4 apply to cron, webhook, condition and manual runs alike. The one
   * documented bypass is a manual run with `force`, which starts regardless of
   * enabled/paused/reentrancy.
   */
  async enqueue(jobName: string, ctx: TriggerCtx, opts?: EnqueueOpts): Promise<EnqueueResult> {
    const resolved = this.registry.resolve(jobName);
    if (!resolved) throw new Error(`unknown job: ${jobName}`);
    const { jobId, job } = resolved;
    const manualForce = ctx.kind === "manual" && opts?.force === true;

    if (this.shuttingDown) {
      try {
        return this.recordSkipped(jobId, jobName, job, ctx, "shutdown");
      } catch {
        // The DB may already be closing; nothing sensible to record.
        throw new Error("supervisor is shutting down");
      }
    }

    if (!manualForce) {
      const blocked = this.admissionBlock(jobId, job);
      if (blocked) return this.recordSkipped(jobId, jobName, job, ctx, blocked);
    }

    const state = this.getJobState(jobName);

    // Manual + force: behave as parallel, ignoring reentrancy gate.
    if (manualForce) {
      return this.startNow(jobId, jobName, job, ctx);
    }

    // Manual with conflict: explicit response, no DB row written.
    if (ctx.kind === "manual") {
      if (state.running.size > 0) {
        const running = state.running.values().next().value as RunHandle;
        return { kind: "conflict", running_run_id: running.runId };
      }
      return this.startNow(jobId, jobName, job, ctx);
    }

    // Non-manual (cron/webhook/watch): apply reentrancy.
    const policy = job.reentrancy;
    if (policy === "parallel") {
      return this.startNow(jobId, jobName, job, ctx);
    }
    if (state.running.size === 0) {
      return this.startNow(jobId, jobName, job, ctx);
    }
    if (policy === "drop") {
      return this.recordSkipped(jobId, jobName, job, ctx, "overlap");
    }
    // queue
    if (state.queue.length >= job.queueDepth) {
      return this.recordSkipped(jobId, jobName, job, ctx, "queue_full");
    }
    return this.recordQueued(jobId, jobName, job, ctx, state);
  }

  async cancel(runId: string): Promise<{ ok: boolean; previous_state: string }> {
    const handle = this.byRunId.get(runId);
    if (!handle) {
      const row = this.stmts.selectRun.get(runId) as { state: string } | null;
      return { ok: false, previous_state: row?.state ?? "unknown" };
    }
    if (handle.state === "queued") {
      this.cancelQueuedHandle(handle, "cancelled");
      return { ok: true, previous_state: "queued" };
    }
    // Running: SIGTERM the process group, schedule SIGKILL, flag as user-cancelled.
    handle.cancelledByUser = true;
    this.beginTermination(handle, handle.job.killGraceMs);
    return { ok: true, previous_state: "running" };
  }

  /**
   * Stop everything and settle the database. Idempotent (later calls return the
   * first call's promise).
   *
   *  - From the first instant no run is admitted and no queued run is promoted.
   *  - Queued runs are marked cancelled (skip_reason `supervisor_shutdown`).
   *  - Every running worker's process group gets SIGTERM, then SIGKILL after
   *    min(job.killGraceMs, graceMs). Those runs end as `killed` (or
   *    `timed_out` if the timeout had already fired), skip_reason
   *    `supervisor_shutdown`.
   *  - Resolves within graceMs + SHUTDOWN_SETTLE_SLACK_MS no matter what:
   *    anything still unsettled after graceMs + 1.5 s is force-finalized.
   *
   * main.ts owns the signals and its process.exit failsafe should be
   * `shutdownHardDeadlineMs(graceMs)`.
   */
  shutdown(graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true;
      this.shutdownPromise = this.runShutdown(Math.max(0, graceMs));
    }
    return this.shutdownPromise;
  }

  // -------------------------------------------------------------------------
  // Shutdown internals
  // -------------------------------------------------------------------------

  private async runShutdown(graceMs: number): Promise<void> {
    // Queued runs never got a process: cancel them outright.
    for (const js of this.perJob.values()) {
      for (const handle of js.queue.splice(0)) {
        this.cancelQueuedHandle(handle, "supervisor_shutdown");
      }
    }

    // Groups already owed a SIGKILL get it now; shutdown has no time to spare.
    for (const reap of [...this.pendingReaps]) {
      clearTimeout(reap.timer);
      this.pendingReaps.delete(reap);
      killGroup(reap.pid);
    }

    const live = [...this.byRunId.values()];
    for (const handle of live) {
      handle.shutdownKilled = true;
      this.beginTermination(handle, Math.min(handle.job.killGraceMs, graceMs));
    }

    const settled = Promise.all(live.map((h) => h.finished));
    await settlesWithin(settled, graceMs + FORCE_FINALIZE_AFTER_MS);

    // Whatever is still unsettled (unkillable process, wedged pipe, stuck DB
    // write) is finalized without waiting for it any longer.
    for (const handle of [...this.byRunId.values()]) {
      this.forceFinalize(handle);
    }
  }

  private forceFinalize(handle: RunHandle): void {
    this.clearTimers(handle);
    this.signal(handle, "SIGKILL");
    for (const d of handle.drains ?? []) d.cancel();
    if (handle.capture) void handle.capture.close().catch(() => {});
    this.finalizeHandle(handle, {
      state: handle.timedOut ? "timed_out" : "killed",
      exit_code: null,
      signal: "SIGKILL",
      reason: "supervisor_shutdown",
      finishedAt: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Admission / queue internals
  // -------------------------------------------------------------------------

  private getJobState(jobName: string): PerJobState {
    let s = this.perJob.get(jobName);
    if (!s) {
      s = { running: new Set(), queue: [] };
      this.perJob.set(jobName, s);
    }
    return s;
  }

  /**
   * Why this job may not run right now, or null. The config-level flag and the
   * DB-level flags (set by `auto disable` / `auto pause` and trigger toggles)
   * are both honored. A job without a jobs row simply has no DB overrides.
   */
  private admissionBlock(jobId: string, job: Automation): "disabled" | "paused" | null {
    if (!job.enabled) return "disabled";
    const row = this.stmts.selectJobState.get(jobId) as
      | { enabled: number; paused_until: number | null }
      | null;
    if (!row) return null;
    if (row.enabled === 0) return "disabled";
    if (row.paused_until !== null && row.paused_until > Date.now()) return "paused";
    return null;
  }

  private newHandle(jobId: string, jobName: string, job: Automation, ctx: TriggerCtx, runId: string): RunHandle {
    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinished = r;
    });
    return {
      runId,
      jobId,
      jobName,
      job,
      ctx,
      state: "queued",
      startedAt: null,
      child: null,
      capture: null,
      logRelPath: null,
      drains: null,
      cancelledByUser: false,
      timedOut: false,
      shutdownKilled: false,
      finalized: false,
      termTimer: null,
      killTimer: null,
      killDeadline: null,
      finished,
      finishResolve: resolveFinished,
    };
  }

  private recordSkipped(
    jobId: string,
    jobName: string,
    job: Automation,
    ctx: TriggerCtx,
    reason: SkipReason,
  ): EnqueueResult {
    const runId = uuidv7();
    const now = Date.now();
    const triggerId = triggerIdFor(jobName, ctx);
    const meta = JSON.stringify(triggerMetaFor(ctx));
    const workerPath = absoluteWorkerPath(this.workspaceRoot, job.worker);
    const defHash = definitionHash(job);
    this.stmts.insertSkip.run(
      runId,
      jobId,
      triggerId,
      ctx.kind,
      reason,
      now,
      now,
      meta,
      workerPath,
      this.workspaceRoot,
      defHash,
    );
    this.safeEmit("run.skipped", { run_id: runId, job_id: jobId, reason });
    return { kind: "skipped", run_id: runId, reason };
  }

  private recordQueued(
    jobId: string,
    jobName: string,
    job: Automation,
    ctx: TriggerCtx,
    state: PerJobState,
  ): EnqueueResult {
    const runId = uuidv7();
    const now = Date.now();
    const triggerId = triggerIdFor(jobName, ctx);
    const meta = JSON.stringify(triggerMetaFor(ctx));
    const workerPath = absoluteWorkerPath(this.workspaceRoot, job.worker);
    const defHash = definitionHash(job);
    this.stmts.insertNew.run(
      runId,
      jobId,
      triggerId,
      ctx.kind,
      "queued",
      now,
      meta,
      workerPath,
      this.workspaceRoot,
      defHash,
    );
    const handle = this.newHandle(jobId, jobName, job, ctx, runId);
    state.queue.push(handle);
    this.byRunId.set(runId, handle);
    const position = state.queue.length;
    this.safeEmit("run.queued", { run_id: runId, job_id: jobId, position });
    return { kind: "queued", run_id: runId, position };
  }

  private startNow(jobId: string, jobName: string, job: Automation, ctx: TriggerCtx): EnqueueResult {
    const runId = uuidv7();
    const now = Date.now();
    const triggerId = triggerIdFor(jobName, ctx);
    const meta = JSON.stringify(triggerMetaFor(ctx));
    const workerPath = absoluteWorkerPath(this.workspaceRoot, job.worker);
    const defHash = definitionHash(job);

    // Insert as queued first, immediately mark started — keeps the row schema
    // consistent regardless of path taken.
    this.stmts.insertNew.run(
      runId,
      jobId,
      triggerId,
      ctx.kind,
      "queued",
      now,
      meta,
      workerPath,
      this.workspaceRoot,
      defHash,
    );

    const handle = this.newHandle(jobId, jobName, job, ctx, runId);
    this.byRunId.set(runId, handle);
    this.getJobState(jobName).running.add(handle);
    this.spawnHandle(handle, workerPath);
    return { kind: "started", run_id: runId };
  }

  /** Remove a queued run without ever starting it. */
  private cancelQueuedHandle(handle: RunHandle, reason: string): void {
    const js = this.getJobState(handle.jobName);
    const idx = js.queue.indexOf(handle);
    if (idx >= 0) js.queue.splice(idx, 1);
    this.byRunId.delete(handle.runId);
    handle.finalized = true;
    try {
      this.stmts.markCancelledQueued.run(Date.now(), reason, handle.runId);
    } catch (err) {
      warn(`could not record cancelled run ${handle.runId}: ${errorMessage(err)}`);
    }
    handle.finishResolve();
    this.safeEmit("run.skipped", { run_id: handle.runId, job_id: handle.jobId, reason });
  }

  /**
   * Start the next queued run for a job once nothing else is running. Runs
   * whose job was disabled or paused while they waited are cancelled instead
   * of started. Never promotes during shutdown.
   */
  private promoteNext(js: PerJobState): void {
    while (!this.shuttingDown && js.running.size === 0) {
      const next = js.queue.shift();
      if (!next) return;
      let blocked: "disabled" | "paused" | null = null;
      try {
        // The Automation captured when the run was queued may be stale (a hot
        // reload can have set enabled: false, or removed the job): the registry
        // knows the current definition. The run itself keeps its old job for
        // spawning, so a reload never changes what an already queued run does.
        const current = this.registry.resolve(next.jobName);
        blocked = current ? this.admissionBlock(next.jobId, current.job) : "disabled";
      } catch (err) {
        warn(`admission check failed for queued run ${next.runId}: ${errorMessage(err)}`);
      }
      if (blocked) {
        this.cancelQueuedHandle(next, blocked);
        continue;
      }
      js.running.add(next);
      this.spawnHandle(next, absoluteWorkerPath(this.workspaceRoot, next.job.worker));
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Spawn / exit
  // -------------------------------------------------------------------------

  private spawnHandle(handle: RunHandle, workerPath: string): void {
    const startedAt = Date.now();
    handle.state = "running";
    handle.startedAt = startedAt;

    const logRelToLogsDir = relativeLogPath(handle.runId, startedAt);
    const logAbs = `${this.logsDir}/${logRelToLogsDir}`;
    // Stored path is relative to dataDir per Q-06 (consumers do `${dataDir}/${log_path}`).
    const logRel = relativePath(this.dataDir, logAbs);

    // The capture constructor touches the filesystem (mkdir/open) and can
    // throw; that must end the run as failed, not leave a queued row behind.
    let capture: LogCapture;
    try {
      capture = new LogCapture({
        filePath: logAbs,
        maxBytes: this.maxLogBytes,
        secrets: this.secrets,
        dirRoot: this.logsDir,
      });
    } catch (err) {
      this.failStart(handle, startedAt, null, null, `could not open run log: ${errorMessage(err)}`);
      return;
    }
    handle.capture = capture;
    handle.logRelPath = logRel;

    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      const env = buildChildEnv(handle.jobName, handle.jobId, handle.ctx, handle.runId);
      child = this.spawn([this.bunPath, workerPath], {
        cwd: this.workspaceRoot,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Own process group, so timeout/cancel/shutdown reach grandchildren too.
        ...processGroupSpawnOption(),
      }) as Subprocess<"ignore", "pipe", "pipe">;
    } catch (err) {
      // Spawn failed before the process started.
      this.failStart(handle, startedAt, logRel, capture, `spawn failed: ${errorMessage(err)}`);
      return;
    }

    handle.child = child;
    try {
      this.stmts.markStart.run(startedAt, child.pid ?? null, logRel, handle.runId);
    } catch (err) {
      // Not fatal: the worker is already running, finalization will try again.
      warn(`could not record start of run ${handle.runId}: ${errorMessage(err)}`);
    }
    this.safeEmit("run.started", { run_id: handle.runId, job_id: handle.jobId });

    // stdout/stderr drain. Order between streams is best-effort interleave.
    const drains = [drainStream(child.stdout, capture, "stdout"), drainStream(child.stderr, capture, "stderr")];
    handle.drains = drains;

    // Timeout escalation.
    handle.termTimer = setTimeout(() => {
      handle.termTimer = null;
      handle.timedOut = true;
      this.beginTermination(handle, handle.job.killGraceMs);
    }, clampTimer(handle.job.timeoutMs));

    void this.superviseExit(handle, child, capture, drains).catch((err) => {
      // superviseExit handles its own failures; this is the last line of
      // defence so an unexpected throw can never become an unhandled rejection
      // or leave the job wedged.
      warn(`run ${handle.runId} exit handling failed: ${errorMessage(err)}`);
      this.clearTimers(handle);
      this.finalizeHandle(handle, {
        state: "failed",
        exit_code: null,
        signal: null,
        reason: "finalize_error",
        finishedAt: Date.now(),
      });
    });
  }

  /**
   * The run could not be started (log or spawn failure). The row is finalized
   * as failed with reason spawn_error and the job is released.
   */
  private failStart(
    handle: RunHandle,
    startedAt: number,
    logRel: string | null,
    capture: LogCapture | null,
    message: string,
  ): void {
    handle.capture = capture;
    handle.logRelPath = logRel;
    try {
      this.stmts.markStart.run(startedAt, null, logRel, handle.runId);
    } catch (err) {
      warn(`could not record start of run ${handle.runId}: ${errorMessage(err)}`);
    }
    this.safeEmit("run.started", { run_id: handle.runId, job_id: handle.jobId });
    void (async () => {
      try {
        if (capture) {
          await capture.write(`[runner] ${message}\n`, "runner");
          await capture.close();
        }
      } catch {
        // best-effort
      }
      this.finalizeHandle(handle, {
        state: "failed",
        exit_code: null,
        signal: null,
        reason: "spawn_error",
        finishedAt: Date.now(),
      });
    })();
  }

  /**
   * Waits for the worker to exit, bounds the pipe drain, then records the
   * outcome. Never rejects: whatever goes wrong, finalizeHandle (and with it
   * cleanupAfterExit, which releases the job and promotes the queue) runs.
   */
  private async superviseExit(
    handle: RunHandle,
    child: Subprocess<"ignore", "pipe", "pipe">,
    capture: LogCapture,
    drains: Drain[],
  ): Promise<void> {
    let rawExit: number | null = null;
    let reason: string | null = null;
    try {
      rawExit = await child.exited;
    } catch (err) {
      warn(`run ${handle.runId}: waiting for exit failed: ${errorMessage(err)}`);
      reason = "finalize_error";
    }
    // The worker is done. A timeout that has not fired yet no longer applies:
    // waiting for a background process that holds the pipes open must not turn
    // a run that finished in time into a timed_out one.
    if (handle.termTimer) {
      clearTimeout(handle.termTimer);
      handle.termTimer = null;
    }
    this.reapGroupAfterStop(handle, child);
    try {
      await this.settleDrains(handle, drains, capture);
    } catch (err) {
      warn(`run ${handle.runId}: draining output failed: ${errorMessage(err)}`);
    }
    this.clearTimers(handle);
    try {
      await capture.close();
    } catch (err) {
      warn(`run ${handle.runId}: closing log failed: ${errorMessage(err)}`);
    }
    // Force-finalized by shutdown while we were waiting: nothing left to do.
    if (handle.finalized) return;

    const { state, exitCode, signalName } = classifyExit(rawExit, child, handle);
    if (!reason && handle.shutdownKilled && state === "killed") reason = "supervisor_shutdown";
    else if (!reason && handle.cancelledByUser && state === "killed") reason = "cancelled";
    this.finalizeHandle(handle, {
      state: reason === "finalize_error" ? "failed" : state,
      exit_code: exitCode,
      signal: signalName,
      reason,
      finishedAt: Date.now(),
    });
  }

  /**
   * The leader of a deliberately stopped run (timeout, cancel, shutdown) has
   * exited. Other members of its process group may have ignored the SIGTERM and,
   * holding none of the worker's pipes, nothing else would ever signal them:
   * make sure they get their SIGKILL when the kill deadline passes (at once
   * during shutdown, or when no deadline is pending any more).
   */
  private reapGroupAfterStop(handle: RunHandle, child: Subprocess<"ignore", "pipe", "pipe">): void {
    if (!(handle.timedOut || handle.cancelledByUser || handle.shutdownKilled)) return;
    const pid = child.pid;
    if (typeof pid !== "number" || !isGroupAlive(pid)) return;
    const remaining = handle.killDeadline === null ? 0 : handle.killDeadline - Date.now();
    if (this.shuttingDown || remaining <= 0) {
      killGroup(pid);
      return;
    }
    const reap = {
      pid,
      timer: setTimeout(() => {
        this.pendingReaps.delete(reap);
        killGroup(pid);
      }, remaining),
    };
    // A pending reap must not keep the supervisor alive on its own.
    reap.timer.unref?.();
    this.pendingReaps.add(reap);
  }

  /**
   * After the worker exited, wait (bounded) for its stdout/stderr to reach EOF.
   * A grandchild that inherited the pipes and keeps running holds them open
   * indefinitely; past the deadline the readers are abandoned and the log says
   * so. If the run was being terminated on purpose the leftover process group
   * is killed first, since whatever still holds the pipes is by definition part
   * of the job that was told to stop.
   */
  private async settleDrains(handle: RunHandle, drains: Drain[], capture: LogCapture): Promise<void> {
    const all = Promise.all(drains.map((d) => d.done));
    const waitMs = this.shuttingDown ? Math.min(this.drainTimeoutMs, SHUTDOWN_DRAIN_TIMEOUT_MS) : this.drainTimeoutMs;
    if (await settlesWithin(all, waitMs)) return;

    if (handle.timedOut || handle.cancelledByUser || handle.shutdownKilled) {
      this.signal(handle, "SIGKILL");
      if (await settlesWithin(all, POST_KILL_DRAIN_WAIT_MS)) return;
    }
    for (const d of drains) d.cancel();
    await settlesWithin(all, POST_CANCEL_DRAIN_WAIT_MS);
    await capture.write(
      `\n[runner] output pipes still open ${waitMs}ms after the worker exited ` +
        `(a background process kept them open); later output was not captured\n`,
      "runner",
    );
  }

  /**
   * Write the final DB state and release the run. Exactly one caller wins per
   * handle. A failing DB write is retried once as failed/finalize_error; if
   * even that fails the row is left for startup recovery, but the handle is
   * still released so the job does not wedge.
   */
  private finalizeHandle(handle: RunHandle, summary: FinalSummary): void {
    if (handle.finalized) return;
    handle.finalized = true;
    let effective = summary;
    try {
      this.stmts.markFinished.run(
        summary.finishedAt,
        summary.state,
        summary.signal,
        summary.exit_code,
        summary.reason,
        handle.runId,
      );
    } catch (err) {
      warn(`could not record result of run ${handle.runId}: ${errorMessage(err)}`);
      effective = { ...summary, state: "failed", reason: "finalize_error" };
      try {
        this.stmts.markFinished.run(
          summary.finishedAt,
          "failed",
          summary.signal,
          summary.exit_code,
          "finalize_error",
          handle.runId,
        );
      } catch (err2) {
        warn(`could not record failure of run ${handle.runId}: ${errorMessage(err2)}`);
      }
    }
    this.cleanupAfterExit(handle, {
      state: effective.state,
      exit_code: effective.exit_code,
      signal: effective.signal,
      duration_ms: effective.finishedAt - (handle.startedAt ?? effective.finishedAt),
      ...(effective.reason ? { reason: effective.reason } : {}),
    });
  }

  private cleanupAfterExit(handle: RunHandle, summary: Omit<RunFinishedEvent, "run_id" | "job_id">): void {
    const js = this.getJobState(handle.jobName);
    js.running.delete(handle);
    this.byRunId.delete(handle.runId);
    this.clearTimers(handle);
    handle.finishResolve();
    this.safeEmit("run.finished", { run_id: handle.runId, job_id: handle.jobId, ...summary });

    // Promote next queued run for this job, if any.
    try {
      this.promoteNext(js);
    } catch (err) {
      warn(`could not start the next queued run for ${handle.jobName}: ${errorMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Signals and timers
  // -------------------------------------------------------------------------

  private signal(handle: RunHandle, signal: NodeJS.Signals): void {
    if (handle.child) signalProcessGroup(handle.child, signal);
  }

  /**
   * SIGTERM the run's process group and arrange SIGKILL after `graceMs`
   * (keeping an earlier pending kill deadline if there already is one).
   * On Windows there is no SIGTERM/grace distinction: the first signal already
   * terminates the process, so killGraceMs only delays a redundant second kill.
   */
  private beginTermination(handle: RunHandle, graceMs: number): void {
    if (!handle.child || handle.finalized) return;
    this.signal(handle, "SIGTERM");
    const grace = clampTimer(graceMs);
    const deadline = Date.now() + grace;
    if (handle.killTimer && handle.killDeadline !== null && handle.killDeadline <= deadline) return;
    if (handle.killTimer) clearTimeout(handle.killTimer);
    handle.killDeadline = deadline;
    handle.killTimer = setTimeout(() => {
      handle.killTimer = null;
      handle.killDeadline = null;
      this.signal(handle, "SIGKILL");
    }, grace);
  }

  private clearTimers(handle: RunHandle): void {
    if (handle.termTimer) {
      clearTimeout(handle.termTimer);
      handle.termTimer = null;
    }
    if (handle.killTimer) {
      clearTimeout(handle.killTimer);
      handle.killTimer = null;
    }
    handle.killDeadline = null;
  }

  /** emit() that cannot throw: a misbehaving listener must not break run bookkeeping. */
  private safeEmit(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (err) {
      warn(`listener for ${event} threw: ${errorMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warn(message: string): void {
  try {
    process.stderr.write(`[runner] ${message}\n`);
  } catch {
    // stderr closed
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SIGKILL a process group by pgid; a group that is already gone is not an error. */
function killGroup(pgid: number): void {
  if (!isGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // gone between the probe and the signal
  }
}

function clampTimer(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_TIMER_MS);
}

/** Resolves true if `p` settles (either way) within `ms`, false on timeout. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), clampTimer(ms));
  });
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function triggerIdFor(jobName: string, ctx: TriggerCtx): string | null {
  if (ctx.kind === "manual") return null;
  return `${jobName}:${ctx.trigger_id}`;
}

function triggerMetaFor(ctx: TriggerCtx): unknown {
  switch (ctx.kind) {
    case "cron": return { fire_at: ctx.fire_at, ...(isRecord(ctx.meta) ? ctx.meta : {}) };
    case "manual": return ctx.reason ? { reason: ctx.reason } : {};
    case "webhook": return ctx.meta ?? {};
    case "watch": return ctx.meta ?? {};
  }
}

function absoluteWorkerPath(workspaceRoot: string, worker: string): string {
  return resolvePath(workspaceRoot, worker);
}

/**
 * Environment handed to a worker: a small allowlist of the supervisor's own
 * variables (POSIX basics, plus the Windows start-up variables on win32; see
 * child-process.ts) and the RUN_ID, JOB_NAME, JOB_ID and TRIGGER_ variables
 * documented for workers. Nothing else, in particular none of the supervisor's secrets.
 */
function buildChildEnv(
  jobName: string,
  jobId: string,
  ctx: TriggerCtx,
  runId: string,
): Record<string, string> {
  const env = allowlistedEnv();
  env.RUN_ID = runId;
  env.JOB_NAME = jobName;
  env.JOB_ID = jobId;
  env.TRIGGER_KIND = ctx.kind;
  env.TRIGGER_ID = ctx.kind === "manual" ? "" : ctx.trigger_id;
  env.TRIGGER_META = JSON.stringify(triggerMetaFor(ctx));
  if (ctx.kind === "webhook" && ctx.payloadPath) {
    env.TRIGGER_PAYLOAD_PATH = ctx.payloadPath;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function definitionHash(job: Automation): string {
  const stable = stableStringify(job);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stable);
  return hasher.digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

function relativeLogPath(runId: string, startedAt: number): string {
  const d = new Date(startedAt);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}/${runId}.log`;
}

/**
 * Pump one pipe into the log. A failing log write must not stop the reading:
 * an unread pipe fills up (64 KiB) and blocks the worker on its next write, so
 * on error we keep reading and discard.
 */
function drainStream(stream: ReadableStream<Uint8Array>, capture: LogCapture, label: string): Drain {
  const reader = stream.getReader();
  const done = (async () => {
    try {
      while (true) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        if (value && value.byteLength > 0) {
          try {
            await capture.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength), label);
          } catch {
            // keep draining
          }
        }
      }
    } catch {
      // Stream errored / cancelled; the exit handler takes it from here.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  })();
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

type ExitClassification = {
  state: "succeeded" | "failed" | "timed_out" | "killed";
  exitCode: number | null;
  signalName: string | null;
};

function classifyExit(rawExit: number | null, child: Subprocess, handle: RunHandle): ExitClassification {
  // Bun: child.exitCode is set for normal exit; child.signalCode for signal.
  const signalCode = (child as { signalCode?: string | null }).signalCode ?? null;
  const exitCode = (child as { exitCode?: number | null }).exitCode ?? rawExit;
  const stopped = handle.cancelledByUser || handle.shutdownKilled;

  if (signalCode) {
    if (handle.cancelledByUser) {
      return { state: "killed", exitCode: null, signalName: signalCode };
    }
    if (handle.timedOut) {
      return { state: "timed_out", exitCode: null, signalName: signalCode };
    }
    if (stopped) {
      return { state: "killed", exitCode: null, signalName: signalCode };
    }
    // Unexpected signal.
    return { state: "failed", exitCode: null, signalName: signalCode };
  }
  // No signal — normal exit.
  if (handle.cancelledByUser) {
    // Process exited before our signal landed; treat as killed regardless.
    return { state: "killed", exitCode, signalName: null };
  }
  if (handle.timedOut) {
    return { state: "timed_out", exitCode, signalName: null };
  }
  if (stopped) {
    return { state: "killed", exitCode, signalName: null };
  }
  if (typeof exitCode === "number" && exitCode === 0) {
    return { state: "succeeded", exitCode: 0, signalName: null };
  }
  return { state: "failed", exitCode: typeof exitCode === "number" ? exitCode : null, signalName: null };
}
