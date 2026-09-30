import { ApiError, describeError, reasonLabel } from "./errors.ts";
import { shortId } from "./format.ts";

/** What the API said to a "Run now" request that did not start a run. */
export type RunRefusal =
  /** 409: the job already has a run in flight. */
  | { kind: "conflict"; runningRunId: string | null }
  /** 422: the runner recorded a skipped run (`runId`) and says why. */
  | { kind: "skipped"; reason: string; runId: string | null; label: string }
  | { kind: "error"; message: string };

export function classifyRunFailure(err: unknown): RunRefusal {
  if (err instanceof ApiError) {
    const body = (err.body && typeof err.body === "object" ? err.body : {}) as {
      running_run_id?: unknown;
      run_id?: unknown;
      reason?: unknown;
    };
    if (err.status === 409 && err.code === "conflict") {
      return {
        kind: "conflict",
        runningRunId: typeof body.running_run_id === "string" ? body.running_run_id : null,
      };
    }
    if (err.status === 422 && err.code === "skipped") {
      const reason = typeof body.reason === "string" ? body.reason : "skipped";
      return {
        kind: "skipped",
        reason,
        runId: typeof body.run_id === "string" ? body.run_id : null,
        label: reasonLabel(reason) || reason,
      };
    }
  }
  const d = describeError(err);
  return { kind: "error", message: [d.title, d.message].filter(Boolean).join(". ") };
}

/** The toast for a run that was accepted: started (200) or queued (202). */
export function runAcceptedMessage(res: { run_id: string; status: 200 | 202; position?: number }): string {
  if (res.status === 202) {
    const pos = res.position;
    return pos != null
      ? `Queued at position ${pos}. It starts when the running run finishes.`
      : "Queued. It starts when the running run finishes.";
  }
  return `Started run ${shortId(res.run_id)}.`;
}

/** Whether "Run anyway" makes sense for a refusal (it cannot override a shutdown). */
export function canForce(refusal: RunRefusal): boolean {
  if (refusal.kind === "conflict") return true;
  if (refusal.kind === "skipped") return refusal.reason !== "shutdown" && refusal.reason !== "supervisor_shutdown";
  return false;
}

/**
 * A refusal describes the moment it was made. What to keep of it after
 * `change`: a "not started: disabled/paused" note goes when the job's enabled
 * or paused state changed, and an error note (supervisor down) goes when the
 * event stream is back. A conflict is cleared separately, by its run finishing.
 */
export function refusalAfter(
  refusal: RunRefusal | null,
  change: "job-state-changed" | "connection-restored",
): RunRefusal | null {
  if (!refusal) return null;
  if (change === "job-state-changed" && refusal.kind === "skipped") return null;
  if (change === "connection-restored" && refusal.kind === "error") return null;
  return refusal;
}
