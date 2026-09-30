import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { allowlistedEnv, processGroupSpawnOption, signalProcessGroup } from "./child-process.ts";
import type { Automation, CronTrigger } from "./config.ts";
import type { EnqueueResult, RunFinishedEvent, Runner } from "./runner.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 4096;

/** Time a checker gets between SIGTERM and SIGKILL when it has to be stopped. */
const CHECKER_KILL_GRACE_MS = 1_000;

/** Run states in which a run is still going to produce a result. */
const LIVE_RUN_STATES = new Set(["queued", "running"]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ConditionResult = {
  fire: boolean;
  state?: JsonValue;
  meta?: JsonValue;
};

export type EvaluationResult =
  | { kind: "quiet" }
  | { kind: "fired"; enqueue: EnqueueResult }
  // pending_run_id is null when suppressed because an earlier evaluation of the
  // same trigger is still in flight.
  | { kind: "suppressed"; pending_run_id: string | null }
  | { kind: "error"; error: string };

type ConditionRow = {
  state_json: string | null;
  pending_run_id: string | null;
};

/**
 * Runs condition checkers and turns their verdicts into runs, with an
 * at-least-once contract: the checker's new state is only committed once the
 * run it triggered succeeded. `pending_run_id` marks "fired, outcome not known
 * yet" and suppresses further firing, but it is only trusted while the run is
 * actually live: at evaluation time it is validated against runs.state, and
 * run.finished / run.skipped events clear it eagerly. A run that ended any
 * other way than success (failed, killed, timed out, cancelled while queued,
 * lost in a crash, missing) drops the pending marker WITHOUT advancing the
 * state, so the next evaluation sees the same input again and can re-fire.
 */
export class ConditionEvaluator {
  // Triggers with a checker currently running, so a slow checker cannot be
  // overlapped by the next scheduled evaluation (which would double-fire).
  private readonly inFlight = new Set<string>();
  // Checker processes that are running right now, so shutdown can stop them.
  private readonly liveCheckers = new Set<{ pid?: number; kill(signal?: NodeJS.Signals | number): void; exited: Promise<number> }>();
  private stopped = false;

  constructor(
    private readonly opts: {
      db: Database;
      runner: Runner;
      workspaceRoot: string;
      bunPath?: string;
      spawn?: typeof Bun.spawn;
      /** SIGTERM to SIGKILL grace for a checker that has to be stopped. Defaults to 1 s. */
      killGraceMs?: number;
    },
  ) {
    opts.runner.on("run.finished", (event: RunFinishedEvent) => this.onRunFinished(event));
    // Cancelled while queued, skipped, or dropped at shutdown: the run will
    // never finish, so it must not keep the trigger suppressed.
    opts.runner.on("run.skipped", (event: { run_id: string }) => this.finalizePending(event.run_id, false));
  }

  /**
   * Stop every checker that is running and refuse to start new ones. SIGTERM
   * goes to each checker's process group; whatever is still alive after
   * `graceMs` gets SIGKILL. Resolves once they are gone (or after the kill).
   * An interrupted evaluation records nothing, so the next start evaluates the
   * same input again.
   */
  async stop(graceMs = CHECKER_KILL_GRACE_MS): Promise<void> {
    this.stopped = true;
    const live = [...this.liveCheckers];
    if (live.length === 0) return;
    for (const child of live) signalProcessGroup(child, "SIGTERM");
    const allExited = Promise.all(live.map((c) => c.exited.then(() => {}, () => {})));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      allExited.then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), Math.max(0, graceMs)); }),
    ]);
    if (timer) clearTimeout(timer);
    // The leader may be gone while a member of its group ignored SIGTERM, so
    // the group gets its SIGKILL either way.
    for (const child of live) signalProcessGroup(child, "SIGKILL");
    if (timedOut) await Promise.race([allExited, new Promise((r) => setTimeout(r, 500))]);
  }

  async evaluate(job: Automation, trigger: CronTrigger, fireAt = Date.now()): Promise<EvaluationResult> {
    if (this.stopped) return { kind: "error", error: "supervisor is shutting down" };
    if (!trigger.condition) {
      const enqueue = await this.opts.runner.enqueue(job.name, {
        kind: "cron",
        trigger_id: trigger.id,
        fire_at: fireAt,
      });
      return { kind: "fired", enqueue };
    }

    const triggerId = `${job.name}:${trigger.id}`;
    if (this.inFlight.has(triggerId)) return { kind: "suppressed", pending_run_id: null };
    this.inFlight.add(triggerId);
    try {
      return await this.evaluateConditional(job, trigger, triggerId, fireAt);
    } finally {
      this.inFlight.delete(triggerId);
    }
  }

  private async evaluateConditional(
    job: Automation,
    trigger: CronTrigger,
    triggerId: string,
    fireAt: number,
  ): Promise<EvaluationResult> {
    let row = this.readRow(triggerId);
    if (row?.pending_run_id) {
      if (this.isRunLive(row.pending_run_id)) {
        return { kind: "suppressed", pending_run_id: row.pending_run_id };
      }
      // The run this trigger is waiting on is over (or never existed) but its
      // event was missed: cancelled while queued, crash, restart. Settle the
      // marker from what the database says, then evaluate as usual.
      const outcome = this.opts.db.query<{ state: string }, [string]>(
        `SELECT state FROM runs WHERE run_id = ?`,
      ).get(row.pending_run_id);
      this.finalizePending(row.pending_run_id, outcome?.state === "succeeded");
      row = this.readRow(triggerId);
    }

    try {
      const previousState = row?.state_json ? JSON.parse(row.state_json) : null;
      const result = await this.runChecker(job, trigger, fireAt, previousState);
      const stateJson = serializeBounded(result.state ?? previousState, "condition state");
      const metaJson = serializeBounded(result.meta ?? null, "condition meta");
      const now = Date.now();

      if (!result.fire) {
        this.opts.db.prepare(
          `INSERT INTO condition_states (
             trigger_id, state_json, evaluation_count, last_evaluated_at,
             consecutive_failures, last_error, updated_at
           ) VALUES (?, ?, 1, ?, 0, NULL, ?)
           ON CONFLICT(trigger_id) DO UPDATE SET
             state_json = excluded.state_json,
             evaluation_count = condition_states.evaluation_count + 1,
             last_evaluated_at = excluded.last_evaluated_at,
             consecutive_failures = 0,
             last_error = NULL,
             updated_at = excluded.updated_at`,
        ).run(triggerId, stateJson, now, now);
        return { kind: "quiet" };
      }

      const enqueue = await this.opts.runner.enqueue(job.name, {
        kind: "cron",
        trigger_id: trigger.id,
        fire_at: fireAt,
        meta: { condition: JSON.parse(metaJson) },
      });
      if (enqueue.kind === "started" || enqueue.kind === "queued") {
        this.opts.db.prepare(
          `INSERT INTO condition_states (
             trigger_id, state_json, pending_run_id, pending_state_json,
             evaluation_count, last_evaluated_at, last_fired_at,
             consecutive_failures, last_error, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, 0, NULL, ?)
           ON CONFLICT(trigger_id) DO UPDATE SET
             pending_run_id = excluded.pending_run_id,
             pending_state_json = excluded.pending_state_json,
             evaluation_count = condition_states.evaluation_count + 1,
             last_evaluated_at = excluded.last_evaluated_at,
             last_fired_at = excluded.last_fired_at,
             consecutive_failures = 0,
             last_error = NULL,
             updated_at = excluded.updated_at`,
        ).run(triggerId, row?.state_json ?? null, enqueue.run_id, stateJson, now, now, now);
        // The run may already be over (fast worker, or skipped/cancelled before
        // we recorded the marker); settle it now rather than waiting for an
        // event that already went by.
        const terminal = this.opts.db.query<{ state: string }, [string]>(
          `SELECT state FROM runs WHERE run_id = ? AND state NOT IN ('queued', 'running')`,
        ).get(enqueue.run_id);
        if (terminal) {
          this.finalizePending(enqueue.run_id, terminal.state === "succeeded");
        }
      } else {
        // skipped (overlap, disabled, paused, ...) or conflict: the action did
        // not happen, so the state is NOT advanced and the next evaluation
        // presents the same input again. Only the bookkeeping moves.
        this.opts.db.prepare(
          `INSERT INTO condition_states (
             trigger_id, state_json, evaluation_count, last_evaluated_at,
             consecutive_failures, last_error, updated_at
           ) VALUES (?, ?, 1, ?, 0, NULL, ?)
           ON CONFLICT(trigger_id) DO UPDATE SET
             evaluation_count = condition_states.evaluation_count + 1,
             last_evaluated_at = excluded.last_evaluated_at,
             consecutive_failures = 0,
             last_error = NULL,
             updated_at = excluded.updated_at`,
        ).run(triggerId, row?.state_json ?? null, now, now);
      }
      return { kind: "fired", enqueue };
    } catch (err) {
      const message = boundedError(err);
      // A checker cut short by shutdown is not a failure of the checker.
      if (this.stopped) return { kind: "error", error: message };
      const now = Date.now();
      this.opts.db.prepare(
        `INSERT INTO condition_states (
           trigger_id, evaluation_count, last_evaluated_at,
           consecutive_failures, last_error, updated_at
         ) VALUES (?, 1, ?, 1, ?, ?)
         ON CONFLICT(trigger_id) DO UPDATE SET
           evaluation_count = condition_states.evaluation_count + 1,
           last_evaluated_at = excluded.last_evaluated_at,
           consecutive_failures = condition_states.consecutive_failures + 1,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      ).run(triggerId, now, message, now);
      return { kind: "error", error: message };
    }
  }

  private readRow(triggerId: string): ConditionRow | null {
    return this.opts.db
      .query<ConditionRow, [string]>(
        `SELECT state_json, pending_run_id FROM condition_states WHERE trigger_id = ?`,
      )
      .get(triggerId);
  }

  /**
   * A run counts as live only if the database says queued/running AND this
   * runner actually holds it. A row stuck in "running" that the runner does
   * not know (left behind by a crashed supervisor) is not going to finish.
   */
  private isRunLive(runId: string): boolean {
    const row = this.opts.db.query<{ state: string }, [string]>(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).get(runId);
    if (!row || !LIVE_RUN_STATES.has(row.state)) return false;
    const active = this.opts.runner.active;
    if (typeof active !== "function") return true;
    return active.call(this.opts.runner).some((a) => a.runId === runId);
  }

  private async runChecker(
    job: Automation,
    trigger: CronTrigger,
    fireAt: number,
    previousState: unknown,
  ): Promise<ConditionResult> {
    const checker = resolve(this.opts.workspaceRoot, trigger.condition!.checker);
    const spawn = this.opts.spawn ?? Bun.spawn;
    const child = spawn([this.opts.bunPath ?? process.execPath, checker], {
      cwd: this.opts.workspaceRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: allowlistedEnv(),
      // Own process group so a stuck checker and anything it forked can be
      // stopped together.
      ...processGroupSpawnOption(),
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let clean = false;
    this.liveCheckers.add(child);
    try {
      // Not awaited: a checker that never reads its input must not be able to
      // stall us past the timeout below.
      try {
        const input = JSON.stringify({
          version: 1,
          job: { id: job.id, name: job.name },
          trigger: { id: trigger.id },
          scheduledTime: fireAt,
          previousState,
        });
        void Promise.resolve(child.stdin.write(input)).catch(() => {});
        void Promise.resolve(child.stdin.end()).catch(() => {});
      } catch {
        // The checker may have exited without reading its input; its exit
        // status and output below say what happened.
      }

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`condition checker timed out after ${trigger.condition!.timeoutMs}ms`));
        }, trigger.condition!.timeoutMs);
      });
      const [exitCode, stdout, stderr] = await Promise.race([
        Promise.all([
          child.exited,
          readBounded(child.stdout, MAX_OUTPUT_BYTES),
          readBounded(child.stderr, MAX_OUTPUT_BYTES),
        ]),
        timeout,
      ]);
      clean = true;
      if (this.stopped) throw new Error("condition checker stopped: supervisor is shutting down");
      if (exitCode !== 0) {
        throw new Error(`condition checker exited ${exitCode}: ${stderr.trim().slice(0, MAX_ERROR_BYTES)}`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { throw new Error("condition checker stdout is not valid JSON"); }
      if (!isConditionResult(parsed)) throw new Error("condition checker result must contain boolean fire");
      serializeBounded(parsed.state ?? null, "condition state");
      serializeBounded(parsed.meta ?? null, "condition meta");
      return parsed;
    } finally {
      if (timer) clearTimeout(timer);
      // Timeout, oversized output or any other early exit from the try block:
      // the checker (and whatever it spawned) may still be running. Stop the
      // whole process group, escalating to SIGKILL, and never wait on it here.
      if (!clean) this.stopChecker(child);
      this.liveCheckers.delete(child);
    }
  }

  private stopChecker(child: { pid?: number; kill(signal?: NodeJS.Signals | number): void; exitCode?: number | null }): void {
    signalProcessGroup(child, "SIGTERM");
    const escalate = setTimeout(() => signalProcessGroup(child, "SIGKILL"), this.opts.killGraceMs ?? CHECKER_KILL_GRACE_MS);
    // A pending escalation must not keep the supervisor (or a test run) alive.
    (escalate as unknown as { unref?: () => void }).unref?.();
  }

  private onRunFinished(event: RunFinishedEvent): void {
    this.finalizePending(event.run_id, event.state === "succeeded");
  }

  private finalizePending(runId: string, succeeded: boolean): void {
    const row = this.opts.db.query<
      { trigger_id: string; pending_state_json: string | null },
      [string]
    >(`SELECT trigger_id, pending_state_json FROM condition_states WHERE pending_run_id = ?`).get(runId);
    if (!row) return;
    const now = Date.now();
    const commit = this.opts.db.transaction(() => {
      if (succeeded) {
        this.opts.db.prepare(
          `UPDATE condition_states
              SET state_json = pending_state_json,
                  pending_run_id = NULL,
                  pending_state_json = NULL,
                  updated_at = ?
            WHERE trigger_id = ? AND pending_run_id = ?`,
        ).run(now, row.trigger_id, runId);
      } else {
        this.opts.db.prepare(
          `UPDATE condition_states
              SET pending_run_id = NULL,
                  pending_state_json = NULL,
                  updated_at = ?
            WHERE trigger_id = ? AND pending_run_id = ?`,
        ).run(now, row.trigger_id, runId);
      }
    });
    commit();
  }
}

function serializeBounded(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label} is not JSON-serializable`);
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw new Error(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
  return json;
}

function isConditionResult(value: unknown): value is ConditionResult {
  return value !== null && typeof value === "object" && typeof (value as { fire?: unknown }).fire === "boolean";
}

function boundedError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_BYTES);
}

async function readBounded(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch {}
      throw new Error(`condition checker output exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}
