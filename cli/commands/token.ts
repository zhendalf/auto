// `auto token rotate` — replace the API token.

import { EX, getApiClient, globals, printJson, requireSupervisor, status } from "../runtime.ts";

export async function runTokenRotate(): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);
  const result = await client.rotateToken();
  if (globals().json) {
    printJson(result);
    return EX.OK;
  }
  status("token rotated");
  status("Open dashboards still hold the old token: reload them to pick up the new one.");
  status("This CLI reads the new token from the token file automatically.");
  status("Scripts that cached the old token must read it again.");
  return EX.OK;
}
