// `auto pause <name> [duration|off]` — pause or unpause a job.

import { ApiError } from "../client.ts";
import { EX, fmtTime, getApiClient, globals, printJson, requireSupervisor, shellWord, status } from "../runtime.ts";

const DEFAULT_DURATION_MS = 60 * 60_000; // 1h

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

/**
 * Parse "30s", "5m", "1h", "2h30m", "1d", etc. → ms. Throws on bad input.
 */
export function parseDuration(s: string): number {
  const trimmed = s.trim().toLowerCase();
  if (trimmed.length === 0) throw new Error("empty duration");
  let total = 0;
  let i = 0;
  let sawAny = false;
  while (i < trimmed.length) {
    let j = i;
    while (j < trimmed.length && trimmed.charCodeAt(j) >= 0x30 && trimmed.charCodeAt(j) <= 0x39) j++;
    if (j === i) throw new Error(`invalid duration: ${s}`);
    const n = parseInt(trimmed.slice(i, j), 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid duration: ${s}`);
    if (j >= trimmed.length) throw new Error(`missing unit at end of duration: ${s}`);
    const unit = trimmed[j]!;
    const mul = UNIT_MS[unit];
    if (mul === undefined) throw new Error(`unknown unit '${unit}' in duration: ${s}`);
    total += n * mul;
    sawAny = true;
    i = j + 1;
  }
  if (!sawAny) throw new Error(`invalid duration: ${s}`);
  return total;
}

const MAX_DURATION_MS = 365 * 24 * 60 * 60_000;

export async function runPause(name: string, durationArg?: string): Promise<number> {
  const unpause = durationArg !== undefined && durationArg.toLowerCase() === "off";

  // Usage errors are reported before the supervisor is contacted.
  let durationMs = DEFAULT_DURATION_MS;
  if (!unpause && durationArg) {
    try {
      durationMs = parseDuration(durationArg);
    } catch (err) {
      status(`${err instanceof Error ? err.message : String(err)} (examples: 30m, 2h, 1d, 1h30m, or 'off' to resume)`);
      return EX.USAGE;
    }
    if (durationMs < 1000 || durationMs > MAX_DURATION_MS) {
      status("duration must be between 1s and 365d");
      return EX.USAGE;
    }
  }

  const client = getApiClient();
  await requireSupervisor(client);
  try {
    if (unpause) {
      await client.unpauseJob(name);
      if (globals().json) printJson({ ok: true, job: name, paused_until: null });
      else status(`unpaused ${name}`);
      return EX.OK;
    }
    const r = await client.pauseJob(name, { duration_ms: durationMs });
    if (globals().json) printJson({ ok: true, job: name, paused_until: r.paused_until });
    else status(`paused ${name} until ${fmtTime(r.paused_until)} (\`auto pause ${shellWord(name)} off\` to resume)`);
    return EX.OK;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      status(`unknown job: ${name} (see \`auto jobs\`)`);
      return EX.ERR;
    }
    throw err;
  }
}
