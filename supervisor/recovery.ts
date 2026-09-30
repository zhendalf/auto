import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DATA_DIR, WORKSPACE_ROOT } from "../paths.ts";
import { commandLineOf, isGroupAlive, isPidAlive, processGroupOf, sleepSync } from "./process-identity.ts";

// A supervisor that died (crash, kill -9, power loss) leaves runs in
// 'queued'/'running' and possibly still-running workers. On the next start,
// before the runner exists, finalize those rows and stop matching orphans.
// The same sweep runs at the end of a graceful shutdown as a safety net for
// anything the runner did not finalize.

export const INTERRUPTED_REASON = "supervisor_interrupted";
export const SHUTDOWN_REASON = "supervisor_shutdown";

export type RecoveryOptions = {
  /** "startup" (default): rows left by a previous supervisor. "shutdown": rows this one failed to finalize. */
  phase?: "startup" | "shutdown";
  dataDir?: string;
  workspaceRoot?: string;
  now?: number;
  /** Time a SIGTERMed orphan gets before SIGKILL. */
  termGraceMs?: number;
  /** Test hooks. */
  isAlive?: (pid: number) => boolean;
  commandLine?: (pid: number) => string | null;
  log?: (line: string) => void;
};

export type RecoveryResult = {
  queued: number;
  running: number;
  /** Orphaned worker pids that matched the worker path and were terminated. */
  killed: number[];
  /** Live pids that did NOT look like the recorded worker and were left alone. */
  foreignPids: number[];
  conditionsCleared: number;
  conditionsCommitted: number;
  logsAppended: number;
};

type RunRow = {
  run_id: string;
  state: string;
  pid: number | null;
  log_path: string | null;
  worker_path: string | null;
  job_name: string | null;
};

/** Total rows touched, for the startup line. */
export function recoveredTotal(r: RecoveryResult): number {
  return r.queued + r.running + r.conditionsCleared + r.conditionsCommitted;
}

function terminate(pid: number, graceMs: number, isAlive: (pid: number) => boolean): void {
  // Signal the whole process group when the worker leads its own; otherwise
  // only the process (never a group we merely belong to).
  const group = processGroupOf(pid) === pid;
  const send = (sig: NodeJS.Signals): void => {
    try {
      process.kill(group ? -pid : pid, sig);
    } catch {
      // already gone
    }
  };
  // What must be gone: the whole group for a group leader (the leader can exit
  // on SIGTERM while a member ignores it), otherwise just the process.
  const stillThere = (): boolean => (group ? isGroupAlive(pid) : isAlive(pid));
  send("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (stillThere() && Date.now() < deadline) sleepSync(50);
  if (stillThere()) {
    send("SIGKILL");
    const killDeadline = Date.now() + 1_000;
    while (stillThere() && Date.now() < killDeadline) sleepSync(25);
  }
}

export function recoverInterruptedRuns(db: Database, opts: RecoveryOptions = {}): RecoveryResult {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const workspaceRoot = opts.workspaceRoot ?? WORKSPACE_ROOT;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? isPidAlive;
  const commandLine = opts.commandLine ?? commandLineOf;
  const termGraceMs = opts.termGraceMs ?? 3_000;
  const log = opts.log ?? (() => {});
  const shutdown = opts.phase === "shutdown";
  const reason = shutdown ? SHUTDOWN_REASON : INTERRUPTED_REASON;
  const owner = shutdown ? "this supervisor shut down" : "the previous supervisor stopped";
  const result: RecoveryResult = {
    queued: 0,
    running: 0,
    killed: [],
    foreignPids: [],
    conditionsCleared: 0,
    conditionsCommitted: 0,
    logsAppended: 0,
  };

  const rows = db
    .query<RunRow, []>(
      `SELECT r.run_id, r.state, r.pid, r.log_path, r.worker_path, j.name AS job_name
         FROM runs r LEFT JOIN jobs j ON j.job_id = r.job_id
        WHERE r.state IN ('queued', 'running')
        ORDER BY r.enqueued_at`,
    )
    .all();

  const finalize = db.prepare(
    `UPDATE runs
        SET state = 'failed', finished_at = ?, skip_reason = ?
      WHERE run_id = ? AND state IN ('queued', 'running')`,
  );

  for (const row of rows) {
    const notes: string[] = [];
    if (row.state === "running") {
      result.running++;
      notes.push(
        `[supervisor] this run was still 'running' when ${owner}; marked failed (${reason}).`,
      );
      const pid = row.pid;
      if (pid && pid !== process.pid && isAlive(pid)) {
        const workerAbs = row.worker_path ? resolve(workspaceRoot, row.worker_path) : null;
        const cmd = commandLine(pid);
        // Without ps (cmd === null) identity cannot be proven: only mark rows.
        if (workerAbs && cmd !== null && cmd.includes(workerAbs)) {
          terminate(pid, termGraceMs, isAlive);
          result.killed.push(pid);
          notes.push(`[supervisor] orphaned worker pid=${pid} was terminated.`);
          log(`terminated orphaned worker pid=${pid} run=${row.run_id}`);
        } else if (cmd !== null) {
          result.foreignPids.push(pid);
          notes.push(
            `[supervisor] recorded pid=${pid} is alive but is not this worker (pid reused); left alone.`,
          );
        }
      }
    } else {
      result.queued++;
      notes.push(
        `[supervisor] this run was still 'queued' when ${owner}; it never started and was marked failed (${reason}).`,
      );
    }

    finalize.run(now, reason, row.run_id);

    if (row.log_path) {
      const abs = resolve(dataDir, row.log_path);
      const rel = relative(resolve(dataDir), abs);
      // The stored path is relative to dataDir; never follow one that escapes it.
      if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(abs)) {
        try {
          appendFileSync(abs, `\n${notes.join("\n")}\n`);
          result.logsAppended++;
        } catch {
          // log is a courtesy; the DB row is the record
        }
      }
    }
  }

  // Nothing is in flight yet, so every pending condition marker is stale.
  // Mirror the evaluator: a succeeded run commits its pending state, anything
  // else discards it so the trigger is not suppressed forever.
  const pending = db
    .query<{ trigger_id: string; pending_run_id: string; run_state: string | null }, []>(
      `SELECT c.trigger_id, c.pending_run_id, r.state AS run_state
         FROM condition_states c LEFT JOIN runs r ON r.run_id = c.pending_run_id
        WHERE c.pending_run_id IS NOT NULL`,
    )
    .all();
  const commit = db.prepare(
    `UPDATE condition_states
        SET state_json = pending_state_json, pending_run_id = NULL,
            pending_state_json = NULL, updated_at = ?
      WHERE trigger_id = ? AND pending_run_id = ?`,
  );
  const discard = db.prepare(
    `UPDATE condition_states
        SET pending_run_id = NULL, pending_state_json = NULL, updated_at = ?
      WHERE trigger_id = ? AND pending_run_id = ?`,
  );
  for (const p of pending) {
    if (p.run_state === "succeeded") {
      commit.run(now, p.trigger_id, p.pending_run_id);
      result.conditionsCommitted++;
    } else {
      discard.run(now, p.trigger_id, p.pending_run_id);
      result.conditionsCleared++;
    }
  }

  return result;
}
