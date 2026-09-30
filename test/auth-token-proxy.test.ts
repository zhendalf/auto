import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthState, buildHostPolicy, proxiedLoopbackRequest, writeTokenFile } from "../supervisor/auth.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { startServer, type ServerHandle } from "../supervisor/server.ts";

// Regression tests: the proxy safety net matches whole header families, a token
// file replaced or deleted on disk takes effect at once, and /hooks/* answers a
// retryable 503 (not 404) while the supervisor has no runtime yet.

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);

const temps: string[] = [];
const servers: ServerHandle[] = [];
const dbs: Database[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
  while (dbs.length) { try { dbs.pop()!.close(); } catch {} }
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "auth-token-proxy-"));
  temps.push(d);
  return d;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function boot(extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const dir = tmp();
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>t</title></head><body>shell</body></html>");
  const tokenPath = join(dir, ".token");
  const db = new Database(join(dir, "t.db"));
  dbs.push(db);
  await runMigrations(db);
  const server = await startServer({
    db,
    registry: () => null,
    cronAdapter: () => null,
    runner: () => null,
    configStore: () => null,
    port: 0,
    uiDistDir: dist,
    tokenPath,
    dataDir: dir,
    heartbeatMs: 60_000,
    ...extra,
  });
  servers.push(server);
  return { dir, tokenPath, server, base: `http://127.0.0.1:${server.port}` };
}

describe("proxy headers: whole families, not a short list", () => {
  const policy = buildHostPolicy(7777);
  const names = [
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-forwarded-server",
    "x-forwarded-prefix", "x-real-ip", "x-real-port", "true-client-ip", "cf-connecting-ip", "cf-ray",
    "cf-visitor", "cf-ipcountry", "cdn-loop", "client-ip", "x-client-ip", "fastly-client-ip",
    "x-original-forwarded-for", "tailscale-user-login", "tailscale-user-name", "ngrok-skip-browser-warning",
    "x-envoy-external-address", "x-envoy-internal", "forwarded", "via",
  ];

  for (const name of names) {
    test(`${name} makes a built-in loopback Host a proxied request`, () => {
      const req = new Request("http://127.0.0.1:7777/", { headers: { host: "127.0.0.1:7777", [name]: "x" } });
      expect(proxiedLoopbackRequest(req, policy)).toBe(true);
    });
  }

  test("ordinary browser and curl headers are not mistaken for a proxy", () => {
    const req = new Request("http://127.0.0.1:7777/", {
      headers: {
        host: "127.0.0.1:7777", accept: "text/html", "user-agent": "curl/8", origin: "http://127.0.0.1:7777",
        "sec-fetch-site": "same-origin", "accept-language": "en", authorization: "Bearer x", "content-type": "application/json",
        "x-requested-with": "fetch", "cache-control": "no-cache",
      },
    });
    expect(proxiedLoopbackRequest(req, policy)).toBe(false);
  });

  test("a listed AUTO_ALLOWED_HOSTS name may be proxied", () => {
    const p = buildHostPolicy(7777, ["dash.example.test"]);
    const req = new Request("http://dash.example.test/", { headers: { host: "dash.example.test", "x-forwarded-proto": "https" } });
    expect(proxiedLoopbackRequest(req, p)).toBe(false);
  });

  test("the live server refuses the token page to X-Forwarded-Proto and Cf-Ray, and never leaks the token", async () => {
    const b = await boot();
    for (const h of ["x-forwarded-proto", "x-forwarded-port", "cf-ray", "cdn-loop", "tailscale-user-login", "x-client-ip"]) {
      const res = await fetch(`${b.base}/`, { headers: { [h]: "1" } });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toContain("proxied_request");
      expect(text).not.toContain(b.server.token);
    }
    const plain = await fetch(`${b.base}/`);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain(b.server.token);
  });
});

describe("a token file changed on disk takes effect", () => {
  test("AuthState follows a replaced file: the old token stops working, the new one starts", () => {
    const dir = tmp();
    const path = join(dir, ".token");
    writeTokenFile(path, TOKEN_A);
    let changes = 0;
    const auth = new AuthState(TOKEN_A, { tokenPath: path, onChange: () => { changes++; } });
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_A) }))).toBe(true);

    writeTokenFile(path, TOKEN_B);
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_A) }))).toBe(false);
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_B) }))).toBe(true);
    expect(auth.token).toBe(TOKEN_B);
    expect(changes).toBe(1);
  });

  test("a deleted file is treated as a revocation: a fresh token is minted and written back", () => {
    const dir = tmp();
    const path = join(dir, ".token");
    writeTokenFile(path, TOKEN_A);
    const auth = new AuthState(TOKEN_A, { tokenPath: path });
    rmSync(path);
    const fresh = auth.token;
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(TOKEN_A);
    expect(readFileSync(path, "utf8").trim()).toBe(fresh);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_A) }))).toBe(false);
  });

  test("a file that holds no valid token is ignored: the current token stays, and a later good write is adopted", async () => {
    const dir = tmp();
    const path = join(dir, ".token");
    writeTokenFile(path, TOKEN_A);
    const auth = new AuthState(TOKEN_A, { tokenPath: path });
    await Bun.sleep(5);
    writeFileSync(path, "", { mode: 0o600 }); // what `echo > .token` shows for an instant
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_A) }))).toBe(true);
    await Bun.sleep(5);
    writeFileSync(path, TOKEN_C + "\n", { mode: 0o600 });
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_C) }))).toBe(true);
    expect(auth.authenticate(new Request("http://x/", { headers: bearer(TOKEN_A) }))).toBe(false);
  });

  test("a loosely permissioned replacement is tightened to 0600", () => {
    const dir = tmp();
    const path = join(dir, ".token");
    writeTokenFile(path, TOKEN_A);
    const auth = new AuthState(TOKEN_A, { tokenPath: path });
    writeFileSync(path, TOKEN_B + "\n", { mode: 0o644 });
    expect(auth.token).toBe(TOKEN_B);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("setToken (rotation) records the file it just wrote and does not count as an outside change", () => {
    const dir = tmp();
    const path = join(dir, ".token");
    writeTokenFile(path, TOKEN_A);
    let changes = 0;
    const auth = new AuthState(TOKEN_A, { tokenPath: path, onChange: () => { changes++; } });
    writeTokenFile(path, TOKEN_B);
    auth.setToken(TOKEN_B);
    expect(auth.token).toBe(TOKEN_B);
    expect(changes).toBe(0);
  });

  test("the live server: replacing .token revokes the old bearer, embeds the new token in /, and drops open event streams", async () => {
    const b = await boot();
    const oldToken = b.server.token;
    const stream = await fetch(`${b.base}/events`, { headers: bearer(oldToken) });
    expect(stream.status).toBe(200);
    expect((await fetch(`${b.base}/api/config/status`, { headers: bearer(oldToken) })).status).toBe(200);

    writeTokenFile(b.tokenPath, TOKEN_B);

    expect((await fetch(`${b.base}/api/config/status`, { headers: bearer(oldToken) })).status).toBe(401);
    expect((await fetch(`${b.base}/api/config/status`, { headers: bearer(TOKEN_B) })).status).toBe(200);
    const page = await (await fetch(`${b.base}/`)).text();
    expect(page).toContain(TOKEN_B);
    expect(page).not.toContain(oldToken);
    // The stream opened with the old token ends.
    const reader = stream.body!.getReader();
    const ended = await Promise.race([
      (async () => { for (;;) { const r = await reader.read(); if (r.done) return true; } })(),
      Bun.sleep(3_000).then(() => false),
    ]);
    expect(ended).toBe(true);
  });
});

describe("/hooks/* while there is no webhook adapter yet", () => {
  test("a provider that returns null (degraded cold start) answers a retryable 503, never 404", async () => {
    const b = await boot({ webhookAdapter: () => null });
    const res = await fetch(`${b.base}/hooks/in`, { method: "POST", body: "{}", headers: { "x-sig": "sha256=00" } });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "supervisor_degraded" });
    // Any path, any method: the answer does not depend on which routes exist.
    expect((await fetch(`${b.base}/hooks/other`)).status).toBe(503);
  });

  test("a server that was never given a webhook provider still answers 404", async () => {
    const b = await boot();
    expect((await fetch(`${b.base}/hooks/in`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

test("the token file helper used by these tests writes 0600", () => {
  const dir = tmp();
  const path = join(dir, ".token");
  writeTokenFile(path, TOKEN_A);
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
