import { errorJson, json, type RouteHandler } from "./router.ts";
import { applyScheduling, type ApiCtx } from "./support.ts";

export function makeTriggersHandlers(ctx: ApiCtx): {
  enable: RouteHandler;
  disable: RouteHandler;
} {
  const setEnabled = (enabled: 0 | 1): RouteHandler => (_req, params) => {
    const id = params.trigger_id ?? "";
    if (!id) return errorJson(400, "missing_trigger_id");
    const row = ctx.db
      .query<{ trigger_id: string; archived_at: number | null }, [string]>(
        `SELECT trigger_id, archived_at FROM triggers WHERE trigger_id = ?`,
      )
      .get(id);
    if (!row || row.archived_at !== null) return errorJson(404, "not_found", { triggerId: id });
    ctx.db.prepare(`UPDATE triggers SET enabled = ? WHERE trigger_id = ?`).run(enabled, id);
    applyScheduling(ctx);
    return json({ ok: true });
  };

  return { enable: setEnabled(1), disable: setEnabled(0) };
}
