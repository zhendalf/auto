import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEDUPE_WINDOW_MS, WebhookAdapter } from "../supervisor/adapters/webhook.ts";
import { readBodyCapped } from "../supervisor/api/router.ts";
import type { Automation, WebhookTrigger } from "../supervisor/config.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";
import { SecretStore } from "../supervisor/secrets.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "ingress-secret";
const temps: string[] = [];
const dbs: Database[] = [];
const runners: Runner[] = [];
afterEach(async () => {
  // Let in-flight workers finish before their database and temp dir go away.
  const active = (db: Database) =>
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs WHERE state IN ('queued', 'running')").get()!.n;
  const deadline = Date.now() + 2_000;
  while (dbs.some((db) => active(db) > 0) && Date.now() < deadline) await Bun.sleep(10);
  while (runners.length) await runners.pop()!.shutdown(200);
  while (dbs.length) { try { dbs.pop()!.close(); } catch {} }
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

type EnqueueOverride = (jobName: string, ctx: unknown) => Promise<unknown> | unknown;

type Harness = {
  tmp: string;
  db: Database;
  adapter: WebhookAdapter;
  runner: Runner;
  secrets: SecretStore;
  loads: { n: number };
  /** Queue of one-shot enqueue overrides; when empty the real runner is used. */
  overrides: EnqueueOverride[];
  setRunnerAbsent(absent: boolean): void;
  post(body: string, headers?: Record<string, string>, opts?: { sign?: boolean }): Promise<Response>;
};

async function harness(
  triggerOverrides: Partial<WebhookTrigger> = {},
  jobOverrides: Partial<Automation> = {},
  opts: { withSecret?: boolean; worker?: string } = {},
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "webhook-ingress-"));
  temps.push(tmp);
  const secretPath = join(tmp, "secrets.json");
  const withSecret = opts.withSecret ?? true;
  writeFileSync(
    secretPath,
    JSON.stringify({ version: 1, secrets: withSecret ? { hook: SECRET } : { other: "x" } }),
    { mode: 0o600 },
  );
  const secrets = new SecretStore(secretPath);
  const loads = { n: 0 };
  const realLoad = secrets.load.bind(secrets);
  secrets.load = () => { loads.n++; realLoad(); };

  const db = new Database(join(tmp, "test.db"));
  dbs.push(db);
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  const job: Automation = {
    id: "hook-job", name: "hook-job", worker: opts.worker ?? "./test/fixtures/hello-worker.ts",
    triggers: [{
      kind: "webhook", id: "inbound", path: "inbound",
      auth: { profile: "hmac-sha256", secretRef: "hook", signatureHeader: "x-signature", signaturePrefix: "sha256=" },
      deliveryIdHeader: "x-delivery", contentTypes: ["application/json"], maxBodyBytes: 1024, keepPayload: false,
      ...triggerOverrides,
    } as WebhookTrigger],
    reentrancy: "drop", queueDepth: 1, timeoutMs: 5_000, killGraceMs: 100, enabled: true,
    ...jobOverrides,
  };
  const registry = new JobRegistry({ db });
  registry.reconcile([job]);
  const real = new Runner({ db, registry, workspaceRoot: ROOT, dataDir: tmp, logsDir: join(tmp, "runs") });
  runners.push(real);
  const overrides: EnqueueOverride[] = [];
  let absent = false;
  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop === "enqueue") {
        return (jobName: string, ctx: unknown, o?: unknown) => {
          const next = overrides.shift();
          if (next) return next(jobName, ctx);
          return (target.enqueue as (...a: unknown[]) => unknown).call(target, jobName, ctx, o);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Runner;
  const adapter = new WebhookAdapter({
    db, registry: () => registry, runner: () => (absent ? null : wrapped), secrets, dataDir: tmp,
  });
  adapter.reconcile(registry.webhookJobs());

  return {
    tmp, db, adapter, runner: real, secrets, loads, overrides,
    setRunnerAbsent: (v) => { absent = v; },
    post: (body, headers = {}, o = {}) => {
      const h: Record<string, string> = { "content-type": "application/json", ...headers };
      if (o.sign !== false && !("x-signature" in h)) h["x-signature"] = sign(body);
      return adapter.handle("inbound", new Request("http://localhost/hooks/inbound", { method: "POST", headers: h, body }));
    },
  };
}

function sign(body: string | Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
}

const receiptCount = (db: Database) =>
  db.query<{ n: number }, []>("SELECT count(*) AS n FROM webhook_deliveries").get()!.n;

function payloadFiles(tmp: string): string[] {
  const out: string[] = [];
  for (const dir of [join(tmp, "payloads"), join(tmp, "payloads", "ephemeral")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (name.endsWith(".payload")) out.push(join(dir, name));
  }
  return out;
}

/** A body stream that counts how many bytes were pulled from it. */
function countingStream(chunks: number, chunkSize: number): { stream: ReadableStream<Uint8Array>; pulled: { bytes: number } } {
  const pulled = { bytes: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) { controller.close(); return; }
      sent++;
      pulled.bytes += chunkSize;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
    },
  });
  return { stream, pulled };
}

describe("body handling", () => {
  test("a chunked body over the limit is refused with 413 without being fully read", async () => {
    const h = await harness({ maxBodyBytes: 1024 });
    const { stream, pulled } = countingStream(2_000, 1024); // ~2 MB, no Content-Length
    const req = new Request("http://localhost/hooks/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign("x") },
      body: stream,
      duplex: "half",
    });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await h.adapter.handle("inbound", req);
    expect(res.status).toBe(413);
    // The reader stops right after the limit is crossed (plus stream read-ahead), far below 2 MB.
    expect(pulled.bytes).toBeLessThan(64 * 1024);
    expect(receiptCount(h.db)).toBe(0);
    expect(payloadFiles(h.tmp)).toEqual([]);
  });

  test("a declared Content-Length over the limit is refused before reading", async () => {
    const h = await harness({ maxBodyBytes: 10 });
    const res = await h.post("x".repeat(11), { "x-signature": "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(413);
    // Without a well-formed signature header there is no answer about size at all.
    const unsigned = await h.post("x".repeat(11), { "x-signature": "irrelevant" });
    expect(unsigned.status).toBe(401);
  });

  test("readBodyCapped rejects an untrustworthy Content-Length", async () => {
    // A hand-built request-like object: `new Request` normalises Content-Length itself.
    const fake = (headers: Record<string, string>, body: string) =>
      ({ headers: new Headers(headers), body: new Response(body).body }) as unknown as Request;
    for (const length of ["abc", "-1", "1e2", "0x10", " 2x", "2, 2", ""]) {
      expect(await readBodyCapped(fake({ "content-length": length }, "{}"), 1024)).toEqual({ ok: false, reason: "bad_length" });
    }
    expect(await readBodyCapped(fake({ "content-length": "2", "transfer-encoding": "chunked" }, "{}"), 1024))
      .toEqual({ ok: false, reason: "bad_length" });
    // Declared length disagrees with the bytes that arrive.
    expect(await readBodyCapped(fake({ "content-length": "2" }, "{}{}"), 1024)).toEqual({ ok: false, reason: "bad_length" });
    expect(await readBodyCapped(fake({ "content-length": "9" }, "{}"), 1024)).toEqual({ ok: false, reason: "bad_length" });
    // Declared over the cap is refused without reading anything.
    expect(await readBodyCapped(fake({ "content-length": "2000" }, ""), 1024)).toEqual({ ok: false, reason: "too_large" });
    const ok = await readBodyCapped(fake({ "content-length": "2" }, "{}"), 1024);
    expect(ok.ok).toBe(true);
  });

  test("over real HTTP: chunked oversize and Content-Length/Transfer-Encoding conflicts are refused", async () => {
    const h = await harness({ maxBodyBytes: 1024 });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => h.adapter.handle("inbound", req) });
    try {
      const raw = async (head: string, payload = ""): Promise<string> => {
        let out = "";
        const done = Promise.withResolvers<void>();
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port: server.port!,
          socket: {
            data(_s, d) { out += Buffer.from(d).toString("latin1"); },
            close() { done.resolve(); },
            error() { done.resolve(); },
            open(s) { s.write(head + payload); },
          },
        });
        await Promise.race([done.promise, Bun.sleep(1_500)]);
        socket.end();
        return out;
      };
      const base = `POST /hooks/inbound HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nX-Signature: ${sign("x")}\r\nConnection: close\r\n`;
      // Chunked body: 3 chunks of 600 bytes = 1800 > 1024, no Content-Length.
      const chunk = "x".repeat(600);
      const chunked = base + "Transfer-Encoding: chunked\r\n\r\n" + [chunk, chunk, chunk].map((c) => `${c.length.toString(16)}\r\n${c}\r\n`).join("") + "0\r\n\r\n";
      const r1 = await raw(chunked);
      expect(r1.startsWith("HTTP/1.1 413")).toBe(true);
      // Content-Length smaller than the bytes actually sent is never trusted.
      const r2 = await raw(base + "Content-Length: 2\r\n\r\n", "{}{}{}{}");
      // The server frames the request by Content-Length, so the sender's extra bytes never join the body.
      expect(r2.startsWith("HTTP/1.1 202")).toBe(false);
      // Both Content-Length and Transfer-Encoding.
      const r3 = await raw(base + "Content-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n", "2\r\n{}\r\n0\r\n\r\n");
      expect(r3.startsWith("HTTP/1.1 202")).toBe(false);
      expect(receiptCount(h.db)).toBe(0);
      expect(payloadFiles(h.tmp)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("readBodyCapped: exact size passes, one byte over fails, empty body is empty", async () => {
    const mk = (body: string | null, headers: Record<string, string> = {}) =>
      new Request("http://localhost/x", { method: "POST", body, headers });
    const ok = await readBodyCapped(mk("abcd"), 4);
    expect(ok.ok && ok.bytes.byteLength).toBe(4);
    const over = await readBodyCapped(mk("abcde"), 4);
    expect(over).toEqual({ ok: false, reason: "too_large" });
    const empty = await readBodyCapped(mk(null), 4);
    expect(empty.ok && empty.bytes.byteLength).toBe(0);
  });
});

describe("check order and uniform answers", () => {
  test("an unknown path and a wrong method answer the same bare 401 as a bad signature", async () => {
    const h = await harness();
    const wrongSig = await h.post("{}", { "x-signature": "sha256=" + "0".repeat(64) });
    const loadsBefore = h.loads.n;
    expect(loadsBefore).toBeGreaterThan(0);
    const missing = await h.adapter.handle("nope", new Request("http://localhost/hooks/nope", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(401);
    const reference = await wrongSig.text();
    expect(await missing.text()).toBe(reference);
    for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
      const res = await h.adapter.handle("inbound", new Request("http://localhost/hooks/inbound", { method }));
      expect(res.status).toBe(401);
      expect(res.headers.get("allow")).toBeNull();
    }
    // None of that touches the secret store (only the well-formed but wrong signature did).
    expect(h.loads.n).toBe(loadsBefore);
  });

  test("size is checked before signature, signature before content type", async () => {
    const h = await harness({ maxBodyBytes: 16 });
    const big = await h.post("x".repeat(64), { "x-signature": "sha256=" + "0".repeat(64), "content-type": "text/plain" });
    expect(big.status).toBe(413);
    const badSigWrongType = await h.post("{}", { "x-signature": "sha256=" + "0".repeat(64), "content-type": "text/plain" });
    expect(badSigWrongType.status).toBe(401);
    const goodSigWrongType = await h.post("{}", { "content-type": "text/plain" });
    expect(goodSigWrongType.status).toBe(415);
    expect(receiptCount(h.db)).toBe(0);
  });

  test("missing, malformed and wrong signatures all get the same 401 and never load secrets when malformed", async () => {
    const h = await harness();
    const missing = await h.post("{}", {}, { sign: false });
    const malformed = await h.post("{}", { "x-signature": "bad" });
    const wrongPrefix = await h.post("{}", { "x-signature": "sha1=" + "a".repeat(64) });
    const short = await h.post("{}", { "x-signature": "sha256=abcd" });
    expect(h.loads.n).toBe(0); // cheap shape checks failed first
    const wrong = await h.post("{}", { "x-signature": "sha256=" + "0".repeat(64) });
    expect(h.loads.n).toBeGreaterThan(0); // a well-formed signature does reach the store
    const bodies = [];
    for (const res of [missing, malformed, wrongPrefix, short, wrong]) {
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain("secret");
    expect(receiptCount(h.db)).toBe(0);
  });

  test("hex digits of the signature are compared case-insensitively", async () => {
    const h = await harness();
    const body = JSON.stringify({ a: 1 });
    const upper = "sha256=" + sign(body).slice("sha256=".length).toUpperCase();
    const res = await h.post(body, { "x-signature": upper });
    expect(res.status).toBe(202);
  });

  test("a trigger whose secret is missing answers the same 401 as a wrong signature (no path or secret oracle)", async () => {
    const h = await harness({}, {}, { withSecret: false });
    const res = await h.post("{}");
    expect(res.status).toBe(401);
    const wrong = await (await harness()).post("{}", { "x-signature": "sha256=" + "0".repeat(64) });
    expect(await res.text()).toBe(await wrong.text());
    expect(receiptCount(h.db)).toBe(0);
  });

  test("an invalid secret store answers the same 401 and never echoes the file's content", async () => {
    const h = await harness();
    writeFileSync(h.secrets.path, '{"version":1,"secrets":{"hook":topsecretvalue123}}', { mode: 0o600 });
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    try {
      const res = await h.post("{}");
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("secret");
    } finally {
      console.error = realError;
    }
    // The operator is told why (stderr), without the secret value from the broken file.
    expect(errors.join("\n")).toContain("cannot verify deliveries");
    expect(errors.join("\n")).not.toContain("topsecretvalue123");
  });
});

describe("replay and dedupe", () => {
  test("the same signed body replayed with a different delivery id is a duplicate", async () => {
    const h = await harness();
    const body = JSON.stringify({ n: 1 });
    const first = await h.post(body, { "x-delivery": "d-1" });
    expect(first.status).toBe(202);
    const runId = ((await first.json()) as { run_id: string }).run_id;
    const replay = await h.post(body, { "x-delivery": "d-2" });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ duplicate: true, run_id: runId });
    expect(receiptCount(h.db)).toBe(1);
    await waitFor(() => h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()!.n === 1);
  });

  test("a delivery id alone never suppresses a different body (the header is not signed)", async () => {
    // Anyone holding one captured request could replay it under the id the real
    // sender will use next; the later, genuine delivery must still run.
    const h = await harness();
    const captured = JSON.stringify({ n: 1 });
    expect((await h.post(captured, { "x-delivery": "1001" })).status).toBe(202);
    // Let the first run finish so the job's own overlap policy is not what answers next.
    await waitFor(() => h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs WHERE state IN ('queued','running')").get()!.n === 0);
    const genuine = await h.post(JSON.stringify({ n: 2 }), { "x-delivery": "1001" });
    expect(genuine.status).toBe(202);
    const body = (await genuine.json()) as { duplicate?: boolean; disposition?: string };
    expect(body.duplicate).toBeUndefined();
    expect(body.disposition).toBeDefined();
    expect(receiptCount(h.db)).toBe(2);
  });

  test("the same delivery id with the same body is still a duplicate, however late", async () => {
    const h = await harness();
    const body = JSON.stringify({ n: 1 });
    const first = await h.post(body, { "x-delivery": "d-1" });
    const runId = ((await first.json()) as { run_id: string }).run_id;
    h.db.run("UPDATE webhook_deliveries SET received_at = received_at - ?", [DEDUPE_WINDOW_MS * 100]);
    const retry = await h.post(body, { "x-delivery": "d-1" });
    expect(await retry.json()).toMatchObject({ duplicate: true, run_id: runId });
  });

  test("an over-long delivery id is ignored rather than trusted", async () => {
    const h = await harness();
    const long = "d".repeat(300);
    expect((await h.post(JSON.stringify({ n: 1 }), { "x-delivery": long })).status).toBe(202);
    const row = h.db.query<{ delivery_id: string | null }, []>("SELECT delivery_id FROM webhook_deliveries").get()!;
    expect(row.delivery_id).toBeNull();
  });

  test("digest-only dedupe expires: an identical body is accepted again after the window", async () => {
    const h = await harness({ deliveryIdHeader: undefined });
    const body = JSON.stringify({ tick: true });
    const first = await h.post(body);
    const firstId = ((await first.json()) as { run_id: string }).run_id;
    const second = await h.post(body);
    expect(await second.json()).toMatchObject({ duplicate: true, run_id: firstId });

    // Age the receipt past the window: same key, same body, now legitimate again.
    h.db.run("UPDATE webhook_deliveries SET received_at = received_at - ?", [DEDUPE_WINDOW_MS + 1_000]);
    await waitFor(() => h.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(firstId)?.state === "succeeded");
    const third = await h.post(body);
    expect(third.status).toBe(202);
    const thirdBody = (await third.json()) as { run_id: string; duplicate?: boolean };
    expect(thirdBody.duplicate).toBeUndefined();
    expect(thirdBody.run_id).not.toBe(firstId);
    // The old receipt keeps its history under a retired key.
    expect(receiptCount(h.db)).toBe(2);
    // And the new one dedupes again.
    expect(await (await h.post(body)).json()).toMatchObject({ duplicate: true, run_id: thirdBody.run_id });
  });

  test("a legacy accepted/skipped receipt from an older build does not block a retry", async () => {
    const h = await harness({ deliveryIdHeader: undefined });
    const body = JSON.stringify({ legacy: 1 });
    const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    h.db.run(
      `INSERT INTO webhook_deliveries (receipt_id, trigger_id, dedupe_key, delivery_id, body_digest, received_at, disposition, payload_path)
       VALUES ('legacy-1', 'hook-job:inbound', ?, NULL, ?, ?, 'accepted', NULL)`,
      [digest, digest, Date.now()],
    );
    const res = await h.post(body);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ disposition: "started" });
    expect(h.db.query("SELECT 1 FROM webhook_deliveries WHERE receipt_id = 'legacy-1'").get()).toBeNull();
  });

  test("identical deliveries racing each other admit only one run", async () => {
    const h = await harness();
    const body = JSON.stringify({ race: 1 });
    const results = await Promise.all([h.post(body), h.post(body), h.post(body)]);
    expect(results.every((r) => r.status === 202)).toBe(true);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { duplicate?: boolean }[];
    expect(bodies.filter((b) => !b.duplicate).length).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()!.n).toBe(1);
  });
});

describe("events are not lost", () => {
  test("a delivery skipped for overlap leaves no receipt, and the retry is admitted", async () => {
    const h = await harness({}, { reentrancy: "drop" }, { worker: "./test/fixtures/sleep-worker.ts" });
    const first = await h.post(JSON.stringify({ n: 1 }), { "x-delivery": "d-1" });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { run_id: string };

    const body2 = JSON.stringify({ n: 2 });
    const skipped = await h.post(body2, { "x-delivery": "d-2" });
    expect(skipped.status).toBe(202);
    expect(await skipped.json()).toMatchObject({ status: "skipped", reason: "overlap" });
    expect(receiptCount(h.db)).toBe(1); // only the first
    expect(payloadFiles(h.tmp).length).toBe(1); // the running run's payload; nothing orphaned

    await h.runner.cancel(firstBody.run_id);
    await waitFor(() => h.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(firstBody.run_id)?.state !== "running");

    const retry = await h.post(body2, { "x-delivery": "d-2" });
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as { duplicate?: boolean; disposition?: string };
    expect(retryBody.duplicate).toBeUndefined();
    expect(retryBody.disposition).toBe("started");
    await h.runner.shutdown(1_000);
  });

  test("a delivery that lands while the runner is shutting down is refused with 503 + Retry-After, leaves nothing, and the retry works elsewhere", async () => {
    const h = await harness();
    void h.runner.shutdown(1_000); // not awaited: the window in which admission is already closed
    const body = JSON.stringify({ s: 1 });
    const res = await h.post(body, { "x-delivery": "s-1" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "unavailable", reason: "shutdown" });
    expect(receiptCount(h.db)).toBe(0);
    expect(payloadFiles(h.tmp)).toEqual([]);
    await h.runner.shutdown(1_000);
  });

  test("queue_full is acknowledged as skipped and retried later", async () => {
    const h = await harness();
    h.overrides.push(() => ({ kind: "skipped", reason: "queue_full", run_id: "r-x" }));
    const body = JSON.stringify({ q: 1 });
    const skipped = await h.post(body, { "x-delivery": "q-1" });
    expect(skipped.status).toBe(202);
    expect(await skipped.json()).toMatchObject({ status: "skipped", reason: "queue_full" });
    expect(receiptCount(h.db)).toBe(0);
    expect(payloadFiles(h.tmp)).toEqual([]);
    const retry = await h.post(body, { "x-delivery": "q-1" });
    expect(await retry.json()).toMatchObject({ disposition: "started" });
  });

  test("disabled and paused answer 503 with Retry-After, and the retry is accepted", async () => {
    const h = await harness();
    const body = JSON.stringify({ d: 1 });
    for (const reason of ["disabled", "paused"]) {
      h.overrides.push(() => ({ kind: "skipped", reason, run_id: "r-y" }));
      const res = await h.post(body, { "x-delivery": "d-1" });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBeTruthy();
      expect(receiptCount(h.db)).toBe(0);
      expect(payloadFiles(h.tmp)).toEqual([]);
    }
    const retry = await h.post(body, { "x-delivery": "d-1" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ disposition: "started" });
  });

  test("a genuinely disabled job (real runner) is a 503 and leaves nothing behind", async () => {
    const h = await harness({}, { enabled: false });
    const res = await h.post(JSON.stringify({ x: 1 }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(receiptCount(h.db)).toBe(0);
    expect(payloadFiles(h.tmp)).toEqual([]);
  });

  test("an enqueue exception answers 503, removes the payload, and the retry is accepted", async () => {
    const h = await harness();
    h.overrides.push(() => { throw new Error("boom"); });
    const body = JSON.stringify({ e: 1 });
    const res = await h.post(body, { "x-delivery": "e-1" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(receiptCount(h.db)).toBe(0);
    expect(payloadFiles(h.tmp)).toEqual([]);
    const retry = await h.post(body, { "x-delivery": "e-1" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ disposition: "started" });
  });

  test("runner absent answers 503 without a receipt or payload; retry works once it is back", async () => {
    const h = await harness();
    h.setRunnerAbsent(true);
    const body = JSON.stringify({ a: 1 });
    const res = await h.post(body, { "x-delivery": "a-1" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(receiptCount(h.db)).toBe(0);
    expect(payloadFiles(h.tmp)).toEqual([]);
    h.setRunnerAbsent(false);
    expect((await h.post(body, { "x-delivery": "a-1" })).status).toBe(202);
  });

  test("a payload that cannot be written answers 503 and leaves no receipt", async () => {
    const h = await harness();
    // A file where the payloads directory should be makes mkdir/write fail.
    writeFileSync(join(h.tmp, "payloads"), "in the way");
    const res = await h.post(JSON.stringify({ p: 1 }));
    expect(res.status).toBe(503);
    expect(receiptCount(h.db)).toBe(0);
  });
});

describe("payload lifecycle", () => {
  test("an ephemeral payload is removed once the run finishes", async () => {
    const h = await harness();
    const res = await h.post(JSON.stringify({ c: 1 }));
    const { run_id } = (await res.json()) as { run_id: string };
    await waitFor(() => h.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(run_id)?.state === "succeeded");
    await waitFor(() => payloadFiles(h.tmp).length === 0);
  });

  test("keepPayload retains the payload and records its path", async () => {
    const h = await harness({ keepPayload: true });
    const res = await h.post(JSON.stringify({ k: 1 }));
    const { run_id, receipt_id } = (await res.json()) as { run_id: string; receipt_id: string };
    await waitFor(() => h.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(run_id)?.state === "succeeded");
    const row = h.db.query<{ payload_path: string }, [string]>("SELECT payload_path FROM webhook_deliveries WHERE receipt_id = ?").get(receipt_id)!;
    expect(row.payload_path).toBe(`payloads/${receipt_id}.payload`);
    expect(existsSync(join(h.tmp, row.payload_path))).toBe(true);
  });

  test("after a restart, stale unreferenced payload files are swept and referenced ones kept", async () => {
    const h = await harness({ keepPayload: true });
    const res = await h.post(JSON.stringify({ k: 1 }));
    const { run_id, receipt_id } = (await res.json()) as { run_id: string; receipt_id: string };
    await waitFor(() => h.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(run_id)?.state === "succeeded");

    const dir = join(h.tmp, "payloads");
    mkdirSync(join(dir, "ephemeral"), { recursive: true });
    const old = new Date(Date.now() - 60 * 60_000);
    const stale = [join(dir, "orphan-a.payload"), join(dir, "ephemeral", "orphan-b.payload")];
    for (const f of stale) { writeFileSync(f, "x"); utimesSync(f, old, old); }
    const fresh = join(dir, "fresh.payload"); // may belong to a request still being admitted
    writeFileSync(fresh, "x");

    // A new adapter instance is what a restart looks like: reconcile sweeps.
    const registry = new JobRegistry({ db: h.db });
    const again = new WebhookAdapter({ db: h.db, registry: () => registry, runner: () => null, secrets: h.secrets, dataDir: h.tmp });
    again.reconcile([]);
    for (const f of stale) expect(existsSync(f)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(dir, `${receipt_id}.payload`))).toBe(true);
  });
});
