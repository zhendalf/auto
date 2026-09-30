import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../supervisor/db/migrate.ts";
import { startServer, type ServerHandle } from "../supervisor/server.ts";
import {
  AuthState,
  buildHostPolicy,
  extractApiToken,
  hostAllowed,
  loadOrCreateToken,
  originAllowed,
  parseAllowedHosts,
  proxiedLoopbackRequest,
  rotateTokenFile,
  writeTokenFile,
} from "../supervisor/auth.ts";

// ---------------------------------------------------------------------------
// Unit: AuthState, host policy, token file
// ---------------------------------------------------------------------------

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function req(headers: Record<string, string> = {}, url = "http://127.0.0.1:1/x"): Request {
  return new Request(url, { headers });
}

describe("AuthState.authenticate", () => {
  const auth = new AuthState(TOKEN_A);

  test("only Authorization: Bearer <token> is accepted", () => {
    expect(auth.authenticate(req({ authorization: `Bearer ${TOKEN_A}` }))).toBe(true);
    expect(auth.authenticate(req({ authorization: `bearer   ${TOKEN_A}` }))).toBe(true);
  });

  test("nothing, a wrong token, and every other credential shape are rejected", () => {
    expect(auth.authenticate(req())).toBe(false);
    expect(auth.authenticate(req({ authorization: `Bearer ${TOKEN_B}` }))).toBe(false);
    expect(auth.authenticate(req({ authorization: TOKEN_A }))).toBe(false); // not a Bearer credential
    expect(auth.authenticate(req({ authorization: `Basic ${TOKEN_A}` }))).toBe(false);
    expect(auth.authenticate(req({ "x-auto-token": TOKEN_A }))).toBe(false);
    expect(auth.authenticate(req({ cookie: `auto_session=${TOKEN_A}; token=${TOKEN_A}` }))).toBe(false);
    expect(auth.authenticate(new Request(`http://127.0.0.1:1/api/jobs?token=${TOKEN_A}`))).toBe(false);
  });

  test("setToken swaps the credential", () => {
    const a = new AuthState(TOKEN_A);
    a.setToken(TOKEN_B);
    expect(a.token).toBe(TOKEN_B);
    expect(a.authenticate(req({ authorization: `Bearer ${TOKEN_A}` }))).toBe(false);
    expect(a.authenticate(req({ authorization: `Bearer ${TOKEN_B}` }))).toBe(true);
  });

  test("extractApiToken reads only the Authorization header", () => {
    expect(extractApiToken(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractApiToken(req({ "x-auto-token": "abc" }))).toBeNull();
    expect(extractApiToken(req())).toBeNull();
  });
});

describe("host policy", () => {
  test("default hosts are the loopback names and auto.localhost on the bound port", () => {
    const p = buildHostPolicy(7777);
    // No [::1]: the server listens on 127.0.0.1 only, so that name could never work.
    expect([...p.hosts].sort()).toEqual(["127.0.0.1:7777", "auto.localhost:7777", "localhost:7777"]);
    expect(p.origins.has("http://localhost:7777")).toBe(true);
    expect(p.origins.has("http://auto.localhost:7777")).toBe(true);
    expect(p.hosts.has("automations.localhost")).toBe(false);
    expect(p.hosts.has("auto.localhost")).toBe(false); // the port is part of the name
  });

  test("Host is required and matched exactly (case-insensitive)", () => {
    const p = buildHostPolicy(7777);
    expect(hostAllowed(req({ host: "127.0.0.1:7777" }), p)).toBe(true);
    expect(hostAllowed(req({ host: "LOCALHOST:7777" }), p)).toBe(true);
    expect(hostAllowed(req({ host: "localhost:5173" }), p)).toBe(false);
    expect(hostAllowed(req({ host: "localhost" }), p)).toBe(false);
    expect(hostAllowed(req({ host: "evil.example" }), p)).toBe(false);
    expect(hostAllowed(new Request("http://127.0.0.1:7777/"), p)).toBe(false); // no Host header set
  });

  test("Origin: optional when absent, must match when present", () => {
    const p = buildHostPolicy(7777);
    expect(originAllowed(req(), p)).toBe(true);
    expect(originAllowed(req({ origin: "http://127.0.0.1:7777" }), p)).toBe(true);
    expect(originAllowed(req({ origin: "http://auto.localhost:7777" }), p)).toBe(true);
    expect(originAllowed(req({ origin: "http://evil.example" }), p)).toBe(false);
    expect(originAllowed(req({ origin: "http://localhost:5173" }), p)).toBe(false);
    expect(originAllowed(req({ origin: "null" }), p)).toBe(false);
  });

  test("proxied requests are refused on the built-in names only", () => {
    const p = buildHostPolicy(7777, ["auto.example.test"]);
    for (const h of ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip", "via"]) {
      expect(proxiedLoopbackRequest(req({ host: "127.0.0.1:7777", [h]: "1.2.3.4" }), p)).toBe(true);
      expect(proxiedLoopbackRequest(req({ host: "auto.localhost:7777", [h]: "1.2.3.4" }), p)).toBe(true);
      // An operator-listed host is expected to sit behind a proxy.
      expect(proxiedLoopbackRequest(req({ host: "auto.example.test", [h]: "1.2.3.4" }), p)).toBe(false);
    }
    expect(proxiedLoopbackRequest(req({ host: "127.0.0.1:7777" }), p)).toBe(false);
  });

  test("AUTO_ALLOWED_HOSTS entries extend the policy", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts(" Auto.Example.test , box.lan:8443 ,, ")).toEqual([
      "auto.example.test",
      "box.lan:8443",
    ]);
    // Anything that is not host[:port] is dropped, not half-honoured.
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write; // the warnings are expected
    try {
      expect(parseAllowedHosts("http://x.test,a b,ok.test,*.evil.test,x.test/path")).toEqual(["ok.test"]);
    } finally {
      process.stderr.write = orig;
    }
    const p = buildHostPolicy(7777, ["auto.example.test"]);
    expect(p.hosts.has("auto.example.test")).toBe(true);
    expect(p.origins.has("http://auto.example.test")).toBe(true);
    expect(p.origins.has("https://auto.example.test")).toBe(true);
  });
});

describe("token file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-token-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mode = (p: string) => statSync(p).mode & 0o777;

  test("created with mode 0600", () => {
    const path = join(dir, ".token");
    const t = loadOrCreateToken({ tokenPath: path });
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(path)).toBe(0o600);
    expect(loadOrCreateToken({ tokenPath: path })).toBe(t);
  });

  test("an existing token file with loose permissions is tightened, not replaced", () => {
    const path = join(dir, ".token");
    writeFileSync(path, TOKEN_A + "\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let t: string;
    try {
      t = loadOrCreateToken({ tokenPath: path });
    } finally {
      process.stderr.write = orig;
    }
    expect(t).toBe(TOKEN_A);
    expect(mode(path)).toBe(0o600);
    expect(stderr.join("")).toContain("tightened to 600");
  });

  test("a stale loose .token.tmp does not leak its mode into the new token", () => {
    const path = join(dir, ".token");
    writeFileSync(path + ".tmp", "old junk", { mode: 0o666 });
    chmodSync(path + ".tmp", 0o666);
    writeTokenFile(path, TOKEN_B);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(TOKEN_B + "\n");
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("a planted symlink at .token.tmp is not written through", () => {
    const path = join(dir, ".token");
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path + ".tmp");
    writeTokenFile(path, TOKEN_B);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(readFileSync(path, "utf8")).toBe(TOKEN_B + "\n");
  });

  test("a malformed token file is replaced", () => {
    const path = join(dir, ".token");
    writeFileSync(path, "not a token\n", { mode: 0o600 });
    expect(loadOrCreateToken({ tokenPath: path })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rotateTokenFile writes a new 0600 token", () => {
    const path = join(dir, ".token");
    const first = loadOrCreateToken({ tokenPath: path });
    const next = rotateTokenFile(path);
    expect(next).not.toBe(first);
    expect(readFileSync(path, "utf8").trim()).toBe(next);
    expect(mode(path)).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Integration: HTTP surface
// ---------------------------------------------------------------------------

type Boot = {
  tmp: string;
  dist: string;
  outside: string;
  tokenPath: string;
  db: Database;
  server: ServerHandle;
  port: number;
  base: string;
};

let boot: Boot | null = null;

async function start(extra: Partial<Parameters<typeof startServer>[0]> = {}): Promise<Boot> {
  const tmp = mkdtempSync(join(tmpdir(), "auth-server-"));
  const dist = join(tmp, "dist");
  const outside = join(tmp, "outside");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dist, "index.html"), `<!doctype html><html><head><title>t</title></head><body>shell</body></html>`);
  writeFileSync(join(dist, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg"/>`);
  writeFileSync(join(dist, "logo..v2.svg"), `<svg xmlns="http://www.w3.org/2000/svg"/>`);
  writeFileSync(join(dist, "assets", "app.js"), `console.log(1)`);
  writeFileSync(join(outside, "secret.txt"), "top secret");
  symlinkSync(join(outside, "secret.txt"), join(dist, "leak.svg"));
  symlinkSync(join(outside, "secret.txt"), join(dist, "assets", "leak.js"));
  symlinkSync(outside, join(dist, "assets", "linkdir"));

  const tokenPath = join(tmp, ".token");
  const db = new Database(join(tmp, "test.db"));
  db.run("PRAGMA foreign_keys = ON;");
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
    dataDir: tmp,
    heartbeatMs: 60_000,
    ...extra,
  });
  boot = { tmp, dist, outside, tokenPath, db, server, port: server.port, base: `http://127.0.0.1:${server.port}` };
  return boot;
}

afterEach(async () => {
  if (!boot) return;
  try {
    await boot.server.stop();
  } catch {
    /* ignore */
  }
  try {
    boot.db.close();
  } catch {
    /* ignore */
  }
  rmSync(boot.tmp, { recursive: true, force: true });
  boot = null;
});

const bearer = (b: Boot) => ({ authorization: `Bearer ${b.server.token}` });

/** Send raw bytes (for requests fetch will not let us build) and return the full response text. */
async function raw(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve) => {
    let out = "";
    const timer = setTimeout(() => resolve(out), 2_000);
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          s.write(request);
        },
        data(_s, d) {
          out += new TextDecoder().decode(d);
        },
        close() {
          clearTimeout(timer);
          resolve(out);
        },
        error() {
          clearTimeout(timer);
          resolve(out);
        },
      },
    });
  });
}

/** Every Set-Cookie any of these routes could emit: there must be none. */
async function expectNoCookie(b: Boot): Promise<void> {
  const responses = await Promise.all([
    fetch(`${b.base}/`),
    fetch(`${b.base}/jobs/x`),
    fetch(`${b.base}/api/jobs`, { headers: bearer(b) }),
    fetch(`${b.base}/api/jobs`),
    fetch(`${b.base}/api/token/rotate`, { method: "POST", headers: bearer(b) }),
    fetch(`${b.base}/healthz`),
    fetch(`${b.base}/favicon.svg`),
    fetch(`${b.base}/auth/exchange?code=x`, { redirect: "manual" }),
    fetch(`${b.base}/`, { headers: { host: "evil.example" } }),
  ]);
  for (const r of responses) expect(r.headers.get("set-cookie")).toBeNull();
}

const BOOTSTRAP_RE = /<script id="auto-bootstrap" type="application\/json">(.*?)<\/script>/s;

function bootstrapOf(html: string): { token: string; port: number } {
  const m = BOOTSTRAP_RE.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!);
}

describe("the dashboard page", () => {
  test("GET / and SPA fallback paths embed the token and the bound port for an allowed Host", async () => {
    const b = await start();
    for (const path of ["/", "/jobs/hello", "/runs/abc", "/index.html"]) {
      const res = await fetch(`${b.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const boot = bootstrapOf(await res.text());
      expect(boot.token).toBe(b.server.token);
      expect(boot.port).toBe(b.port); // the bound port, not the requested 0
    }
  });

  test("the bootstrap block keeps the exact shape the UI reads", async () => {
    const b = await start();
    const text = await (await fetch(`${b.base}/`)).text();
    expect(text).toContain(
      `<script id="auto-bootstrap" type="application/json">{"token":"${b.server.token}","port":${b.port}}</script>`,
    );
    // Inside <head>, so it is present before the module script runs.
    expect(text.indexOf("auto-bootstrap")).toBeLessThan(text.indexOf("</head>"));
  });

  test("the placeholder page (UI not built) embeds the token too", async () => {
    const b = await start({ uiDistDir: join(tmpdir(), `auth-no-dist-${process.pid}-${Date.now()}`) });
    const boot = bootstrapOf(await (await fetch(`${b.base}/`)).text());
    expect(boot.token).toBe(b.server.token);
  });

  test("the page is never cached and no cookie is ever set", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectNoCookie(b);
  });

  test("HEAD / carries no body", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("the friendly name works: auto.localhost:<port> gets the page and a matching Origin passes", async () => {
    const b = await start();
    const host = `auto.localhost:${b.port}`;
    const page = await fetch(`${b.base}/`, { headers: { host } });
    expect(page.status).toBe(200);
    expect(bootstrapOf(await page.text()).token).toBe(b.server.token);
    const api = await fetch(`${b.base}/api/config/status`, { headers: { host, origin: `http://${host}`, ...bearer(b) } });
    expect(api.status).toBe(200);
    const post = await fetch(`${b.base}/api/config/reload`, {
      method: "POST",
      headers: { host, origin: `http://${host}`, ...bearer(b) },
    });
    expect(post.status).toBe(503); // admitted; the fixture has no config store
    // The bare name without the bound port is not the same origin.
    expect((await fetch(`${b.base}/`, { headers: { host: "auto.localhost" } })).status).toBe(403);
  });

  test("a request that arrived through a proxy or tunnel never gets the token", async () => {
    const b = await start();
    for (const h of ["x-forwarded-for", "cf-connecting-ip", "forwarded", "x-forwarded-host"]) {
      const res = await fetch(`${b.base}/`, { headers: { [h]: "203.0.113.9" } });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toContain("proxied_request");
      expect(text).not.toContain(b.server.token);
      expect((await fetch(`${b.base}/api/jobs`, { headers: { ...bearer(b), [h]: "203.0.113.9" } })).status).toBe(403);
    }
  });
});

describe("Host validation", () => {
  test("wrong Host is rejected on / and /api and /events, with or without a token", async () => {
    const b = await start();
    for (const path of ["/", "/jobs/x", "/api/config/status", "/events", "/assets/app.js", "/favicon.svg"]) {
      const res = await fetch(`${b.base}${path}`, { headers: { host: "evil.example", ...bearer(b) } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error).toBe("bad_host");
    }
  });

  test("a DNS-rebinding style Host with the right port is still rejected", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/`, { headers: { host: `attacker.example:${b.port}` } });
    expect(res.status).toBe(403);
  });

  test("a request with no Host header at all is rejected", async () => {
    const b = await start();
    const res = await raw(b.port, "GET / HTTP/1.0\r\n\r\n");
    expect(res).toContain(" 403 ");
    expect(res).toContain("bad_host");
    const api = await raw(b.port, `GET /api/config/status HTTP/1.0\r\nAuthorization: Bearer ${b.server.token}\r\n\r\n`);
    expect(api).toContain(" 403 ");
    const events = await raw(b.port, `GET /events HTTP/1.0\r\nAuthorization: Bearer ${b.server.token}\r\n\r\n`);
    expect(events).toContain(" 403 ");
    // None of them leaked the token, and an empty Host header is no better than a missing one.
    for (const r of [res, api, events]) expect(r).not.toContain(b.server.token);
    const empty = await raw(b.port, "GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n");
    expect(empty).toContain(" 403 ");
    expect(empty).not.toContain(b.server.token);
  });

  test("/healthz and /hooks/* are exempt from the Host check", async () => {
    const b = await start();
    const h = await fetch(`${b.base}/healthz`, { headers: { host: "tunnel.example" } });
    expect([200, 503]).toContain(h.status);
    const hook = await fetch(`${b.base}/hooks/x`, { method: "POST", headers: { host: "tunnel.example" } });
    expect(hook.status).toBe(404);
    expect(((await hook.json()) as any).error).toBe("not_found");
  });

  test("a wrong Host never receives the page or the token", async () => {
    const b = await start();
    for (const host of ["evil.example", `evil.example:${b.port}`, "auto.localhost", "automations.localhost", ""]) {
      const res = await fetch(`${b.base}/`, { headers: { host } });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(b.server.token);
    }
  });

  test("AUTO_ALLOWED_HOSTS env admits extra exact hosts, and only those", async () => {
    const prev = process.env.AUTO_ALLOWED_HOSTS;
    process.env.AUTO_ALLOWED_HOSTS = "auto.example.test, other.example.test:8443";
    const origWrite = process.stderr.write.bind(process.stderr);
    const logged: string[] = [];
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => (logged.push(String(chunk)), true)) as typeof process.stderr.write;
      const b = await start();
      process.stderr.write = origWrite;
      // Listing a host is a trust decision, and the server says so at startup.
      expect(logged.join("")).toContain("gets the API token from /");
      const ok = await fetch(`${b.base}/api/config/status`, { headers: { host: "auto.example.test", ...bearer(b) } });
      expect(ok.status).toBe(200);
      // The listed name also gets the dashboard page (and so the token).
      const page = await fetch(`${b.base}/`, { headers: { host: "auto.example.test" } });
      expect(page.status).toBe(200);
      expect(bootstrapOf(await page.text()).token).toBe(b.server.token);
      // A proxy in front of a listed name is expected to add forwarding headers.
      const proxied = await fetch(`${b.base}/api/config/status`, {
        headers: { host: "auto.example.test", "x-forwarded-for": "203.0.113.9", ...bearer(b) },
      });
      expect(proxied.status).toBe(200);
      const ok2 = await fetch(`${b.base}/api/config/status`, {
        headers: { host: "other.example.test:8443", ...bearer(b) },
      });
      expect(ok2.status).toBe(200);
      const no = await fetch(`${b.base}/api/config/status`, { headers: { host: "other.example.test", ...bearer(b) } });
      expect(no.status).toBe(403);
      // A tunnel terminating TLS in front sends an https Origin for the same name.
      const post = await fetch(`${b.base}/api/config/reload`, {
        method: "POST",
        headers: { host: "auto.example.test", origin: "https://auto.example.test", ...bearer(b) },
      });
      expect(post.status).toBe(503); // authenticated and admitted; no config store in this fixture
    } finally {
      process.stderr.write = origWrite;
      if (prev === undefined) delete process.env.AUTO_ALLOWED_HOSTS;
      else process.env.AUTO_ALLOWED_HOSTS = prev;
    }
  });

  test("without the env var the built-in loopback hosts are the whole allowlist", async () => {
    const prev = process.env.AUTO_ALLOWED_HOSTS;
    delete process.env.AUTO_ALLOWED_HOSTS;
    try {
      const b = await start();
      for (const host of [`localhost:${b.port}`, `127.0.0.1:${b.port}`]) {
        const res = await fetch(`${b.base}/api/config/status`, { headers: { host, ...bearer(b) } });
        expect(res.status).toBe(200);
      }
      const res = await fetch(`${b.base}/api/config/status`, { headers: { host: "automations.localhost", ...bearer(b) } });
      expect(res.status).toBe(403);
      const friendly = await fetch(`${b.base}/api/config/status`, { headers: { host: `auto.localhost:${b.port}`, ...bearer(b) } });
      expect(friendly.status).toBe(200);
    } finally {
      if (prev !== undefined) process.env.AUTO_ALLOWED_HOSTS = prev;
    }
  });
});

describe("authentication", () => {
  test("/api without credentials -> 401", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/api/config/status`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("unauthorized");
  });

  test("/events without credentials -> 401, and the ?token= query does not work", async () => {
    const b = await start();
    expect((await fetch(`${b.base}/events`)).status).toBe(401);
    const res = await fetch(`${b.base}/events?token=${b.server.token}`);
    expect(res.status).toBe(401);
  });

  test("/events with the bearer header streams", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/events`, { headers: bearer(b) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    await reader.cancel();
  });

  test("the token is accepted from the Authorization header only", async () => {
    const b = await start();
    const t = b.server.token;
    for (const path of ["/api/config/status", "/events"]) {
      expect((await fetch(`${b.base}${path}`, { headers: { "x-auto-token": t } })).status).toBe(401);
      expect((await fetch(`${b.base}${path}`, { headers: { cookie: `token=${t}; auto_session=${t}` } })).status).toBe(401);
      expect((await fetch(`${b.base}${path}?token=${t}`)).status).toBe(401);
      expect((await fetch(`${b.base}${path}`, { headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status).toBe(401);
    }
  });

  test("a wrong Origin is rejected for GET and for POST, even with a valid token", async () => {
    const b = await start();
    for (const origin of ["http://evil.example", "null", "http://localhost:1", `https://127.0.0.1:${b.port}`]) {
      const get = await fetch(`${b.base}/api/config/status`, { headers: { ...bearer(b), origin } });
      expect(get.status).toBe(403);
      expect(((await get.json()) as any).error).toBe("bad_origin");
      const post = await fetch(`${b.base}/api/config/reload`, { method: "POST", headers: { ...bearer(b), origin } });
      expect(post.status).toBe(403);
      const sse = await fetch(`${b.base}/events`, { headers: { ...bearer(b), origin } });
      expect(sse.status).toBe(403);
      const page = await fetch(`${b.base}/`, { headers: { origin } });
      expect(page.status).toBe(403);
      expect(await page.text()).not.toContain(b.server.token);
    }
  });

  test("a matching Origin passes; an absent Origin (CLI, curl) passes", async () => {
    const b = await start();
    for (const origin of [b.base, `http://localhost:${b.port}`, `http://auto.localhost:${b.port}`]) {
      const get = await fetch(`${b.base}/api/config/status`, { headers: { ...bearer(b), origin } });
      expect(get.status).toBe(200);
      const post = await fetch(`${b.base}/api/config/reload`, { method: "POST", headers: { ...bearer(b), origin } });
      expect(post.status).toBe(503); // admitted; the fixture has no config store
    }
    const noOrigin = await fetch(`${b.base}/api/config/reload`, { method: "POST", headers: bearer(b) });
    expect(noOrigin.status).toBe(503);
  });

  test("no response sets a cookie, and the removed sign-in routes are gone", async () => {
    const b = await start();
    await expectNoCookie(b);
    expect((await fetch(`${b.base}/api/ui-session`, { method: "POST", headers: bearer(b) })).status).toBe(404);
    const ex = await fetch(`${b.base}/auth/exchange?code=${"0".repeat(48)}`, { redirect: "manual" });
    expect(ex.status).toBe(200); // just another SPA path now
    expect(ex.headers.get("set-cookie")).toBeNull();
    expect(ex.headers.get("location")).toBeNull();
  });
});

describe("token rotation", () => {
  test("/ embeds the new token, the old bearer gets 401, the new file token works", async () => {
    const b = await start();
    const oldToken = b.server.token;
    expect(bootstrapOf(await (await fetch(`${b.base}/`)).text()).token).toBe(oldToken);

    const res = await fetch(`${b.base}/api/token/rotate`, { method: "POST", headers: bearer(b) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toContain("reload");
    expect(body.message).toContain("data/.token");
    expect(body.message).not.toContain("auto ui");
    // The response never carries the new token, nor any absolute path.
    const fileToken = readFileSync(b.tokenPath, "utf8").trim();
    expect(JSON.stringify(body)).not.toContain(fileToken);
    expect(JSON.stringify(body)).not.toContain(b.tmp);

    expect(fileToken).toMatch(/^[0-9a-f]{64}$/);
    expect(fileToken).not.toBe(oldToken);
    expect(statSync(b.tokenPath).mode & 0o777).toBe(0o600);
    expect(b.server.token).toBe(fileToken);

    expect((await fetch(`${b.base}/api/config/status`, { headers: { authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    expect((await fetch(`${b.base}/events`, { headers: { authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    expect((await fetch(`${b.base}/api/config/status`, { headers: { authorization: `Bearer ${fileToken}` } })).status).toBe(200);

    // A dashboard reload recovers: the page now carries the new token, and only that.
    const page = await (await fetch(`${b.base}/`)).text();
    expect(bootstrapOf(page).token).toBe(fileToken);
    expect(page).not.toContain(oldToken);
    expect((await fetch(`${b.base}/api/config/status`, { headers: { authorization: `Bearer ${bootstrapOf(page).token}` } })).status).toBe(200);
  });

  test("the token survives a supervisor restart (same file, same token in the page)", async () => {
    const b = await start();
    const before = b.server.token;
    await b.server.stop();
    const again = await startServer({
      db: b.db,
      registry: () => null,
      cronAdapter: () => null,
      runner: () => null,
      configStore: () => null,
      port: 0,
      uiDistDir: b.dist,
      tokenPath: b.tokenPath,
      dataDir: b.tmp,
      heartbeatMs: 60_000,
    });
    try {
      expect(again.token).toBe(before);
      const text = await (await fetch(`http://127.0.0.1:${again.port}/`)).text();
      expect(bootstrapOf(text).token).toBe(before);
    } finally {
      await again.stop();
    }
  });

  test("open event streams are closed by a rotation", async () => {
    const b = await start();
    const sse = await fetch(`${b.base}/events`, { headers: bearer(b) });
    const reader = sse.body!.getReader();
    await reader.read(); // ": connected"
    expect(b.server.subscriberCount()).toBe(1);
    await fetch(`${b.base}/api/token/rotate`, { method: "POST", headers: bearer(b) });
    const next = await reader.read();
    expect(next.done).toBe(true);
    expect(b.server.subscriberCount()).toBe(0);
  });

  test("needs credentials and POST", async () => {
    const b = await start();
    expect((await fetch(`${b.base}/api/token/rotate`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${b.base}/api/token/rotate`, { headers: bearer(b) })).status).toBe(405);
    expect(readFileSync(b.tokenPath, "utf8").trim()).toBe(b.server.token);
  });

  test("a foreign Origin cannot rotate the token", async () => {
    const b = await start();
    const before = b.server.token;
    const res = await fetch(`${b.base}/api/token/rotate`, {
      method: "POST",
      headers: { ...bearer(b), origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(b.server.token).toBe(before);
  });
});

describe("response hardening", () => {
  const expectHardened = (res: Response) => {
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const part of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  };

  test("every kind of response carries the security headers", async () => {
    const b = await start();
    const responses = await Promise.all([
      fetch(`${b.base}/`),
      fetch(`${b.base}/healthz`),
      fetch(`${b.base}/api/config/status`),
      fetch(`${b.base}/api/config/status`, { headers: bearer(b) }),
      fetch(`${b.base}/api/nope`, { headers: bearer(b) }),
      fetch(`${b.base}/assets/app.js`),
      fetch(`${b.base}/assets/missing.js`),
      fetch(`${b.base}/favicon.svg`),
      fetch(`${b.base}/favicon.ico`),
      fetch(`${b.base}/hooks/x`, { method: "POST" }),
      fetch(`${b.base}/auth/exchange?code=x`, { redirect: "manual" }),
      fetch(`${b.base}/`, { headers: { host: "evil.example" } }),
      fetch(`${b.base}/`, { headers: { origin: "http://evil.example" } }),
      fetch(`${b.base}/events`, { headers: bearer(b) }),
    ]);
    for (const r of responses) expectHardened(r);
    await responses[responses.length - 1]!.body?.cancel();
  });

  test("the token page can be neither framed nor read cross-origin", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/`);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // No CORS grant of any kind: a foreign page cannot read the response.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // The inline block is a JSON data block, so it needs no script-src allowance.
    expect(await res.text()).toContain('type="application/json"');
    // A CORS preflight from a foreign origin is refused, not answered.
    const pre = await fetch(`${b.base}/api/jobs`, {
      method: "OPTIONS",
      headers: { origin: "http://evil.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("API and SPA shell are no-store; hashed assets stay immutable", async () => {
    const b = await start();
    expect((await fetch(`${b.base}/`)).headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${b.base}/api/config/status`, { headers: bearer(b) })).headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${b.base}/api/config/status`)).headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${b.base}/healthz`)).headers.get("cache-control")).toBe("no-store");
    const asset = await fetch(`${b.base}/assets/app.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("/healthz exposes only {ok, degraded}", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["degraded", "ok"]);
    expect(body.ok).toBe(true);
    expect(body.degraded).toBe(false);
    expect(res.status).toBe(200);
  });
});

describe("static files", () => {
  test("serves root-level files in dist with the right type", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/svg+xml");
    expect(await res.text()).toContain("<svg");
    const head = await fetch(`${b.base}/favicon.svg`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("legitimate names containing '..' are served", async () => {
    const b = await start();
    expect((await fetch(`${b.base}/logo..v2.svg`)).status).toBe(200);
  });

  test("a missing file with an extension is a 404, not the SPA shell", async () => {
    const b = await start();
    for (const path of ["/favicon.ico", "/robots.txt", "/missing.png", "/manifest.webmanifest", "/assets/nope.css"]) {
      const res = await fetch(`${b.base}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    }
  });

  test("/api never falls back to the SPA shell", async () => {
    const b = await start();
    const api = await fetch(`${b.base}/api`, { headers: bearer(b) });
    expect(api.status).toBe(404);
    expect(((await api.json()) as any).error).toBe("not_found");
    expect((await fetch(`${b.base}/api`)).status).toBe(401);
    const unknown = await fetch(`${b.base}/api/nope`, { headers: bearer(b) });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  test("extension-less routes still fall back to the SPA shell", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/runs/0190f1a2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("symlinks that escape the dist root are refused", async () => {
    const b = await start();
    expect((await fetch(`${b.base}/leak.svg`)).status).toBe(404);
    expect((await fetch(`${b.base}/assets/leak.js`)).status).toBe(404);
    expect((await fetch(`${b.base}/assets/linkdir/secret.txt`)).status).toBe(404);
  });

  test("traversal attempts under /assets are refused", async () => {
    const b = await start();
    writeFileSync(join(b.dist, "index-secret.js"), "nope");
    for (const target of ["/assets/..%2findex-secret.js", "/assets/%2e%2e%2findex-secret.js", "/assets/..%5cindex-secret.js", "/assets/a%00b.js"]) {
      const res = await raw(b.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nConnection: close\r\n\r\n`);
      expect(res).toContain(" 404 ");
      expect(res).not.toContain("nope");
    }
  });

  test("/index.html is the shell (bootstrap injected), not the raw file", async () => {
    const b = await start();
    const text = await (await fetch(`${b.base}/index.html`)).text();
    expect(text).toContain('id="auto-bootstrap"');
  });

  test("POST to a static path is 405", async () => {
    const b = await start();
    expect((await fetch(`${b.base}/favicon.svg`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${b.base}/`, { method: "POST" })).status).toBe(405);
  });
});

describe("error handling", () => {
  test("a throwing API handler returns a generic 500 with no message or path", async () => {
    const boom = new Proxy(
      {},
      {
        get() {
          throw new Error("boom at /Users/someone/secret/path.ts");
        },
      },
    ) as unknown as Database;
    const b = await start({ db: boom });
    const orig = process.stderr.write.bind(process.stderr);
    const logged: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let res: Response;
    try {
      res = await fetch(`${b.base}/api/jobs`, { headers: bearer(b) });
    } finally {
      process.stderr.write = orig;
    }
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("boom");
    expect(text).not.toContain("/Users");
    // The detail is kept for the operator.
    expect(logged.join("")).toContain("boom at");
  });

  test("a throwing webhook dispatch is a generic 500", async () => {
    const b = await start({
      webhookAdapter: () =>
        ({
          handle: async () => {
            throw new Error("hook exploded /private/path");
          },
        }) as any,
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let res: Response;
    try {
      res = await fetch(`${b.base}/hooks/anything`, { method: "POST", body: "{}" });
    } finally {
      process.stderr.write = orig;
    }
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("exploded");
    expect(text).not.toContain("/private");
    expectHeaders(res);
  });

  test("bodies over the request cap are refused before the handler", async () => {
    const b = await start();
    const big = new Uint8Array(10 * 1024 * 1024 + 200_000);
    const res = await fetch(`${b.base}/api/config/reload`, { method: "POST", headers: bearer(b), body: big });
    expect(res.status).toBe(413);
  });
});

function expectHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("hardening added after the review", () => {
  test("[::1] is not a dashboard name: the server listens on IPv4 only, so the Host is refused", async () => {
    const b = await start();
    const res = await fetch(`${b.base}/`, { headers: { host: `[::1]:${b.port}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("bad_host");
  });

  test("responses carry Cross-Origin-Resource-Policy and Cross-Origin-Opener-Policy: same-origin", async () => {
    const b = await start();
    for (const res of await Promise.all([
      fetch(`${b.base}/`),
      fetch(`${b.base}/healthz`),
      fetch(`${b.base}/api/config/status`, { headers: bearer(b) }),
      fetch(`${b.base}/assets/app.js`),
      fetch(`${b.base}/`, { headers: { host: "evil.example" } }),
    ])) {
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    }
  });

  test("a cross-site <script>, <img> or fetch of the token page (or the API) is refused; a top-level navigation and non-browser clients are not", async () => {
    const b = await start();
    const asSubresource = (site: string, dest: string, mode = "no-cors") => ({
      "sec-fetch-site": site,
      "sec-fetch-mode": mode,
      "sec-fetch-dest": dest,
    });
    for (const path of ["/", "/jobs/x", "/favicon.svg", "/assets/app.js"]) {
      for (const [site, dest] of [["cross-site", "script"], ["cross-site", "image"], ["same-site", "script"], ["cross-site", "empty"]] as const) {
        const res = await fetch(`${b.base}${path}`, { headers: asSubresource(site, dest) });
        expect(res.status).toBe(403);
        const text = await res.text();
        expect(text).toContain("cross_site");
        expect(text).not.toContain(b.server.token);
      }
    }
    const api = await fetch(`${b.base}/api/config/status`, { headers: { ...bearer(b), ...asSubresource("cross-site", "empty", "cors") } });
    expect(api.status).toBe(403);
    // Same origin, direct navigation and clients that send no Sec-Fetch-* headers are fine.
    for (const headers of [
      asSubresource("same-origin", "script"),
      asSubresource("none", "document", "navigate"),
      asSubresource("cross-site", "document", "navigate"),
      {},
    ]) {
      expect((await fetch(`${b.base}/`, { headers })).status).toBe(200);
    }
  });

  test("a browser opening the dashboard under a name that is not allowed gets a page that says what to do", async () => {
    const b = await start();
    const page = await fetch(`${b.base}/`, { headers: { host: "evil.example:1", accept: "text/html,application/xhtml+xml" } });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("AUTO_ALLOWED_HOSTS");
    expect(html).toContain(`http://127.0.0.1:${b.port}/`);
    expect(html).not.toContain("evil.example"); // nothing from the request is echoed
    expect(html).not.toContain(b.server.token);
    // Anything that is not a browser navigation keeps the JSON error.
    const json = await fetch(`${b.base}/`, { headers: { host: "evil.example:1", accept: "application/json" } });
    expect(((await json.json()) as any).error).toBe("bad_host");
    const post = await fetch(`${b.base}/api/jobs`, { method: "POST", headers: { host: "evil.example:1", accept: "text/html" } });
    expect(((await post.json()) as any).error).toBe("bad_host");
  });

  test("a job whose name ends like a file (export.json) still gets the dashboard on reload; real file misses stay 404", async () => {
    const b = await start();
    for (const path of ["/jobs/export.json", "/jobs/feed.xml", "/jobs/data.js", "/jobs/report.pdf", "/jobs/backup.zip", "/jobs/with%20space.txt", "/runs/abc123.json", "/jobs/plain"]) {
      const res = await fetch(`${b.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    for (const path of ["/nope.json", "/nope.js", "/favicon.ico", "/x/y.json"]) {
      const res = await fetch(`${b.base}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  test("a second server on the same port fails to bind instead of sharing it", async () => {
    const b = await start();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      second = await startServer({
        db: b.db,
        registry: () => null,
        cronAdapter: () => null,
        runner: () => null,
        configStore: () => null,
        port: b.port,
        uiDistDir: b.dist,
        tokenPath: join(b.tmp, "second.token"),
        dataDir: b.tmp,
        heartbeatMs: 60_000,
      });
    } catch {
      // expected: address in use
    }
    if (second) await second.stop();
    expect(second).toBeNull();
    // The first server still serves with its own token.
    expect((await fetch(`${b.base}/api/config/status`, { headers: bearer(b) })).status).toBe(200);
  });
});
