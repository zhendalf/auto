// `auto enable <name>` — enable a job.

import { ApiError } from "../client.ts";
import { EX, getApiClient, globals, printJson, requireSupervisor, status } from "../runtime.ts";

export async function runEnable(name: string): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);
  try {
    await client.enableJob(name);
    // `enabled: false` in auto.config.ts wins over anything the CLI can set:
    // clearing the runtime flag does not make the job runnable.
    const job = await client.job(name);
    if (job.config_enabled === false) {
      if (globals().json) printJson({ ok: false, job: name, enabled: false, config_enabled: false });
      else {
        status(`${name} is still disabled: auto.config.ts sets \`enabled: false\` for it`);
        status("edit that file (auto config edit) and remove or change the line; the supervisor reloads it by itself");
      }
      return EX.ERR;
    }
    if (globals().json) printJson({ ok: true, job: name, enabled: true });
    else status(`enabled ${name}`);
    return EX.OK;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      status(`unknown job: ${name} (see \`auto jobs\`)`);
      return EX.ERR;
    }
    throw err;
  }
}
