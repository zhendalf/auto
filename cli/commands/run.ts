// `auto run <name>` — start a job now and follow it to the end.
//
// Exit codes: 0 only when the run succeeded; 1 when it failed, timed out, was
// killed or cancelled, or the job could not be started; 3 when the supervisor
// is unreachable (including if it disappears while the run is followed); 4
// when another run of the job is already in progress (pass --force to start
// anyway); 130 when you press Ctrl-C (the run keeps going).

import { ApiError, type ApiClient } from "../client.ts";
import { createLogSink, followRun } from "../follow.ts";
import {
  EX,
  confirm,
  errColor,
  fmtDuration,
  getApiClient,
  globals,
  keepGoingWhenStdoutCloses,
  printJson,
  requireSupervisor,
  shellWord,
  shortRunId,
  status,
} from "../runtime.ts";

export type RunOptions = {
  /** `--force`: start now even if the job is disabled or paused, or another run of it is in progress. */
  force?: boolean;
};

type Started = { run_id: string; queued: boolean; position: number };

export async function runRun(jobName: string, opts: RunOptions): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  const started = await start(client, jobName, Boolean(opts.force));
  if (typeof started === "number") return started;

  const short = shortRunId(started.run_id);
  if (started.queued) {
    status(`queued at position ${started.position} (run ${short}); waiting for it to start`);
  } else {
    status(`started run ${short}`);
  }
  return await follow(client, started.run_id);
}

/** Ask the supervisor to start the job. Returns the run, or an exit code when it did not start. */
async function start(client: ApiClient, jobName: string, force: boolean): Promise<Started | number> {
  const attempt = async (forced: boolean, reason: string): Promise<Started> => {
    const r = await client.runJob(jobName, { force: forced, reason });
    return r.status === 202
      ? { run_id: r.run_id, queued: true, position: r.position }
      : { run_id: r.run_id, queued: false, position: 0 };
  };

  try {
    return await attempt(force, "auto run via cli");
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 404) {
      status(`unknown job: ${jobName} (see \`auto jobs\`)`);
      return EX.ERR;
    }
    if (err.status === 409) {
      const body = err.body as { running_run_id?: string } | null;
      const tag = body?.running_run_id ? ` (run ${shortRunId(body.running_run_id)})` : "";
      if (force) {
        status(`conflict: another run of ${jobName} is in progress${tag}`);
        return EX.CONFLICT;
      }
      // A yes (-y, or typed at the prompt) starts it anyway; with nobody to ask, stop.
      const proceed = await confirm(`another run of ${jobName} is in progress${tag}; start another anyway?`);
      if (!proceed) {
        status(`conflict: another run of ${jobName} is in progress${tag}; pass --force to start anyway`);
        return EX.CONFLICT;
      }
      try {
        return await attempt(true, "auto run via cli (confirmed)");
      } catch (retryErr) {
        if (retryErr instanceof ApiError && retryErr.status === 409) {
          status(`conflict: another run of ${jobName} is in progress; pass --force to start anyway`);
          return EX.CONFLICT;
        }
        throw retryErr;
      }
    }
    if (err.status === 422) {
      const body = err.body as { reason?: string } | null;
      status(skippedMessage(jobName, body?.reason, await disabledByConfig(client, jobName)));
      return EX.ERR;
    }
    if (err.status === 503) {
      status("the supervisor is not ready to run jobs (see `auto config status`)");
      return EX.ERR;
    }
    throw err;
  }
}

/** Is the job switched off by `enabled: false` in auto.config.ts (which `auto enable` cannot undo)? */
async function disabledByConfig(client: ApiClient, jobName: string): Promise<boolean> {
  try {
    return (await client.job(jobName)).config_enabled === false;
  } catch {
    return false;
  }
}

export function skippedMessage(jobName: string, reason: string | undefined, configDisabled = false): string {
  switch (reason) {
    case "disabled":
      return configDisabled
        ? `${jobName} is disabled in auto.config.ts (\`enabled: false\`); edit that file to enable it, or use --force to run it once`
        : `${jobName} is disabled; enable it with \`auto enable ${shellWord(jobName)}\` (or use --force to run it once)`;
    case "paused":
      return `${jobName} is paused; resume it with \`auto pause ${shellWord(jobName)} off\` (or use --force to run it once)`;
    case "queue_full":
      return `${jobName} is busy and its queue is full; try again later or use --force`;
    case "shutdown":
      return "the supervisor is shutting down";
    default:
      return `run skipped: ${reason ?? "unknown reason"}`;
  }
}

async function follow(client: ApiClient, runId: string): Promise<number> {
  const short = shortRunId(runId);
  // The exit code is the run's result: a reader that goes away (`| head`) must not hide a failure.
  keepGoingWhenStdoutCloses();
  const sink = createLogSink(runId);
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.on("SIGINT", onSigint);
  let result;
  try {
    result = await followRun(client, { runId, out: sink.write, signal: abort.signal });
  } finally {
    process.off("SIGINT", onSigint);
    sink.end();
  }

  if (result.kind === "unreachable") {
    status(`lost contact with the supervisor at ${client.baseUrl}; run ${short} may still be running (check \`auto runs\`)`);
    return EX.UNREACHABLE;
  }
  if (result.kind === "detached") {
    status(`-- detached; run ${short} keeps running (\`auto log ${short} --follow\` to reattach, \`auto cancel ${short}\` to stop it) --`);
    return EX.INTERRUPTED;
  }

  if (globals().json) {
    printJson({
      run_id: runId,
      state: result.state,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });
  }
  const dur = fmtDuration(result.durationMs);
  const exit = result.exitCode !== null ? ` (exit ${result.exitCode})` : "";
  switch (result.state) {
    case "succeeded":
      status(errColor.green(`succeeded in ${dur}`));
      return EX.OK;
    case "failed":
      status(errColor.red(`failed in ${dur}${exit}`));
      return EX.ERR;
    case "timed_out":
      status(errColor.red(`timed out after ${dur}`));
      return EX.ERR;
    case "killed":
      status(errColor.red(`killed after ${dur}${exit}`));
      return EX.ERR;
    case "cancelled":
      status(errColor.yellow(`cancelled after ${dur}`));
      return EX.ERR;
    case "skipped":
      status(errColor.yellow("skipped"));
      return EX.ERR;
    default:
      status(errColor.red(`finished: ${result.state}`));
      return EX.ERR;
  }
}
