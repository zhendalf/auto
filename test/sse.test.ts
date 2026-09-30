import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "../supervisor/db/migrate.ts";
import { JobRegistry } from "../supervisor/registry.ts";
import { Runner } from "../supervisor/runner.ts";
import { CronAdapter } from "../supervisor/adapters/cron.ts";
import { ConfigStore } from "../supervisor/config.ts";
import { startServer, type ServerHandle } from "../supervisor/server.ts";
import type { Automation, Config } from "../supervisor/config.ts";
import { SSEBroadcaster } from "../supervisor/sse.ts";
import { SSEClient, type SSEHttpError } from "../cli/sse.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FIXTURES = resolve(HERE, "fixtures");

type Ctx = {
  tmp: string;
  db: Database;
  runner: Runner;
  registry: JobRegistry;
  cron: CronAdapter;
  configStore: ConfigStore;
  server: ServerHandle;
  port: number;
};

function makeJob(name: string, worker: string): Automation {
  return {
    id: name,
    name,
    description: undefined,
    worker,
    triggers: [{ kind: "cron", id: "default", schedule: "* * * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 600_000,
    killGraceMs: 10_000,
    enabled: true,
  };
}

async function setup(heartbeatMs?: number, extra: Partial<Parameters<typeof startServer>[0]> = {}): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "sse-test-"));
  const dataDir = tmp;
  const tokenPath = join(tmp, ".token");
  const dbPath = join(tmp, "test.db");
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);

  const config: Config = [
    makeJob("hello-job", join(FIXTURES, "hello-worker.ts")),
  ];
  const registry = new JobRegistry({ db });
  registry.reconcile(config);

  const runner = new Runner({
    db,
    registry,
    workspaceRoot: REPO_ROOT,
    dataDir,
    logsDir: join(dataDir, "runs"),
  });
  const cron = new CronAdapter({ runner });
  cron.reconcile(registry.activeCronJobs());

  const configStore = new ConfigStore();
  configStore.current = config;
  configStore.lastLoadedAt = Date.now();

  const server = await startServer({
    db,
    registry: () => registry,
    cronAdapter: () => cron,
    runner: () => runner,
    configStore: () => configStore,
    port: 0,
    uiDistDir: resolve(REPO_ROOT, "ui", "dist"),
    tokenPath,
    dataDir,
    heartbeatMs,
    ...extra,
  });

  return { tmp, db, runner, registry, cron, configStore, server, port: server.port };
}

async function teardown(ctx: Ctx): Promise<void> {
  try {
    await ctx.server.stop();
  } catch {
    /* ignore */
  }
  try {
    ctx.cron.stop();
  } catch {
    /* ignore */
  }
  try {
    await ctx.runner.shutdown(2_000);
  } catch {
    /* ignore */
  }
  try {
    ctx.db.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(ctx.tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Helpers for parsing an SSE byte stream from a fetch Response.body
// ---------------------------------------------------------------------------

type SseEvent = {
  comment?: string;
  event?: string;
  data?: string;
};

class SseReader {
  private buf = "";
  private decoder = new TextDecoder();
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
  }
  async next(timeoutMs: number): Promise<SseEvent | null> {
    while (true) {
      // Drain any complete events already buffered.
      const idx = this.buf.indexOf("\n\n");
      if (idx >= 0) {
        const block = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        return parseBlock(block);
      }
      // Otherwise read more.
      const readPromise = this.reader.read();
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
      const winner = await Promise.race([readPromise, timeout]);
      if (winner === null) return null;
      if (winner.done) return null;
      this.buf += this.decoder.decode(winner.value, { stream: true });
    }
  }
  cancel(): void {
    try {
      this.reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseBlock(block: string): SseEvent {
  const ev: SseEvent = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      ev.comment = (ev.comment ?? "") + line.slice(1).trim();
    } else if (line.startsWith("event:")) {
      ev.event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      ev.data = (ev.data ?? "") + line.slice("data:".length).trim();
    }
  }
  return ev;
}

let ctx: Ctx;

const bearer = (): Record<string, string> => ({ authorization: `Bearer ${ctx.server.token}` });

afterEach(async () => {
  if (ctx) await teardown(ctx);
});

describe("SSE /events", () => {
  test("connect with valid token: receives `: connected` then a heartbeat", async () => {
    ctx = await setup(60); // 60ms heartbeat
    const res = await fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = new SseReader(res.body!);
    try {
      const first = await reader.next(1000);
      expect(first).not.toBeNull();
      expect(first!.comment).toBe("connected");
      const second = await reader.next(2000);
      expect(second).not.toBeNull();
      expect(second!.comment).toBe("ping");
    } finally {
      reader.cancel();
    }
  });

  test("emit() delivers an event to subscribed client", async () => {
    ctx = await setup(60_000); // long heartbeat — we want explicit events.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
    const reader = new SseReader(res.body!);
    try {
      // First event is the `: connected` comment.
      const connected = await reader.next(1000);
      expect(connected!.comment).toBe("connected");

      // Emit a synthetic event after the subscriber is registered.
      ctx.server.emit("run.started", {
        ts: 12345,
        run_id: "test-run",
        job_id: "test-job",
      });

      const got = await reader.next(2000);
      expect(got).not.toBeNull();
      expect(got!.event).toBe("run.started");
      expect(got!.data).toBeTruthy();
      const data = JSON.parse(got!.data!);
      expect(data.run_id).toBe("test-run");
      expect(data.job_id).toBe("test-job");
      expect(data.ts).toBe(12345);
    } finally {
      reader.cancel();
    }
  });

  test("wrong token -> 401, no body", async () => {
    ctx = await setup(60_000);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/events`, {
      headers: { authorization: "Bearer deadbeef" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("missing token -> 401", async () => {
    ctx = await setup(60_000);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/events`);
    expect(res.status).toBe(401);
  });

  test("the token in the query string is not accepted", async () => {
    ctx = await setup(60_000);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/events?token=${ctx.server.token}`);
    expect(res.status).toBe(401);
    expect(ctx.server.subscriberCount()).toBe(0);
  });

  test("only the Authorization header authenticates: cookie and X-Auto-Token do not", async () => {
    ctx = await setup(60_000);
    const url = `http://127.0.0.1:${ctx.port}/events`;
    expect((await fetch(url, { headers: { cookie: `auto_session=${ctx.server.token}` } })).status).toBe(401);
    expect((await fetch(url, { headers: { "x-auto-token": ctx.server.token } })).status).toBe(401);
    expect(ctx.server.subscriberCount()).toBe(0);
  });

  test("a wrong Host or a foreign Origin is refused before authentication is even considered", async () => {
    ctx = await setup(60_000);
    const url = `http://127.0.0.1:${ctx.port}/events`;
    const badHost = await fetch(url, { headers: { ...bearer(), host: "evil.example" } });
    expect(badHost.status).toBe(403);
    const badOrigin = await fetch(url, { headers: { ...bearer(), origin: "http://evil.example" } });
    expect(badOrigin.status).toBe(403);
    expect(ctx.server.subscriberCount()).toBe(0);
  });

  test("the stream opens with an immediate `: connected` comment (before any heartbeat)", async () => {
    ctx = await setup(60_000);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
    const reader = new SseReader(res.body!);
    try {
      const first = await reader.next(500);
      expect(first!.comment).toBe("connected");
      expect(res.headers.get("cache-control")).toContain("no-store");
    } finally {
      reader.cancel();
    }
  });

  test("subscriber cap: the next subscriber gets 503 and a slot frees when one leaves", async () => {
    ctx = await setup(60_000, { maxSubscribers: 2 });
    const open = () => fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
    const a = await open();
    const b = await open();
    const c = await open();
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(503);
    expect(((await c.json()) as any).error).toBe("too_many_subscribers");
    expect(c.headers.get("retry-after")).toBeTruthy();
    await a.body!.cancel();
    const start = Date.now();
    while (ctx.server.subscriberCount() > 1 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const d = await open();
    expect(d.status).toBe(200);
    await b.body!.cancel();
    await d.body!.cancel();
  });

  test("two subscribers receive the same event", async () => {
    ctx = await setup(60_000);
    const res1 = await fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
    const res2 = await fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
    const r1 = new SseReader(res1.body!);
    const r2 = new SseReader(res2.body!);
    try {
      // Drain the initial `: connected` comments on both.
      await r1.next(1000);
      await r2.next(1000);

      // Wait until both subscribers are registered before emitting.
      const start = Date.now();
      while (ctx.server.subscriberCount() < 2 && Date.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(ctx.server.subscriberCount()).toBe(2);

      ctx.server.emit("run.finished", {
        ts: 99,
        run_id: "shared",
        state: "succeeded",
      });

      const a = await r1.next(2000);
      const b = await r2.next(2000);
      expect(a!.event).toBe("run.finished");
      expect(b!.event).toBe("run.finished");
      expect(JSON.parse(a!.data!).run_id).toBe("shared");
      expect(JSON.parse(b!.data!).run_id).toBe("shared");
    } finally {
      r1.cancel();
      r2.cancel();
    }
  });
});

describe("SSE keeps an idle stream alive", () => {
  test(
    "default 15 s heartbeat outlives Bun's idle timeout (heartbeat NOT overridden)",
    async () => {
      // Bun closes a connection that is silent for `idleTimeout` seconds; the
      // default is 10, shorter than the 15 s heartbeat. The server therefore
      // raises idleTimeout, and this proves a ping actually arrives past 10 s.
      ctx = await setup(undefined);
      const res = await fetch(`http://127.0.0.1:${ctx.port}/events`, { headers: bearer() });
      const reader = new SseReader(res.body!);
      try {
        const first = await reader.next(1_000);
        expect(first!.comment).toBe("connected");
        const t0 = Date.now();
        const ping = await reader.next(20_000);
        expect(ping).not.toBeNull();
        expect(ping!.comment).toBe("ping");
        expect(Date.now() - t0).toBeGreaterThan(10_000);
        expect(ctx.server.subscriberCount()).toBe(1);
      } finally {
        reader.cancel();
      }
    },
    30_000,
  );
});

describe("SSEBroadcaster backpressure", () => {
  test("a subscriber that never reads is dropped once its backlog is very large", () => {
    const b = new SSEBroadcaster({ heartbeatMs: 60_000, maxQueuedChunks: 5 });
    try {
      const res = b.subscribe(new Request("http://x/events"));
      expect(res.status).toBe(200);
      expect(b.subscriberCount()).toBe(1);
      for (let i = 0; i < 20; i++) b.emit("run.started", { i });
      expect(b.subscriberCount()).toBe(0);
    } finally {
      void b.stop();
    }
  });

  test("a subscriber that keeps reading is never dropped", async () => {
    const b = new SSEBroadcaster({ heartbeatMs: 60_000, maxQueuedChunks: 5 });
    try {
      const res = b.subscribe(new Request("http://x/events"));
      const reader = res.body!.getReader();
      for (let i = 0; i < 50; i++) {
        b.emit("run.started", { i });
        await reader.read();
      }
      expect(b.subscriberCount()).toBe(1);
      await reader.cancel();
    } finally {
      void b.stop();
    }
  });

  test("emit is safe with no subscribers and after stop", async () => {
    const b = new SSEBroadcaster({ heartbeatMs: 60_000 });
    b.emit("x", { a: 1 });
    await b.stop();
    b.emit("x", { a: 1 });
    expect(b.subscribe(new Request("http://x/events")).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// cli/sse.ts client
// ---------------------------------------------------------------------------

type Fake = {
  port: number;
  requests: { auth: string | null; url: string; origin: string | null }[];
  stop: () => void;
};

/** A scripted SSE endpoint: `script(n, controller)` runs for the n-th connection (0-based). */
function fakeSse(
  script: (n: number, ctl: ReadableStreamDefaultController<Uint8Array>) => Response | void,
  port = 0,
): Fake {
  const enc = new TextEncoder();
  let n = 0;
  const requests: Fake["requests"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const u = new URL(req.url);
      requests.push({ auth: req.headers.get("authorization"), url: u.pathname + u.search, origin: req.headers.get("origin") });
      const idx = n++;
      let early: Response | void = undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) {
          early = script(idx, {
            enqueue: (c: Uint8Array) => ctl.enqueue(c),
            close: () => ctl.close(),
            error: (e?: unknown) => ctl.error(e),
            get desiredSize() {
              return ctl.desiredSize;
            },
          } as ReadableStreamDefaultController<Uint8Array>);
          if (!early) ctl.enqueue(enc.encode(": connected\n\n"));
        },
      });
      return early ?? new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { port: server.port!, requests, stop: () => void server.stop(true) };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("cli SSEClient", () => {
  test("authenticates with the Authorization header and never puts the token in the URL", async () => {
    const fake = fakeSse(() => {});
    const events: string[] = [];
    const c = new SSEClient({
      url: `http://127.0.0.1:${fake.port}/events`,
      origin: `http://127.0.0.1:${fake.port}`,
      token: "tok123",
      onEvent: (e) => events.push(e.event),
    });
    try {
      expect(await c.start()).toBe(true);
      expect(fake.requests[0]!.auth).toBe("Bearer tok123");
      expect(fake.requests[0]!.url).toBe("/events");
      expect(fake.requests[0]!.origin).toBe(`http://127.0.0.1:${fake.port}`);
    } finally {
      c.close();
      fake.stop();
    }
  });

  test("a legacy ?token= URL is converted to the header", async () => {
    const fake = fakeSse(() => {});
    const c = new SSEClient({
      url: `http://127.0.0.1:${fake.port}/events?token=legacy`,
      origin: "http://x",
      onEvent: () => {},
    });
    try {
      await c.start();
      expect(fake.requests[0]!.auth).toBe("Bearer legacy");
      expect(fake.requests[0]!.url).toBe("/events");
    } finally {
      c.close();
      fake.stop();
    }
  });

  test("start() resolves only once the stream is open (server answers slowly)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const enc = new TextEncoder();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await gate;
        return new Response(
          new ReadableStream({
            start(ctl) {
              ctl.enqueue(enc.encode(": connected\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let opened = 0;
    const c = new SSEClient({
      url: `http://127.0.0.1:${server.port}/events`,
      origin: "http://x",
      token: "t",
      onEvent: () => {},
      onOpen: () => opened++,
    });
    try {
      let settled = false;
      const p = c.start().then((v) => {
        settled = true;
        return v;
      });
      await new Promise((r) => setTimeout(r, 200)); // the old implementation returned after 50 ms
      expect(settled).toBe(false);
      release();
      expect(await p).toBe(true);
      expect(opened).toBe(1);
      expect(c.state).toBe("open");
    } finally {
      c.close();
      server.stop(true);
    }
  });

  test("start() gives up waiting when the server is unreachable (and keeps retrying)", async () => {
    const errors: unknown[] = [];
    const c = new SSEClient({
      url: "http://127.0.0.1:1/events",
      origin: "http://x",
      token: "t",
      onEvent: () => {},
      onError: (e) => errors.push(e),
    });
    try {
      expect(await c.start(2_000)).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      c.close();
    }
  });

  test("delivers events and fires onOpen again after a reconnect", async () => {
    // Connection 0 sends an event then ends; connection 1 stays open.
    const enc = new TextEncoder();
    const fake = fakeSse((n, ctl) => {
      ctl.enqueue(enc.encode(": connected\n\n"));
      ctl.enqueue(enc.encode(`event: run.finished\ndata: {"n":${n}}\n\n`));
      if (n === 0) queueMicrotask(() => ctl.close());
      return undefined;
    });
    const seen: string[] = [];
    let opens = 0;
    const c = new SSEClient({
      url: `http://127.0.0.1:${fake.port}/events`,
      origin: "http://x",
      token: "t",
      onEvent: (e) => seen.push(e.data),
      onOpen: () => opens++,
    });
    try {
      await c.start();
      await until(() => seen.length >= 2);
      expect(seen).toEqual(['{"n":0}', '{"n":1}']);
      expect(opens).toBe(2);
    } finally {
      c.close();
      fake.stop();
    }
  });

  test("backoff resets after a successful open, so a later drop reconnects quickly", async () => {
    // Connections 0-2 are refused (503), 3 opens and then ends, 4 opens and stays.
    // If backoff only reset on a clean end it would still be at its cap on 4.
    const enc = new TextEncoder();
    const times: number[] = [];
    const fake = fakeSse((n, ctl) => {
      times.push(Date.now());
      if (n < 3) return new Response("no", { status: 503 });
      ctl.enqueue(enc.encode(": connected\n\n"));
      if (n === 3) queueMicrotask(() => ctl.close());
      return undefined;
    });
    const c = new SSEClient({ url: `http://127.0.0.1:${fake.port}/events`, origin: "http://x", token: "t", onEvent: () => {}, onError: () => {} });
    try {
      await c.start(5_000);
      await until(() => times.length >= 5, 8_000);
      // Gaps: 250, 500, 1000 while failing; after opening on #3 the next gap is back to 250 ms.
      const gapAfterOpen = times[4]! - times[3]!;
      expect(gapAfterOpen).toBeLessThan(700);
      expect(times[3]! - times[2]!).toBeGreaterThan(800);
    } finally {
      c.close();
      fake.stop();
    }
  }, 15_000);

  test("stall detection: no bytes for three heartbeats forces a reconnect", async () => {
    const enc = new TextEncoder();
    const fake = fakeSse((n, ctl) => {
      ctl.enqueue(enc.encode(": connected\n\n"));
      // Connection 0 then goes silent; connection 1 delivers an event.
      if (n === 1) ctl.enqueue(enc.encode('event: run.finished\ndata: {"ok":1}\n\n'));
      return undefined;
    });
    const seen: string[] = [];
    const errors: string[] = [];
    let opens = 0;
    const c = new SSEClient({
      url: `http://127.0.0.1:${fake.port}/events`,
      origin: "http://x",
      token: "t",
      heartbeatMs: 60, // stall limit = 180 ms
      onEvent: (e) => seen.push(e.data),
      onOpen: () => opens++,
      onError: (e) => errors.push(String((e as Error).message)),
    });
    try {
      await c.start();
      await until(() => seen.length === 1, 4_000);
      expect(opens).toBe(2);
      expect(errors.join("|")).toContain("stalled");
    } finally {
      c.close();
      fake.stop();
    }
  });

  test("a client whose stream keeps pinging is not treated as stalled", async () => {
    const enc = new TextEncoder();
    let ctlRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fake = fakeSse((_n, ctl) => {
      ctlRef = ctl;
      ctl.enqueue(enc.encode(": connected\n\n"));
      return undefined;
    });
    let opens = 0;
    const c = new SSEClient({
      url: `http://127.0.0.1:${fake.port}/events`,
      origin: "http://x",
      token: "t",
      heartbeatMs: 60,
      onEvent: () => {},
      onOpen: () => opens++,
    });
    const pinger = setInterval(() => ctlRef?.enqueue(enc.encode(": ping\n\n")), 40);
    try {
      await c.start();
      await new Promise((r) => setTimeout(r, 600));
      expect(opens).toBe(1);
    } finally {
      clearInterval(pinger);
      c.close();
      fake.stop();
    }
  });

  test("401 with a fixed token stops retrying and reports unauthorized", async () => {
    const fake = fakeSse(() => new Response("{}", { status: 401 }));
    const errors: unknown[] = [];
    const c = new SSEClient({ url: `http://127.0.0.1:${fake.port}/events`, origin: "http://x", token: "stale", onEvent: () => {}, onError: (e) => errors.push(e) });
    try {
      expect(await c.start()).toBe(false);
      await new Promise((r) => setTimeout(r, 700));
      expect(fake.requests.length).toBe(1);
      expect(c.state).toBe("unauthorized");
      expect((errors[0] as SSEHttpError).status).toBe(401);
    } finally {
      c.close();
      fake.stop();
    }
  });

  test("401 with a token function retries and picks up the re-read token", async () => {
    const fake = fakeSse((n) => (n === 0 ? new Response("{}", { status: 401 }) : undefined));
    let current = "old";
    const c = new SSEClient({
      url: `http://127.0.0.1:${fake.port}/events`,
      origin: "http://x",
      token: () => current,
      onEvent: () => {},
      onError: () => {
        current = "new";
      },
    });
    try {
      await c.start(1_000);
      await until(() => c.state === "open", 3_000);
      expect(fake.requests.map((r) => r.auth)).toEqual(["Bearer old", "Bearer new"]);
    } finally {
      c.close();
      fake.stop();
    }
  });

  test("close() stops the loop promptly, even mid-backoff", async () => {
    const c = new SSEClient({ url: "http://127.0.0.1:1/events", origin: "http://x", token: "t", onEvent: () => {}, onError: () => {} });
    await c.start(300);
    c.close();
    expect(c.state).toBe("closed");
    expect(await c.start()).toBe(false);
  });

  test("works end to end against the real supervisor server with the header token", async () => {
    ctx = await setup(60_000);
    const seen: string[] = [];
    const c = new SSEClient({
      url: `http://127.0.0.1:${ctx.port}/events`,
      origin: `http://127.0.0.1:${ctx.port}`,
      token: ctx.server.token,
      onEvent: (e) => seen.push(e.event),
    });
    try {
      expect(await c.start()).toBe(true);
      ctx.server.emit("run.finished", { run_id: "r" });
      await until(() => seen.length === 1);
      expect(seen).toEqual(["run.finished"]);
    } finally {
      c.close();
    }
  });
});
