// `auto trigger enable|disable <trigger_id>` — trigger-level enable/disable.
//
// A trigger id is the job name and the trigger's own id joined by a colon,
// for example `hello-world:morning`; `auto job <name>` lists them.

import { ApiError } from "../client.ts";
import { EX, getApiClient, globals, printJson, requireSupervisor, status } from "../runtime.ts";

async function setTrigger(triggerId: string, enabled: boolean): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);
  try {
    if (enabled) await client.enableTrigger(triggerId);
    else await client.disableTrigger(triggerId);
    if (globals().json) printJson({ ok: true, trigger_id: triggerId, enabled });
    else status(`${enabled ? "enabled" : "disabled"} trigger ${triggerId}`);
    return EX.OK;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      const hint = triggerId.includes(":")
        ? "run `auto job <name>` to list its triggers"
        : "trigger ids look like job-name:trigger-id; run `auto job <name>` to list them";
      status(`unknown trigger: ${triggerId} (${hint})`);
      return EX.ERR;
    }
    throw err;
  }
}

export function runTriggerEnable(triggerId: string): Promise<number> {
  return setTrigger(triggerId, true);
}

export function runTriggerDisable(triggerId: string): Promise<number> {
  return setTrigger(triggerId, false);
}
