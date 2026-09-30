// Resolve what a user typed as a run id (the 8-character short id from
// `auto runs`, a longer prefix, or a full UUID) through the API, which owns
// the matching rules: exact id, else unique prefix, else unique suffix, at
// least 6 hex digits.

import { ApiError, type ApiClient, type RunDetail } from "./client.ts";
import { shortRunId } from "./runtime.ts";

export type RunRef =
  | { ok: true; run: RunDetail }
  | { ok: false; code: number; message: string };

/** Looks like something the run resolver could accept (hex digits and hyphens, at least 6 digits). */
export function looksLikeRunRef(text: string): boolean {
  return /^[0-9a-f-]+$/i.test(text) && text.replace(/-/g, "").length >= 6;
}

const NOT_A_RUN_ID = (ref: string): RunRef => ({
  ok: false,
  code: 1,
  message: `'${ref}' is not a run id: use at least 6 hex characters, as shown by \`auto runs\``,
});

export async function resolveRun(client: ApiClient, ref: string): Promise<RunRef> {
  // An empty reference would hit the run list's URL; say what is wrong instead.
  if (ref.trim() === "") return NOT_A_RUN_ID(ref);
  try {
    return { ok: true, run: await client.run(ref) };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) {
        return { ok: false, code: 1, message: `no run matching '${ref}' (see \`auto runs\` for recent run ids)` };
      }
      if (err.status === 400) {
        return NOT_A_RUN_ID(ref);
      }
      if (err.status === 409) {
        const body = err.body as { candidates?: string[] } | null;
        // The ids `auto runs` prints, not the full UUIDs.
        const candidates = (body?.candidates ?? []).map(shortRunId).join(", ");
        return {
          ok: false,
          code: 1,
          message: `'${ref}' matches more than one run${candidates ? ` (${candidates})` : ""}; use more characters`,
        };
      }
    }
    throw err;
  }
}
