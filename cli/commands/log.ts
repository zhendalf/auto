// `auto log <run_id> [--follow]` — print a run's log.
//
// `--follow` prints what exists, then keeps printing as the worker writes and
// exits when the run reaches a final state (see ../follow.ts for how a missed
// finish is handled). Exit codes with --follow: 0 when the run succeeded, 1
// when it ended any other way, 3 if the supervisor disappears, 130 on Ctrl-C.

import { ApiError } from "../client.ts";
import { createLogSink, followRun } from "../follow.ts";
import { resolveRun } from "../run-ref.ts";
import {
  EX,
  errColor,
  fmtDuration,
  getApiClient,
  globals,
  printJson,
  requireSupervisor,
  shortRunId,
  status,
  writeOut,
} from "../runtime.ts";

export type LogOptions = {
  follow?: boolean;
};

export async function runLog(ref: string, opts: LogOptions): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  const resolved = await resolveRun(client, ref);
  if (!resolved.ok) {
    status(resolved.message);
    return resolved.code;
  }
  const run = resolved.run;

  // A skipped run never had a worker: there is nothing to wait for or follow.
  if (opts.follow && run.state !== "skipped") return await followLog(client, run.run_id);

  let text: string;
  try {
    text = await client.runLog(run.run_id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // A machine reader still gets JSON: no lines, and why there are none.
      if (globals().json) {
        printJson({ run_id: run.run_id, state: run.state, lines: [], skip_reason: run.skip_reason ?? null });
      }
      status(
        run.state === "queued"
          ? `run ${shortRunId(run.run_id)} is queued and has no log yet; use --follow to wait for it`
          : `run ${shortRunId(run.run_id)} has no log (state=${run.state}${run.skip_reason ? `: ${run.skip_reason}` : ""})`,
      );
      return EX.ERR;
    }
    throw err;
  }
  if (globals().json) {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    printJson({ run_id: run.run_id, state: run.state, lines });
    return EX.OK;
  }
  writeOut(text.length > 0 && !text.endsWith("\n") ? text + "\n" : text);
  return EX.OK;
}

async function followLog(client: ReturnType<typeof getApiClient>, runId: string): Promise<number> {
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
  const short = shortRunId(runId);

  if (result.kind === "unreachable") {
    status(`lost contact with the supervisor at ${client.baseUrl}; run ${short} may still be running`);
    return EX.UNREACHABLE;
  }
  if (result.kind === "detached") {
    status(`-- stopped following run ${short}; it keeps running (\`auto log ${short} --follow\` to resume) --`);
    return EX.INTERRUPTED;
  }
  if (globals().json) {
    printJson({
      run_id: runId,
      state: result.state,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });
  } else {
    const line = `-- run ${short} ${result.state} in ${fmtDuration(result.durationMs)} --`;
    status(result.state === "succeeded" ? errColor.green(line) : errColor.red(line));
  }
  return result.state === "succeeded" ? EX.OK : EX.ERR;
}
