const TERMINAL_STATES = new Set(["succeeded", "failed", "timed_out", "killed", "cancelled", "skipped", "lost"]);

/** True once a run can no longer change (its log is complete). */
export function isTerminalState(state: string | null | undefined): boolean {
  return !!state && TERMINAL_STATES.has(state);
}
