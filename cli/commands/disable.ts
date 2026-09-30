// `auto disable <name>` — disable a job.

import { ApiError } from "../client.ts";
import { EX, getApiClient, globals, printJson, requireSupervisor, status } from "../runtime.ts";

export async function runDisable(name: string): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);
  try {
    await client.disableJob(name);
    if (globals().json) printJson({ ok: true, job: name, enabled: false });
    else status(`disabled ${name}`);
    return EX.OK;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      status(`unknown job: ${name} (see \`auto jobs\`)`);
      return EX.ERR;
    }
    throw err;
  }
}
