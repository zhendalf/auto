import { Chip } from "./Chip.tsx";
import type { Tone } from "./Chip.tsx";

/**
 * Small colored chip showing a run state. Centralised so colors stay
 * consistent across the job list, the runs list and the run page.
 */
const STATE_TONE: Record<string, Tone> = {
  succeeded: "ok",
  failed: "bad",
  timed_out: "orange",
  killed: "bad",
  lost: "bad",
  cancelled: "neutral",
  skipped: "neutral",
  queued: "info",
  running: "warn",
};

export function RunStateBadge({ state }: { state: string | null | undefined }) {
  const label = state ? state.replace(/_/g, " ") : "—";
  const tone = (state && STATE_TONE[state]) || "neutral";
  return (
    <Chip tone={tone} live={state === "running"} upper>
      {label}
    </Chip>
  );
}
