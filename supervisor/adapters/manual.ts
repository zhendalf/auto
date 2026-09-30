import type { Runner, EnqueueResult } from "../runner.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ManualTriggerOptions = {
  /** If true, bypass conflict-on-overlap and start a parallel run anyway (per Q-04 "run anyway"). */
  force?: boolean;
  /** Free-form note recorded in trigger_meta. CLI sets this from --reason or omits. */
  reason?: string;
};

export type ManualTriggerResult =
  | { ok: true;  outcome: "started";     run_id: string }
  | { ok: true;  outcome: "queued";      run_id: string; position: number }
  | { ok: false; outcome: "conflict";    running_run_id: string; suggested_action: "force_or_cancel" }
  | { ok: false; outcome: "skipped";     run_id: string; reason: string }
  | { ok: false; outcome: "unknown_job"; jobName: string };

// ---------------------------------------------------------------------------
// Internal mapping
// ---------------------------------------------------------------------------

function mapResult(result: EnqueueResult): ManualTriggerResult {
  switch (result.kind) {
    case "started":
      return { ok: true, outcome: "started", run_id: result.run_id };
    case "queued":
      return {
        ok: true,
        outcome: "queued",
        run_id: result.run_id,
        position: result.position,
      };
    case "conflict":
      return {
        ok: false,
        outcome: "conflict",
        running_run_id: result.running_run_id,
        suggested_action: "force_or_cancel",
      };
    case "skipped":
      return {
        ok: false,
        outcome: "skipped",
        run_id: result.run_id,
        reason: result.reason,
      };
  }
}

// Runner.enqueue throws `new Error(`unknown job: ${jobName}`)` when the
// registry returns null. Match by message prefix so a future re-word that
// preserves the prefix still works, but anything else re-throws.
function isUnknownJobError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.startsWith("unknown job:");
}

// ---------------------------------------------------------------------------
// Standalone function
// ---------------------------------------------------------------------------

/**
 * Trigger a manual run. Returns a structured result the CLI/HTTP API can map
 * to exit codes / HTTP status:
 *  - "started"     -> 0 / 200
 *  - "queued"      -> 0 / 202
 *  - "conflict"    -> 4 / 409
 *  - "skipped"     -> 1 / 422
 *  - "unknown_job" -> 2 / 404
 *
 * "skipped" carries the runner's reason: "disabled" (config or `auto disable`),
 * "paused" (`auto pause`), "shutdown" (supervisor stopping). `force` bypasses
 * disabled/paused as well as the overlap conflict; the only thing it cannot
 * bypass is a supervisor that is shutting down.
 */
export async function triggerManual(
  runner: Runner,
  jobName: string,
  opts?: ManualTriggerOptions,
): Promise<ManualTriggerResult> {
  try {
    const result = await runner.enqueue(
      jobName,
      { kind: "manual", reason: opts?.reason },
      { force: opts?.force ?? false },
    );
    return mapResult(result);
  } catch (err) {
    if (isUnknownJobError(err)) {
      return { ok: false, outcome: "unknown_job", jobName };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Class wrapper
// ---------------------------------------------------------------------------

export class ManualAdapter {
  private readonly runner: Runner;

  constructor(opts: { runner: Runner }) {
    this.runner = opts.runner;
  }

  trigger(jobName: string, opts?: ManualTriggerOptions): Promise<ManualTriggerResult> {
    return triggerManual(this.runner, jobName, opts);
  }
}
