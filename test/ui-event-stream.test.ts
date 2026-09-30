import { describe, expect, test } from "bun:test";
import { backoffDelay, createEventStream, MAX_BACKOFF_MS } from "../ui/src/util/eventStream.ts";
import type { ConnectionState, SSEEvent } from "../ui/src/util/eventStream.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

type Call = {
  url: string;
  init: RequestInit;
  push: (s: string) => void;
  pushBytes: (b: Uint8Array) => void;
  end: () => void;
};

/**
 * A fake fetch. Each call is answered by `answer(callIndex)`: a status number,
 * or "open" for a 200 stream the test drives through `calls[i].push/end`.
 */
function fakeFetch(answer: (n: number) => number | "open") {
  const calls: Call[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const n = calls.length;
    const a = answer(n);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const call: Call = {
      url: String(input),
      init: init ?? {},
      push: (s) => controller.enqueue(enc.encode(s)),
      pushBytes: (b) => controller.enqueue(b),
      end: () => controller.close(),
    };
    calls.push(call);
    init?.signal?.addEventListener("abort", () => {
      try {
        controller.error(new Error("aborted"));
      } catch {
        // already closed
      }
    });
    if (a === "open") {
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }
    return Promise.resolve(new Response(a === 401 ? '{"error":"unauthorized"}' : "nope", { status: a }));
  }) as typeof fetch;
  return { calls, impl };
}

function harness(
  answer: (n: number) => number | "open",
  extra: Partial<Parameters<typeof createEventStream>[0]> = {},
) {
  const f = fakeFetch(answer);
  const events: SSEEvent[] = [];
  const states: ConnectionState[] = [];
  let opens = 0;
  const stream = createEventStream({
    url: "/events",
    getToken: () => "tok-1",
    onEvent: (e) => events.push(e),
    onOpen: () => {
      opens += 1;
    },
    onState: (s) => states.push(s),
    fetchImpl: f.impl,
    baseBackoffMs: 5,
    maxBackoffMs: 40,
    random: () => 1,
    ...extra,
  });
  return { ...f, events, states, stream, opens: () => opens };
}

describe("request", () => {
  test("sends the bearer token in a header, never in the URL, and no cookies", async () => {
    const h = harness(() => "open");
    await until(() => h.calls.length === 1);
    const { url, init } = h.calls[0]!;
    expect(url).toBe("/events");
    expect(url).not.toContain("tok-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect(init.credentials).toBe("omit");
    h.stream.close();
  });

  test("reads the token again on every reconnect", async () => {
    let token = "old";
    const h = harness((n) => (n === 0 ? 500 : "open"), { getToken: () => token });
    await until(() => h.calls.length === 1);
    token = "new";
    await until(() => h.calls.length === 2);
    expect((h.calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer new");
    h.stream.close();
  });
});

describe("events", () => {
  test("known events are parsed and delivered; unknown, malformed and comment frames are dropped", async () => {
    const h = harness(() => "open");
    await until(() => h.calls.length === 1);
    const c = h.calls[0]!;
    c.push(": connected\n\n");
    c.push('event: run.started\ndata: {"run_id":"r1"}\n\n');
    c.push("event: run.finished\ndata: {not json}\n\n");
    c.push('event: mystery\ndata: {"x":1}\n\n');
    c.push(": ping\n\n");
    c.push('event: run.finished\r\ndata: {"run_id":"r1",\r\ndata: "state":"succeeded"}\r\n\r\n');
    await until(() => h.events.length === 2);
    expect(h.events).toEqual([
      { name: "run.started", data: { run_id: "r1" } },
      { name: "run.finished", data: { run_id: "r1", state: "succeeded" } },
    ]);
    h.stream.close();
  });

  test("a frame split across reads, mid-character, is delivered once", async () => {
    const h = harness(() => "open");
    await until(() => h.calls.length === 1);
    const bytes = enc.encode('event: config.error\ndata: {"message":"café ✓"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte "é"
    h.calls[0]!.pushBytes(bytes.slice(0, cut));
    await sleep(10);
    expect(h.events).toEqual([]);
    h.calls[0]!.pushBytes(bytes.slice(cut));
    await until(() => h.events.length === 1);
    expect(h.events[0]).toEqual({ name: "config.error", data: { message: "café ✓" } });
    h.stream.close();
  });
});

describe("connection state and open callback", () => {
  test("connecting, open, then retrying when the stream ends; onOpen on every open", async () => {
    const h = harness(() => "open");
    await until(() => h.calls.length === 1);
    await until(() => h.opens() === 1);
    expect(h.states.slice(0, 2)).toEqual(["connecting", "open"]);
    h.calls[0]!.end();
    await until(() => h.calls.length === 2);
    await until(() => h.opens() === 2);
    expect(h.states).toContain("retrying");
    expect(h.states.at(-1)).toBe("open");
    h.stream.close();
  });

  test("a failed request retries and reports retrying", async () => {
    const h = harness((n) => (n < 2 ? 503 : "open"));
    await until(() => h.opens() === 1);
    expect(h.calls.length).toBe(3);
    expect(h.states.filter((s) => s === "retrying").length).toBeGreaterThanOrEqual(2);
    h.stream.close();
  });
});

describe("401", () => {
  test("stops retrying and reports unauthorized", async () => {
    const h = harness(() => 401);
    await until(() => h.states.includes("unauthorized"));
    await sleep(120); // many backoff periods at this scale
    expect(h.calls.length).toBe(1);
    expect(h.states.at(-1)).toBe("unauthorized");
    expect(h.opens()).toBe(0);
    h.stream.close();
  });

  test("a 401 after the stream was open also stops (the token rotated between reconnects)", async () => {
    const h = harness((n) => (n === 0 ? "open" : 401));
    await until(() => h.opens() === 1);
    h.calls[0]!.end();
    await until(() => h.states.at(-1) === "unauthorized");
    await sleep(80);
    expect(h.calls.length).toBe(2);
    h.stream.close();
  });

  test("reconnect() after unauthorized starts over", async () => {
    let fail = true;
    const h = harness(() => (fail ? 401 : "open"));
    await until(() => h.states.includes("unauthorized"));
    fail = false;
    h.stream.reconnect();
    await until(() => h.opens() === 1);
    expect(h.states.at(-1)).toBe("open");
    h.stream.close();
  });
});

describe("backoff", () => {
  test("delays grow exponentially, cap at the maximum, and carry jitter", () => {
    const top = (a: number) => backoffDelay(a, () => 1);
    const bottom = (a: number) => backoffDelay(a, () => 0);
    expect(top(1)).toBe(500);
    expect(top(2)).toBe(1000);
    expect(top(3)).toBe(2000);
    expect(top(6)).toBe(16_000);
    expect(top(7)).toBe(MAX_BACKOFF_MS);
    expect(top(50)).toBe(MAX_BACKOFF_MS);
    expect(bottom(3)).toBe(1000); // jitter spans 50%..100% of the ceiling
    expect(MAX_BACKOFF_MS).toBeGreaterThanOrEqual(25_000);
    expect(MAX_BACKOFF_MS).toBeLessThanOrEqual(35_000);
  });

  test("consecutive failures wait longer each time; a successful open resets", async () => {
    const times: number[] = [];
    const h = harness(
      (n) => {
        times.push(Date.now());
        return n < 4 ? 500 : "open";
      },
      { baseBackoffMs: 20, maxBackoffMs: 1000 },
    );
    await until(() => h.opens() === 1);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    // 20, 40, 80, 160 ms nominal (random() = 1); allow timer slop.
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.4);
    expect(gaps[3]!).toBeGreaterThan(gaps[1]! * 1.8);
    // After the open, drop it: the next wait is back at the base delay.
    const before = Date.now();
    h.calls.at(-1)!.end();
    await until(() => h.calls.length === 6);
    expect(Date.now() - before).toBeLessThan(120);
    h.stream.close();
  });
});

describe("stall detection", () => {
  test("no bytes for the stall period aborts and reconnects", async () => {
    const h = harness(() => "open", { stallMs: 40 });
    await until(() => h.calls.length === 2, 1000);
    expect(h.calls[0]!.init.signal?.aborted).toBe(true);
    h.stream.close();
  });

  test("heartbeat comments keep a quiet stream alive", async () => {
    const h = harness(() => "open", { stallMs: 60 });
    await until(() => h.calls.length === 1);
    for (let i = 0; i < 10; i++) {
      h.calls[0]!.push(": ping\n\n");
      await sleep(20);
    }
    expect(h.calls.length).toBe(1);
    h.stream.close();
  });
});

describe("close", () => {
  test("aborts the request and never connects again", async () => {
    const h = harness(() => "open");
    await until(() => h.opens() === 1);
    const signal = h.calls[0]!.init.signal!;
    h.stream.close();
    expect(signal.aborted).toBe(true);
    await sleep(80);
    expect(h.calls.length).toBe(1);
  });

  test("close during a backoff wait cancels the retry", async () => {
    const h = harness(() => 500, { baseBackoffMs: 200, maxBackoffMs: 200 });
    await until(() => h.calls.length === 1);
    await sleep(10);
    h.stream.close();
    await sleep(300);
    expect(h.calls.length).toBe(1);
  });

  test("state changes after close are not reported", async () => {
    const h = harness(() => 500, { baseBackoffMs: 5 });
    await until(() => h.calls.length === 1);
    h.stream.close();
    const n = h.states.length;
    await sleep(60);
    expect(h.states.length).toBe(n);
  });
});

describe("wake signal", () => {
  test("the wake hook cuts a backoff wait short (the browser coming back online)", async () => {
    let wake: (() => void) | null = null;
    const h = harness((n) => (n === 0 ? 500 : "open"), {
      baseBackoffMs: 5_000,
      maxBackoffMs: 5_000,
      wakeOn: (w) => {
        wake = w;
        return () => {
          wake = null;
        };
      },
    });
    await until(() => h.calls.length === 1);
    await until(() => wake !== null);
    (wake as unknown as () => void)();
    await until(() => h.opens() === 1, 500);
    h.stream.close();
  });
});
