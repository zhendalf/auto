import type { ConfigStatus } from "../api/types.ts";

export type ConfigIssue = {
  /** "degraded" (the supervisor could not start from the config) or "reload" (the last edit was rejected). */
  mode: "degraded" | "reload";
  kind: string;
  message: string;
  at: number | null;
};

/** The problem, if any, that the config status reports. Null when all is well. */
export function configIssue(status: ConfigStatus | undefined): ConfigIssue | null {
  if (!status) return null;
  if (status.degraded.active) {
    const r = status.degraded.reason;
    return {
      mode: "degraded",
      kind: r?.kind ?? "degraded",
      message: r?.message ?? "The supervisor is in degraded mode.",
      at: status.lastError?.at ?? null,
    };
  }
  if (status.lastError) {
    return { mode: "reload", kind: "config_error", message: status.lastError.message, at: status.lastError.at };
  }
  return null;
}

/**
 * One line for a banner: the first line, joined with the first useful line
 * after it when it only introduces a list ("...failed:"). A build failure's
 * "N errors building <path>" header says nothing the first line did not, so
 * the first real diagnostic is preferred to it.
 */
export function summaryLine(message: string): string {
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  if (!first.endsWith(":")) return first;
  const rest = lines.slice(1);
  const detail = rest.find((l) => !/^\d+ errors? building\b/.test(l)) ?? rest[0];
  return detail ? `${first} ${detail.replace(/^-\s*/, "")}` : first;
}
