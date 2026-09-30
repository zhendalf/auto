import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApiClient,
  ApiError,
  SupervisorUnreachable,
  TokenMissing,
} from "../cli/client.ts";

// ---------------------------------------------------------------------------
// Test fixture: a tiny Bun.serve that mimics the supervisor's API.
// ---------------------------------------------------------------------------

type FixtureCall = {
  method: string;
  path: string;
  authorization: string | null;
  origin: string | null;
  body: string | null;
};

type Fixture = {
  port: number;
  baseUrl: string;
  token: string;
  calls: FixtureCall[];
  stop: () => Promise<void>;
};

async function startFixture(opts: {
  status?: number;
  routes?: Record<string, (req: Request, url: URL) => Response | Promise<Response>>;
  healthzStatus?: number;
} = {}): Promise<Fixture> {
  const calls: FixtureCall[] = [];
  const token = "fixture-token";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      let body: string | null = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          body = await req.text();
        } catch {
          body = null;
        }
      }
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        authorization: req.headers.get("authorization"),
        origin: req.headers.get("origin"),
        body,
      });
      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: opts.healthzStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      const handler = opts.routes?.[`${req.method} ${url.pathname}`];
      if (handler) return handler(req, url);
      // Default API path responds with whatever status was configured.
      return new Response(JSON.stringify({ ok: true, path: url.pathname }), {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const port = server.port ?? 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    calls,
    stop: async () => {
      try {
        server.stop(true);
      } catch {
        // ignore
      }
    },
  };
}

function writeToken(value: string): { dir: string; tokenPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cli-client-test-"));
  const tokenPath = join(dir, ".token");
  writeFileSync(tokenPath, value, { mode: 0o600 });
  return { dir, tokenPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiClient: token loading", () => {
  test("throws TokenMissing when file absent", () => {
    const c = new ApiClient({
      baseUrl: "http://127.0.0.1:1",
      tokenFile: join(tmpdir(), `auto-no-such-token-${Date.now()}`),
    });
    expect(() => c.token).toThrow(TokenMissing);
  });

  test("loads + caches token from custom path", () => {
    const { dir, tokenPath } = writeToken("deadbeef\n");
    try {
      const c = new ApiClient({ tokenFile: tokenPath });
      expect(c.token).toBe("deadbeef");
      expect(c.token).toBe("deadbeef"); // cached path
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ApiClient: header injection", () => {
  let fix: Fixture;
  let tokenDir: string;
  let tokenPath: string;
  let client: ApiClient;

  beforeEach(async () => {
    fix = await startFixture();
    const w = writeToken("test-token-123");
    tokenDir = w.dir;
    tokenPath = w.tokenPath;
    client = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
  });

  afterEach(async () => {
    await fix.stop();
    rmSync(tokenDir, { recursive: true, force: true });
  });

  test("GET attaches Bearer + Origin", async () => {
    await client.jobs();
    const last = fix.calls.at(-1)!;
    expect(last.authorization).toBe("Bearer test-token-123");
    expect(last.origin).toBe(fix.baseUrl);
  });

  test("POST also attaches Bearer + Origin + content-type", async () => {
    await client.pauseJob("foo", { duration_ms: 1_000 });
    const last = fix.calls.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.path).toBe("/api/jobs/foo/pause");
    expect(last.authorization).toBe("Bearer test-token-123");
    expect(last.origin).toBe(fix.baseUrl);
    const bodyObj = JSON.parse(last.body!);
    expect(bodyObj.duration_ms).toBe(1_000);
  });
});

describe("ApiClient: URL building", () => {
  let fix: Fixture;
  let tokenDir: string;
  let tokenPath: string;
  let client: ApiClient;

  beforeEach(async () => {
    fix = await startFixture();
    const w = writeToken("t");
    tokenDir = w.dir;
    tokenPath = w.tokenPath;
    client = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
  });

  afterEach(async () => {
    await fix.stop();
    rmSync(tokenDir, { recursive: true, force: true });
  });

  test("runs() builds correct query string", async () => {
    await client.runs({ job: "x", limit: 5 });
    const last = fix.calls.at(-1)!;
    expect(last.path).toBe("/api/runs?job=x&limit=5");
  });

  test("runs() with state + before", async () => {
    await client.runs({ job: "x", state: "succeeded", limit: 10, before: 1234 });
    const last = fix.calls.at(-1)!;
    expect(last.path).toBe("/api/runs?job=x&state=succeeded&limit=10&before=1234");
  });

  test("trigger ids URL-encoded", async () => {
    await client.enableTrigger("job:default");
    const last = fix.calls.at(-1)!;
    // ":" gets URL-encoded by encodeURIComponent
    expect(last.path).toBe("/api/triggers/job%3Adefault/enable");
  });
});

describe("ApiClient: error mapping", () => {
  let tokenDir: string;
  let tokenPath: string;

  beforeEach(() => {
    const w = writeToken("t");
    tokenDir = w.dir;
    tokenPath = w.tokenPath;
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  test("4xx from server is wrapped in ApiError with parsed body", async () => {
    const fix = await startFixture({ status: 404 });
    try {
      const client = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      await expect(client.job("missing")).rejects.toBeInstanceOf(ApiError);
      try {
        await client.job("missing");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.body).toBeTruthy();
      }
    } finally {
      await fix.stop();
    }
  });

  test("5xx from server is wrapped in ApiError", async () => {
    const fix = await startFixture({ status: 500 });
    try {
      const client = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      try {
        await client.jobs();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(500);
      }
    } finally {
      await fix.stop();
    }
  });

  test("ECONNREFUSED maps to SupervisorUnreachable", async () => {
    // Pick a port we know nothing listens on.
    const c = new ApiClient({
      baseUrl: "http://127.0.0.1:1",
      tokenFile: tokenPath,
      timeoutMs: 1_000,
    });
    try {
      await c.jobs();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SupervisorUnreachable);
    }
  });
});

describe("ApiClient.reachable()", () => {
  let tokenDir: string;
  let tokenPath: string;

  beforeEach(() => {
    const w = writeToken("t");
    tokenDir = w.dir;
    tokenPath = w.tokenPath;
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  test("returns true for 200", async () => {
    const fix = await startFixture({ healthzStatus: 200 });
    try {
      const c = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      expect(await c.reachable()).toBe(true);
    } finally {
      await fix.stop();
    }
  });

  test("returns true for 503 (degraded)", async () => {
    const fix = await startFixture({ healthzStatus: 503 });
    try {
      const c = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      expect(await c.reachable()).toBe(true);
    } finally {
      await fix.stop();
    }
  });

  test("returns false against an unreachable port", async () => {
    const c = new ApiClient({
      baseUrl: "http://127.0.0.1:1",
      tokenFile: tokenPath,
      timeoutMs: 1_000,
    });
    expect(await c.reachable()).toBe(false);
  });
});

describe("ApiClient.runJob()", () => {
  let tokenDir: string;
  let tokenPath: string;

  beforeEach(() => {
    const w = writeToken("t");
    tokenDir = w.dir;
    tokenPath = w.tokenPath;
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  test("200 returns status:200 + run_id", async () => {
    const fix = await startFixture({
      routes: {
        "POST /api/jobs/x/run": () =>
          new Response(JSON.stringify({ run_id: "abc-123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    try {
      const c = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      const r = await c.runJob("x", { force: true });
      expect(r.status).toBe(200);
      if (r.status === 200) expect(r.run_id).toBe("abc-123");
    } finally {
      await fix.stop();
    }
  });

  test("202 returns status:202 + run_id + position", async () => {
    const fix = await startFixture({
      routes: {
        "POST /api/jobs/x/run": () =>
          new Response(JSON.stringify({ run_id: "deadbeef", position: 1 }), {
            status: 202,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    try {
      const c = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      const r = await c.runJob("x");
      expect(r.status).toBe(202);
      if (r.status === 202) {
        expect(r.run_id).toBe("deadbeef");
        expect(r.position).toBe(1);
      }
    } finally {
      await fix.stop();
    }
  });

  test("409 conflict throws ApiError(409)", async () => {
    const fix = await startFixture({
      routes: {
        "POST /api/jobs/x/run": () =>
          new Response(JSON.stringify({ error: "conflict", running_run_id: "r1" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    try {
      const c = new ApiClient({ baseUrl: fix.baseUrl, tokenFile: tokenPath });
      try {
        await c.runJob("x");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
      }
    } finally {
      await fix.stop();
    }
  });
});
