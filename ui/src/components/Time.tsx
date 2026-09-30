import { relativeTickMs, useNow } from "../hooks/useNow.ts";
import { formatDuration, formatRelative, formatTimeWithZone } from "../util/format.ts";

/**
 * A relative time ("5m ago", "in 2h") that keeps counting, with the absolute
 * local time (and zone) in the tooltip.
 */
export function RelativeTime({
  at,
  className,
  fallback = "—",
  upcoming,
}: {
  at: number | null | undefined;
  className?: string;
  fallback?: string;
  /** A scheduled time (next run): never rounds a moment ahead to "just now". */
  upcoming?: boolean;
}) {
  const now = useNow(relativeTickMs(at));
  if (at == null) return <span className={className}>{fallback}</span>;
  return (
    <time
      className={className}
      dateTime={new Date(at).toISOString()}
      title={formatTimeWithZone(at)}
    >
      {formatRelative(at, now, { upcoming })}
    </time>
  );
}

/** Time elapsed since `since`, ticking every second. For runs that are still going. */
export function Elapsed({ since, className }: { since: number | null | undefined; className?: string }) {
  const now = useNow(1_000);
  if (since == null) return <span className={className}>—</span>;
  return <span className={className}>{formatDuration(Math.max(0, now - since))}</span>;
}
