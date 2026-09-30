import type { ConfigStatus } from "../api/types.ts";
import type { ConfigIssue } from "./configIssue.ts";

export type Health = "ok" | "warn" | "bad" | "unknown";

/**
 * What the header dot says. It reflects the last status received only while
 * that is still current: when the status refetch is failing or the live event
 * stream is down, the supervisor may not be healthy at all, so the answer is
 * "unknown" rather than a stale "healthy".
 */
export function statusHealth(input: {
  data: Pick<ConfigStatus, "ok" | "degraded" | "warnings"> | undefined;
  issue: ConfigIssue | null;
  /** The last status refetch failed (the data, if any, is from before). */
  refreshFailed: boolean;
  /** The event stream is not open (retrying or unauthorized). */
  connectionDown: boolean;
}): Health {
  const { data, issue, refreshFailed, connectionDown } = input;
  if (!data || refreshFailed || connectionDown) return "unknown";
  if (data.degraded.active) return "bad";
  if (!data.ok || issue || (data.warnings ?? []).length > 0) return "warn";
  return "ok";
}
