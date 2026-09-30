// `auto last <name>` — show the last run of a job + its log via the API.

import {
  color,
  getApiClient,
  globals,
  printJson,
  println,
  requireSupervisor,
  shellWord,
  status,
  writeOut,
} from "../runtime.ts";
import { ApiError, type Run } from "../client.ts";
import { formatRunsTable } from "./runs.ts";

export async function runLast(jobName: string): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  // Newest first. Skipped and cancelled-while-queued runs are history, not
  // results: prefer the latest run that actually ran, and only fall back to a
  // skipped one when nothing else exists.
  const recent = await client.runs({ job: jobName, limit: 25 });
  const rows = [recent.find((r) => r.state !== "skipped" && r.state !== "cancelled") ?? recent[0]].filter(
    (r): r is Run => r !== undefined,
  );
  if (rows.length === 0) {
    // An unknown job and a job that never ran are different problems.
    try {
      await client.job(jobName);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        status(`unknown job: ${jobName} (see \`auto jobs\`)`);
        return 1;
      }
      throw err;
    }
    if (globals().json) printJson({ run: null, log: null });
    else status(`${jobName} has not run yet; start it with \`auto run ${shellWord(jobName)}\``);
    return 1;
  }
  const row = rows[0]!;

  let logText = "";
  let logGone = false;
  try {
    logText = await client.runLog(row.run_id);
  } catch (err) {
    // 404: the run has no log (never started, or the file was pruned).
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    logGone = true;
  }

  if (globals().json) {
    printJson({ run: row, log: logText });
    return 0;
  }

  println(color.bold("RUN"));
  println(formatRunsTable([row]));
  println("");
  println(color.bold("LOG"));
  if (logGone) {
    // The same wording as `auto log`, so an absent log never reads as an empty one.
    println(color.dim(`(run has no log: state=${row.state}${row.skip_reason ? `: ${row.skip_reason}` : ""})`));
  } else if (logText.length === 0) {
    println(color.dim("(the log is empty)"));
  } else {
    writeOut(logText.endsWith("\n") ? logText : logText + "\n");
  }
  return 0;
}
