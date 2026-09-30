// `auto create <name>` — scaffold a worker file and (with --add) register it.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCronExpression } from "../../supervisor/adapters/cron.ts";
import { JOB_NAME_MAX_LENGTH } from "../../supervisor/config.ts";
import { addEntryToConfigFile, existingJobNames, jobEntryText } from "../config-file.ts";
import {
  CONFIG_PATH,
  EX,
  WORKSPACE_ROOT,
  globals,
  printJson,
  println,
  shellWord,
  status,
} from "../runtime.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const DEFAULT_CRON = "0 9 * * *";

export type CreateOptions = {
  /** Five-field cron schedule (machine local time). Default `0 9 * * *`. */
  cron?: string;
  /** Append the job to the config file instead of just printing the entry. */
  add?: boolean;
};

export async function runCreate(name: string, opts: CreateOptions = {}): Promise<number> {
  if (!NAME_RE.test(name) || name.length > JOB_NAME_MAX_LENGTH) {
    status(
      `job name must be lowercase letters, numbers and hyphens, starting with a letter or number, at most ${JOB_NAME_MAX_LENGTH} characters`,
    );
    return EX.USAGE;
  }
  const cron = (opts.cron ?? DEFAULT_CRON).trim();
  try {
    validateCronExpression(cron);
  } catch (err) {
    status(`${err instanceof Error ? err.message : String(err)} (five fields, machine local time, e.g. "0 9 * * *")`);
    return EX.USAGE;
  }

  // Without a workspace there is no config to add the entry to and no jobs/
  // directory to keep the worker in: `auto init` makes both.
  if (!existsSync(CONFIG_PATH)) {
    status(`no config at ${CONFIG_PATH}; run \`auto init\` first`);
    return EX.ERR;
  }
  if ((await existingJobNames()).has(name)) {
    status(`a job named '${name}' is already in ${CONFIG_PATH}`);
    return EX.ERR;
  }

  const jobsDir = resolve(WORKSPACE_ROOT, "jobs");
  const target = resolve(jobsDir, `${name}.ts`);
  const workerExisted = existsSync(target);
  if (workerExisted && !opts.add) {
    status(`${target} already exists; pick another name, or pass --add to register that file`);
    return EX.ERR;
  }
  if (!workerExisted) {
    mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      target,
      `console.log(${JSON.stringify(`${name} completed`)}, new Date().toISOString());\n`,
      { flag: "wx" },
    );
    status(`created ${target}`);
  } else {
    status(`using existing ${target}`);
  }

  const entry = jobEntryText(name, cron);
  const report = (added: boolean, why: string | null): void => {
    if (globals().json) printJson({ name, worker: target, config: CONFIG_PATH, added, cron, reason: why, entry });
  };

  if (!opts.add) {
    status(`add this entry to the array in ${CONFIG_PATH} (or re-run with --add to have it done for you):`);
    if (globals().json) report(false, null);
    else println(entry);
    return EX.OK;
  }

  const result = await addEntryToConfigFile(entry);
  if (result.ok) {
    status(`added '${name}' to ${CONFIG_PATH} (runs on "${cron}")`);
    status(`the supervisor loads it automatically; \`auto run ${shellWord(name)}\` tries it now`);
    report(true, null);
    return EX.OK;
  }

  if (result.kind === "invalid") {
    // Nothing was changed in the config; do not leave a worker behind that we just made.
    if (!workerExisted) {
      try {
        unlinkSync(target);
      } catch {
        // best effort
      }
    }
    status(`not added: the config does not validate with this job, so ${CONFIG_PATH} was left unchanged (\`auto config check\` shows whether it was already invalid):`);
    status(result.reason);
    report(false, result.reason);
    return EX.ERR;
  }

  // --add was asked for and could not be done: that is a failure for a script
  // even though the entry is printed for pasting. The worker stays because the
  // entry points at it.
  status(`not added: ${result.reason}. Paste this entry into the array in ${CONFIG_PATH} (the worker ${target} was kept):`);
  if (globals().json) report(false, result.reason);
  else println(entry);
  return EX.ERR;
}
