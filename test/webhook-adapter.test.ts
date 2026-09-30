import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebhookAdapter } from "../supervisor/adapters/webhook.ts";
import type { Automation } from "../supervisor/config.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";
import { SecretStore } from "../supervisor/secrets.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

describe("WebhookAdapter", () => {
  test("verifies HMAC and deduplicates a delivery", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webhook-test-"));
    temps.push(tmp);
    const secretPath = join(tmp, "secrets.json");
    writeFileSync(secretPath, JSON.stringify({ version: 1, secrets: { hook: "test-secret" } }), { mode: 0o600 });
    chmodSync(secretPath, 0o600);
    const secrets = new SecretStore(secretPath); secrets.load();
    const db = new Database(join(tmp, "test.db")); await runMigrations(db);
    const job: Automation = {
      id: "hook-job", name: "hook-job", worker: "./test/fixtures/hello-worker.ts",
      triggers: [{ kind: "webhook", id: "inbound", path: "inbound", auth: { profile: "hmac-sha256", secretRef: "hook", signatureHeader: "x-signature", signaturePrefix: "sha256=" }, deliveryIdHeader: "x-delivery", contentTypes: ["application/json"], maxBodyBytes: 1024, keepPayload: false }],
      reentrancy: "drop", queueDepth: 1, timeoutMs: 5_000, killGraceMs: 100, enabled: true,
    };
    const registry = new JobRegistry({ db }); registry.reconcile([job]);
    const runner = new Runner({ db, registry, workspaceRoot: ROOT, dataDir: tmp, logsDir: join(tmp, "runs") });
    const adapter = new WebhookAdapter({ db, registry: () => registry, runner: () => runner, secrets, dataDir: tmp });
    adapter.reconcile(registry.webhookJobs());
    const body = JSON.stringify({ message: "hello" });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const makeRequest = () => new Request("http://localhost/hooks/inbound", { method: "POST", headers: { "content-type": "application/json", "x-signature": signature, "x-delivery": "delivery-1" }, body });
    const first = await adapter.handle("inbound", makeRequest());
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { run_id: string };
    expect(firstBody.run_id).toBeTruthy();
    const duplicate = await adapter.handle("inbound", makeRequest());
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM webhook_deliveries").get()!.n).toBe(1);
    await waitFor(() => db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(firstBody.run_id)?.state === "succeeded");
    db.close();
  });

  test("rejects an invalid signature without creating a receipt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webhook-test-")); temps.push(tmp);
    const secretPath = join(tmp, "secrets.json"); writeFileSync(secretPath, JSON.stringify({ version: 1, secrets: { hook: "test-secret" } }), { mode: 0o600 });
    const secrets = new SecretStore(secretPath); secrets.load();
    const db = new Database(join(tmp, "test.db")); await runMigrations(db);
    const job: Automation = { id: "hook-job", name: "hook-job", worker: "./test/fixtures/hello-worker.ts", triggers: [{ kind: "webhook", id: "inbound", path: "inbound", auth: { profile: "hmac-sha256", secretRef: "hook", signatureHeader: "x-signature", signaturePrefix: "sha256=" }, contentTypes: ["application/json"], maxBodyBytes: 1024, keepPayload: false }], reentrancy: "drop", queueDepth: 1, timeoutMs: 5_000, killGraceMs: 100, enabled: true };
    const registry = new JobRegistry({ db }); registry.reconcile([job]);
    const runner = new Runner({ db, registry, workspaceRoot: ROOT, dataDir: tmp, logsDir: join(tmp, "runs") });
    const adapter = new WebhookAdapter({ db, registry: () => registry, runner: () => runner, secrets, dataDir: tmp }); adapter.reconcile(registry.webhookJobs());
    const res = await adapter.handle("inbound", new Request("http://localhost/hooks/inbound", { method: "POST", headers: { "content-type": "application/json", "x-signature": "bad" }, body: "{}" }));
    expect(res.status).toBe(401);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM webhook_deliveries").get()!.n).toBe(0);
    db.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for webhook run");
}
