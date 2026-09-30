import type { z } from "zod";
import type { Database } from "bun:sqlite";
import type { CronAdapter } from "../adapters/cron.ts";
import type { WebhookAdapter } from "../adapters/webhook.ts";
import type { JobRegistry } from "../registry.ts";
import type { Runner } from "../runner.ts";
import { API_BODY_MAX_BYTES, errorJson, readBodyCapped } from "./router.ts";

/** What the job, trigger and config handlers are given by the server. */
export type ApiCtx = {
  db: Database;
  registry: () => JobRegistry | null;
  cronAdapter: () => CronAdapter | null;
  runner: () => Runner | null;
  /** Optional: reconciled together with cron when no state subscriber is registered. */
  webhookAdapter?: () => WebhookAdapter | null;
  /** Called after any job/trigger DB write so SSE listeners can refresh. */
  emitConfigReloaded: () => void;
};

/**
 * Put freshly written job/trigger state (enabled flags, pause) into effect and
 * tell SSE listeners. The one place every state-changing handler goes through.
 *
 * The supervisor subscribes to the registry and reconciles the cron AND
 * webhook adapters (and the pause timer is re-armed). Without a subscriber (a
 * bare registry in tests) the cron adapter, and the webhook adapter when the
 * context has one, are reconciled directly.
 */
export function applyScheduling(ctx: ApiCtx): void {
  const reg = ctx.registry();
  if (reg && reg.notifyStateChanged() === 0) {
    ctx.cronAdapter()?.reconcile(reg.activeCronJobs());
    ctx.webhookAdapter?.()?.reconcile(reg.webhookJobs());
  }
  ctx.emitConfigReloaded();
}

/**
 * Read and validate a JSON request body. An empty body counts as `{}`. On
 * failure returns the response to send: 413/400 for a bad size, 400
 * `invalid_json` for malformed JSON, 400 `invalid_body` (with `details`) when
 * it is not an object that satisfies the schema.
 */
export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: Response }> {
  const read = await readBodyCapped(req, API_BODY_MAX_BYTES);
  if (!read.ok) {
    return {
      ok: false,
      response:
        read.reason === "too_large"
          ? errorJson(413, "payload_too_large")
          : errorJson(400, "bad_request"),
    };
  }
  const text = new TextDecoder().decode(read.bytes);
  let data: unknown = {};
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, response: errorJson(400, "invalid_json") };
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      ok: false,
      response: errorJson(400, "invalid_body", { details: "request body must be a JSON object" }),
    };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`)
      .join("; ");
    return { ok: false, response: errorJson(400, "invalid_body", { details }) };
  }
  return { ok: true, value: parsed.data };
}
