// `auto cancel <run_id|job_name>` — cancel a queued or running run.
//
// A run id (or the short id from `auto runs`) cancels that run. A job name
// cancels the job's active run: the running one, else the oldest queued one.
// Cancelling a run that is already executing asks first, because it stops the
// worker mid-flight; pass -y to skip the question.

import { ApiError, type ApiClient } from "../client.ts";
import { looksLikeRunRef, resolveRun } from "../run-ref.ts";
import {
  EX,
  confirm,
  getApiClient,
  globals,
  printJson,
  requireSupervisor,
  shortRunId,
  status,
} from "../runtime.ts";

export async function runCancel(target: string): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  // Something that looks like a run id is tried as one first; if no run has
  // that id it may still be a job name (job names can be hex-looking too).
  if (looksLikeRunRef(target)) {
    const resolved = await resolveRun(client, target);
    if (resolved.ok) return await cancelRun(client, resolved.run.run_id, resolved.run.state, resolved.run.job_name);
    const asJob = await activeRunOfJob(client, target);
    if (asJob === "unknown") {
      status(resolved.message);
      return resolved.code;
    }
    return await cancelJobsRun(client, target, asJob);
  }
  return await cancelJobsRun(client, target, await activeRunOfJob(client, target));
}

type Active = { run_id: string; state: string } | null | "unknown";

async function activeRunOfJob(client: ApiClient, name: string): Promise<Active> {
  try {
    const job = await client.job(name);
    if (job.active_run) return { run_id: job.active_run.run_id, state: job.active_run.state };
    const running = job.recent_runs.find((r) => r.state === "running");
    const queued = job.recent_runs.find((r) => r.state === "queued");
    const candidate = running ?? queued;
    return candidate ? { run_id: candidate.run_id, state: candidate.state } : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return "unknown";
    throw err;
  }
}

async function cancelJobsRun(client: ApiClient, target: string, active: Active): Promise<number> {
  if (active === "unknown") {
    status(`no run or job matching '${target}' (see \`auto runs\` and \`auto jobs\`)`);
    return EX.ERR;
  }
  if (active === null) {
    status(`${target} has no queued or running run to cancel`);
    return EX.ERR;
  }
  return await cancelRun(client, active.run_id, active.state, target);
}

async function cancelRun(
  client: ApiClient,
  runId: string,
  state: string,
  jobName: string,
): Promise<number> {
  const short = shortRunId(runId);
  if (state === "running") {
    const ok = await confirm(`run ${short} of ${jobName} is running; cancelling stops the worker now. Cancel it?`);
    if (ok === null) {
      status(`run ${short} is running; pass -y to cancel it without a prompt`);
      return EX.ERR;
    }
    if (!ok) {
      status("not cancelled");
      return EX.ERR;
    }
  }
  try {
    const r = await client.cancelRun(runId);
    if (globals().json) printJson({ ...r, run_id: runId });
    else status(`cancelled run ${short} (was ${r.previous_state})`);
    return EX.OK;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) {
        status(`no such run: ${short}`);
        return EX.ERR;
      }
      if (err.status === 409) {
        const body = err.body as { error?: string; previous_state?: string } | null;
        if (body?.error === "ambiguous_prefix") {
          status(`'${short}' matches more than one run; use more characters`);
          return EX.ERR;
        }
        if (globals().json) {
          printJson({ ok: true, already_finished: true, previous_state: body?.previous_state ?? null, run_id: runId });
        } else {
          status(`run ${short} already finished (${body?.previous_state ?? "unknown"})`);
        }
        // Idempotent: cancelling something that is done is not an error.
        return EX.OK;
      }
    }
    throw err;
  }
}
