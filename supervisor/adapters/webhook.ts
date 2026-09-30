import type { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Automation, WebhookTrigger } from "../config.ts";
import type { JobRegistry } from "../registry.ts";
import type { RunFinishedEvent, Runner } from "../runner.ts";
import type { SecretStore } from "../secrets.ts";
import { uuidv7 } from "../db/ids.ts";
import { readBodyCapped } from "../api/router.ts";

type Route = { job: Automation; trigger: WebhookTrigger };

// Replay protection. The delivery-id header is not covered by the HMAC and the
// scheme has no signed timestamp, so a captured request can be replayed with a
// different delivery id, and anyone holding one captured request could claim
// an id the real sender will use next. Two rules follow:
//  - the same delivery id AND the same body digest is a duplicate at any age
//    (a sender's retry of the delivery it already made);
//  - the same body digest inside this window is a duplicate whatever the
//    delivery id says.
// The delivery id alone never suppresses anything, so a replayed request
// cannot pre-empt a later legitimate delivery that carries a different body.
// Replays after the window cannot be prevented without a signed timestamp;
// identical payloads are accepted again once the window has passed. The cost
// is that a sender that legitimately posts the same body twice inside the
// window (with distinct delivery ids) has the second one dropped as a
// duplicate, and a retry that changes the body counts as a new delivery.
export const DEDUPE_WINDOW_MS = 5 * 60_000;

const MAX_DELIVERY_ID_LEN = 256;
const RETRY_AFTER_SECONDS = "60";
const SWEEP_INTERVAL_MS = 10 * 60_000;
// Payload files younger than this are never swept: they may belong to a
// request that is still being admitted.
const SWEEP_MIN_AGE_MS = 5 * 60_000;
const RECEIPT_ID_RE = /^[0-9a-f-]{36}$/;
// Admitted deliveries. Anything else in webhook_deliveries never produced a run.
const ADMITTED = "('started', 'queued')";

export class WebhookAdapter {
  private routes = new Map<string, Route>();
  private wiredRunners = new WeakSet<Runner>();
  private inFlight = new Set<string>();
  private lastSweep = 0;
  private lastSecretWarning = new Map<string, number>();

  constructor(private readonly opts: {
    db: Database;
    registry: () => JobRegistry | null;
    runner: () => Runner | null;
    secrets: SecretStore;
    dataDir: string;
  }) {}

  reconcile(jobs: Automation[]): void {
    const next = new Map<string, Route>();
    for (const job of jobs) {
      for (const trigger of job.triggers) {
        if (trigger.kind !== "webhook") continue;
        next.set(trigger.path, { job, trigger });
      }
    }
    this.routes = next;
    this.wireRunner();
    this.maybeSweep();
  }

  async handle(path: string, req: Request): Promise<Response> {
    // Order: path/method -> signature shape -> size -> signature -> content-type
    // -> dedupe -> admission. An unauthenticated caller gets the same bare 401
    // for an unknown path, a wrong method, a missing or malformed signature, a
    // wrong signature and a trigger whose secret is not usable, so none of them
    // reveals which paths exist or which secrets are set. The one exception is
    // 413, which a caller can only reach with a well-formed signature header
    // and an oversize body.
    const route = this.routes.get(path);
    if (!route || req.method !== "POST") return unauthorized();
    const { job, trigger } = route;
    this.wireRunner();
    this.maybeSweep();

    // Without a well-formed signature header there is nothing to verify: answer
    // before reading (or sizing) the body.
    const supplied = decodeSignature(req.headers.get(trigger.auth.signatureHeader), trigger.auth.signaturePrefix);
    if (!supplied) return unauthorized();

    const body = await readBodyCapped(req, trigger.maxBodyBytes);
    if (!body.ok) {
      if (body.reason === "too_large") return response(413, { error: "payload_too_large" }, { connection: "close" });
      return response(400, { error: "bad_request" });
    }
    const bytes = body.bytes;

    // The secret file is only loaded for a request that carries a well-formed signature.
    let secret: string | null;
    try {
      this.opts.secrets.load();
      secret = this.opts.secrets.get(trigger.auth.secretRef);
    } catch (err) {
      this.complainSecret(job.name, trigger.id, `secrets file unusable: ${errorMessage(err)}`);
      return unauthorized();
    }
    if (!secret) {
      this.complainSecret(job.name, trigger.id, `secret "${trigger.auth.secretRef}" is not set (auto secret set ${trigger.auth.secretRef})`);
      return unauthorized();
    }
    const expected = createHmac("sha256", secret).update(bytes).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return unauthorized();

    const contentType = (req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!trigger.contentTypes.some((v) => v.toLowerCase() === contentType)) {
      return response(415, { error: "unsupported_content_type" });
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    const rawDeliveryId = trigger.deliveryIdHeader ? req.headers.get(trigger.deliveryIdHeader) : null;
    const deliveryId = rawDeliveryId && rawDeliveryId.length <= MAX_DELIVERY_ID_LEN ? rawDeliveryId : null;
    const triggerId = `${job.name}:${trigger.id}`;
    const now = Date.now();

    const existing = this.findDuplicate(triggerId, deliveryId, digest, now);
    if (existing) return response(202, { receipt_id: existing.receipt_id, run_id: existing.run_id, duplicate: true });
    // Identical deliveries racing each other: only the first one is admitted.
    const flightKey = `${triggerId}\0d:${digest}`;
    if (this.inFlight.has(flightKey)) {
      return response(202, { receipt_id: null, run_id: null, duplicate: true });
    }
    this.inFlight.add(flightKey);
    try {
      return await this.admit({ job, trigger, triggerId, bytes, contentType, digest, deliveryId });
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  /** Tell the operator (stderr only, at most once a minute per trigger) why a signed delivery could not be checked. */
  private complainSecret(jobName: string, triggerId: string, why: string): void {
    const key = `${jobName}:${triggerId}`;
    const now = Date.now();
    if (now - (this.lastSecretWarning.get(key) ?? 0) < 60_000) return;
    this.lastSecretWarning.set(key, now);
    console.error(`[webhook] ${key}: cannot verify deliveries, answering 401: ${why}`);
  }

  private async admit(d: {
    job: Automation;
    trigger: WebhookTrigger;
    triggerId: string;
    bytes: Uint8Array;
    contentType: string;
    digest: string;
    deliveryId: string | null;
  }): Promise<Response> {
    const { job, trigger, triggerId, bytes, digest, deliveryId } = d;
    const runner = this.opts.runner();
    if (!runner) return response(503, { error: "supervisor_degraded" }, { "retry-after": RETRY_AFTER_SECONDS });
    // A trigger switched off with `auto trigger disable` refuses like a disabled job.
    const registry = this.opts.registry();
    if (registry && !registry.webhookTriggerEnabled(job.name, trigger.id)) {
      return response(503, { error: "unavailable", reason: "disabled" }, { "retry-after": RETRY_AFTER_SECONDS });
    }

    // The receipt row is written only once a run exists (started or queued),
    // so a delivery that was not admitted can be retried by the sender. The
    // payload file has to exist before admission because the worker reads it;
    // it is removed again whenever admission does not happen.
    const receiptId = uuidv7();
    const relPath = trigger.keepPayload ? `payloads/${receiptId}.payload` : `payloads/ephemeral/${receiptId}.payload`;
    const payloadPath = resolve(this.opts.dataDir, relPath);
    try {
      mkdirSync(resolve(payloadPath, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(payloadPath, bytes, { mode: 0o600, flag: "wx" });
    } catch (err) {
      safeUnlink(payloadPath);
      console.error(`[webhook] ${triggerId}: could not write payload: ${errorMessage(err)}`);
      return response(503, { error: "unavailable" }, { "retry-after": RETRY_AFTER_SECONDS });
    }

    let result;
    try {
      result = await runner.enqueue(job.name, {
        kind: "webhook",
        trigger_id: trigger.id,
        payloadPath,
        meta: {
          version: 1,
          receipt_id: receiptId,
          delivery_id: deliveryId,
          body_digest: digest,
          content_type: d.contentType,
          byte_count: bytes.byteLength,
          received_at: Date.now(),
        },
      });
    } catch (err) {
      safeUnlink(payloadPath);
      console.error(`[webhook] ${triggerId}: enqueue failed: ${errorMessage(err)}`);
      return response(503, { error: "unavailable" }, { "retry-after": RETRY_AFTER_SECONDS });
    }

    if (result.kind !== "started" && result.kind !== "queued") {
      safeUnlink(payloadPath);
      const reason = result.kind === "skipped" ? (result.reason as string) : result.kind;
      // Disabled or paused: the sender should retry later. Overlap and a full
      // queue are the job's own drop policy: acknowledge and move on.
      // A delivery that lands while the supervisor is stopping is retried too.
      if (reason === "disabled" || reason === "paused" || reason === "shutdown" || result.kind === "conflict") {
        return response(503, { error: "unavailable", reason }, { "retry-after": RETRY_AFTER_SECONDS });
      }
      return response(202, { status: "skipped", reason, run_id: "run_id" in result ? result.run_id : null });
    }

    const runId = result.run_id;
    try {
      this.recordReceipt({
        receiptId, triggerId, dedupeKey: deliveryId ?? digest, deliveryId, digest,
        disposition: result.kind, runId, payloadPath: trigger.keepPayload ? relPath : null,
      });
    } catch (err) {
      // The run already exists; a lost receipt only weakens dedupe.
      console.error(`[webhook] ${triggerId}: could not record receipt ${receiptId}: ${errorMessage(err)}`);
    }
    if (!trigger.keepPayload) {
      // The run may already have finished before this point.
      const terminal = this.opts.db.query<{ state: string }, [string]>(
        `SELECT state FROM runs WHERE run_id = ? AND state NOT IN ('queued', 'running')`,
      ).get(runId);
      if (terminal) this.cleanupRun(runId);
    }
    return response(202, { receipt_id: receiptId, run_id: runId, disposition: result.kind });
  }

  private findDuplicate(
    triggerId: string,
    deliveryId: string | null,
    digest: string,
    now: number,
  ): { receipt_id: string; run_id: string | null } | null {
    return this.opts.db.query<{ receipt_id: string; run_id: string | null }, [string, string | null, string, number]>(
      `SELECT receipt_id, run_id FROM webhook_deliveries
        WHERE trigger_id = ?1 AND disposition IN ${ADMITTED}
          AND ((?2 IS NOT NULL AND dedupe_key = ?2 AND body_digest = ?3) OR (body_digest = ?3 AND received_at > ?4))
        ORDER BY received_at DESC LIMIT 1`,
    ).get(triggerId, deliveryId, digest, now - DEDUPE_WINDOW_MS);
  }

  private recordReceipt(r: {
    receiptId: string;
    triggerId: string;
    dedupeKey: string;
    deliveryId: string | null;
    digest: string;
    disposition: string;
    runId: string;
    payloadPath: string | null;
  }): void {
    const { db } = this.opts;
    db.transaction(() => {
      // (trigger_id, dedupe_key) is UNIQUE. A digest-keyed receipt from before
      // the dedupe window must not block an identical payload forever: rows
      // that never produced a run are dropped, older admitted ones keep their
      // history under a retired key.
      db.prepare(
        `DELETE FROM webhook_deliveries WHERE trigger_id = ? AND dedupe_key = ? AND disposition NOT IN ${ADMITTED}`,
      ).run(r.triggerId, r.dedupeKey);
      db.prepare(
        `UPDATE webhook_deliveries SET dedupe_key = dedupe_key || '@' || receipt_id WHERE trigger_id = ? AND dedupe_key = ?`,
      ).run(r.triggerId, r.dedupeKey);
      db.prepare(
        `INSERT INTO webhook_deliveries (
           receipt_id, trigger_id, dedupe_key, delivery_id, body_digest,
           received_at, disposition, run_id, payload_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.receiptId, r.triggerId, r.dedupeKey, r.deliveryId, r.digest, Date.now(), r.disposition, r.runId, r.payloadPath);
    })();
  }

  private wireRunner(): void {
    const runner = this.opts.runner();
    if (!runner || this.wiredRunners.has(runner)) return;
    const onDone = (event: { run_id: string }) => {
      this.cleanupRun(event.run_id);
      this.maybeSweep();
    };
    runner.on("run.finished", (event: RunFinishedEvent) => onDone(event));
    // A queued run that is cancelled never finishes; it is skipped instead.
    runner.on("run.skipped", (event: { run_id: string }) => onDone(event));
    this.wiredRunners.add(runner);
  }

  /**
   * Remove the ephemeral payload of a finished run. The file is found from the
   * run's own trigger_meta (receipt_id), not from in-memory state, so this
   * also works for runs recorded before a restart.
   */
  private cleanupRun(runId: string): void {
    try {
      const row = this.opts.db.query<{ trigger_kind: string; trigger_meta: string | null }, [string]>(
        `SELECT trigger_kind, trigger_meta FROM runs WHERE run_id = ?`,
      ).get(runId);
      if (!row || row.trigger_kind !== "webhook" || !row.trigger_meta) return;
      const receiptId = (JSON.parse(row.trigger_meta) as { receipt_id?: unknown }).receipt_id;
      if (typeof receiptId !== "string" || !RECEIPT_ID_RE.test(receiptId)) return;
      safeUnlink(resolve(this.opts.dataDir, "payloads", "ephemeral", `${receiptId}.payload`));
    } catch {}
  }

  /**
   * Delete payload files that no queued/running run can still need: everything
   * in payloads/ephemeral, and unreferenced files directly in payloads/ (left
   * by a crash between writing the file and recording the receipt).
   * Rate-limited; runs at startup, on reconcile and after finished runs.
   */
  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      this.sweepPayloads(now);
    } catch (err) {
      console.error(`[webhook] payload sweep failed: ${errorMessage(err)}`);
    }
  }

  private sweepPayloads(now: number): void {
    const root = resolve(this.opts.dataDir, "payloads");
    const activeRows = this.opts.db.query<{ receipt_id: string | null }, []>(
      `SELECT json_extract(trigger_meta, '$.receipt_id') AS receipt_id FROM runs
        WHERE trigger_kind = 'webhook' AND state IN ('queued', 'running')`,
    ).all();
    const active = new Set(activeRows.map((r) => r.receipt_id).filter((v): v is string => typeof v === "string"));
    const referenced = this.opts.db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM webhook_deliveries WHERE receipt_id = ? AND payload_path IS NOT NULL`,
    );
    for (const [dir, checkReferenced] of [[resolve(root, "ephemeral"), false], [root, true]] as const) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".payload")) continue;
        const receiptId = name.slice(0, -".payload".length);
        if (active.has(receiptId)) continue;
        if (checkReferenced && referenced.get(receiptId)!.n > 0) continue;
        const file = resolve(dir, name);
        try {
          if (now - statSync(file).mtimeMs < SWEEP_MIN_AGE_MS) continue;
        } catch { continue; }
        safeUnlink(file);
      }
    }
  }
}

/** Signature header -> raw digest bytes, or null when it is not `<prefix><64 hex digits>`. */
function decodeSignature(header: string | null, prefix: string): Buffer | null {
  if (!header || !header.startsWith(prefix)) return null;
  const hex = header.slice(prefix.length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function unauthorized(): Response {
  return response(401, { error: "unauthorized" });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch {}
}

function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
