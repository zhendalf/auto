import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

// The dashboard's REST client sends the embedded token as `Authorization: Bearer`,
// never as a cookie or in a URL, and maps failures to one error type. The module
// touches `document` (the bootstrap tag), so it is loaded dynamically after a
// stub is in place; the specifier is a variable because the root type-check has
// no DOM library.

const TOKEN = "t".repeat(64);
type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let next: () => Response | Promise<Response> = () => Response.json([]);
const realFetch = globalThis.fetch;
const g = globalThis as unknown as { document?: unknown; fetch: unknown };
const hadDocument = "document" in g;
const realDocument = g.document;

let client: {
  api: Record<string, (...a: any[]) => Promise<any>>;
  ApiError: new (status: number, body: unknown) => Error & { status: number };
  isUnauthorized: (e: unknown) => boolean;
};

beforeAll(async () => {
  g.document = {
    getElementById: (id: string) => (id === "auto-bootstrap" ? { textContent: JSON.stringify({ token: TOKEN, port: 4321 }) } : null),
  };
  const path = join(import.meta.dir, "..", "ui", "src", "api", "client.ts");
  client = await import(path);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (hadDocument) g.document = realDocument;
  else delete g.document;
});

beforeEach(() => {
  calls = [];
  next = () => Response.json([]);
  g.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return next();
  }) as unknown;
});

const header = (c: Call, name: string): string | null => {
  const h = c.init.headers as Record<string, string> | undefined;
  if (!h) return null;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
};

describe("every request carries the bearer token", () => {
  test("a GET sends Authorization: Bearer <token>, omits credentials and puts nothing in the URL", async () => {
    await client.api.jobs!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/jobs");
    expect(header(calls[0]!, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  test("a POST with a body also sends the token and a JSON content type", async () => {
    next = () => new Response(null, { status: 204 });
    await client.api.pauseJob!("my job", { duration_ms: 1000 });
    const c = calls[0]!;
    expect(c.url).toBe("/api/jobs/my%20job/pause");
    expect(c.init.method).toBe("POST");
    expect(header(c, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(c, "content-type")).toBe("application/json");
    expect(c.init.body).toBe(JSON.stringify({ duration_ms: 1000 }));
  });

  test("the log endpoints (GET and HEAD) send it too", async () => {
    next = () => new Response("hello\n", { headers: { "x-log-size": "6", "x-run-state": "succeeded" } });
    await client.api.runLogChunk!("abcdef12", 0);
    await client.api.runLogInfo!("abcdef12");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "HEAD"]);
    for (const c of calls) {
      expect(header(c, "authorization")).toBe(`Bearer ${TOKEN}`);
      expect(c.init.credentials).toBe("omit");
    }
  });

  test("runs paging and run detail send it", async () => {
    await client.api.runs!({ job: "a b", limit: 5 });
    next = () => Response.json({ run_id: "x" });
    await client.api.run!("abcdef12");
    expect(calls.map((c) => header(c, "authorization"))).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(calls[0]!.url).toBe("/api/runs?job=a+b&limit=5");
  });
});

describe("failures become one error type", () => {
  test("a 401 is ApiError(401) and isUnauthorized says so", async () => {
    next = () => Response.json({ error: "unauthorized" }, { status: 401 });
    const err = await client.api.jobs!().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(client.ApiError);
    expect(err.status).toBe(401);
    expect(client.isUnauthorized(err)).toBe(true);
  });

  test("an error status carries the response body", async () => {
    next = () => Response.json({ error: "skipped", reason: "disabled" }, { status: 422 });
    const err = await client.api.runJob!("x").then(() => null, (e) => e);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ error: "skipped", reason: "disabled" });
  });

  test("a network failure is ApiError(0)", async () => {
    next = () => { throw new TypeError("network down"); };
    const err = await client.api.jobs!().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(client.ApiError);
    expect(err.status).toBe(0);
  });

  test("a 202 from run is reported as queued with its position", async () => {
    next = () => Response.json({ run_id: "r1", position: 2 }, { status: 202 });
    expect(await client.api.runJob!("x")).toMatchObject({ run_id: "r1", position: 2, status: 202 });
  });
});
