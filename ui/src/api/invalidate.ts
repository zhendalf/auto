import type { QueryClient } from "@tanstack/react-query";

const RUN_EVENTS = new Set(["run.queued", "run.started", "run.finished", "run.skipped"]);
const CONFIG_EVENTS = new Set(["config.reloaded", "config.error"]);
const HEALTH_EVENTS = new Set(["degraded.exited"]);

/**
 * Maps an event to the cache entries it makes stale. Events identify the run
 * and the job by id only, so the per-job and per-run caches (keyed by name and
 * by whatever id the URL used) are invalidated by prefix instead of by key.
 */
export function invalidateForEvent(qc: Pick<QueryClient, "invalidateQueries">, name: string): void {
  if (RUN_EVENTS.has(name) || CONFIG_EVENTS.has(name)) {
    qc.invalidateQueries({ queryKey: ["jobs"] });
    qc.invalidateQueries({ queryKey: ["job"] });
    qc.invalidateQueries({ queryKey: ["runs"] });
  }
  if (RUN_EVENTS.has(name)) {
    qc.invalidateQueries({ queryKey: ["run"] });
  }
  if (CONFIG_EVENTS.has(name) || HEALTH_EVENTS.has(name)) {
    qc.invalidateQueries({ queryKey: ["config-status"] });
  }
  if (HEALTH_EVENTS.has(name)) {
    qc.invalidateQueries({ queryKey: ["jobs"] });
  }
}
