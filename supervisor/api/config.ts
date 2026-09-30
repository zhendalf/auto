import { diffConfigForReconciliation, type ConfigStore } from "../config.ts";
import { buildInfo } from "../build-info.ts";
import { degradedMode } from "../lifecycle.ts";
import { errorJson, json, type RouteHandler } from "./router.ts";

type ConfigCtx = {
  configStore: () => ConfigStore | null;
  /**
   * Unused: the config store announces reloads and errors itself (main.ts
   * turns its events into config.reloaded / config.error), so a reload
   * started here is announced exactly once. Kept so callers need not change.
   */
  emitConfigReloaded?: () => void;
  emitConfigError?: (message: string) => void;
};

export function makeConfigHandlers(ctx: ConfigCtx): {
  status: RouteHandler;
  reload: RouteHandler;
} {
  const status: RouteHandler = () => {
    const store = ctx.configStore();
    const snap = degradedMode.snapshot();
    const s = store?.getStatus() ?? null;
    const triggers =
      store?.current?.reduce((acc, j) => acc + j.triggers.length, 0) ?? 0;
    // While degraded the cause is always visible, even if the store itself has
    // no error recorded (for example the failure happened before it existed).
    const lastError =
      s?.lastError ??
      (snap.active && snap.reason
        ? { at: snap.enteredAt ?? Date.now(), message: snap.reason.message }
        : null);
    return json({
      ok: s?.ok ?? false,
      loadedAt: s?.loadedAt ?? null,
      lastError,
      jobs: s?.jobCount ?? 0,
      triggers,
      degraded: {
        active: snap.active,
        reason: snap.reason,
      },
      warnings: s?.warnings ?? [],
      // The code this supervisor process is running (fixed at its start).
      supervisor: buildInfo(),
    });
  };

  const reload: RouteHandler = async () => {
    const store = ctx.configStore();
    if (!store) return errorJson(503, "not_ready");
    const outcome = await store.reload();
    if (!outcome.ok) {
      if (outcome.stage === "stopped") return errorJson(503, "not_ready");
      // "load": the file is invalid; "apply": it is valid but the supervisor
      // could not put it into effect. Either way the last-known-good config
      // keeps running.
      return errorJson(400, "config_invalid", { details: outcome.error, stage: outcome.stage });
    }
    return json({
      ok: true,
      jobs: outcome.config.length,
      triggers: outcome.config.reduce((acc, j) => acc + j.triggers.length, 0),
      errors: [],
      warnings: outcome.warnings,
      changes: diffConfigForReconciliation(outcome.previous, outcome.config),
    });
  };

  return { status, reload };
}
