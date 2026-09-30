import { describe, expect, test } from "bun:test";
import { LogFollower, DEFAULT_LIMITS } from "../ui/src/util/logFollower.ts";
import type { LogSource } from "../ui/src/util/logFollower.ts";
import { ApiError } from "../ui/src/util/errors.ts";

type Chunk = Awaited<ReturnType<LogSource["chunk"]>>;

/** A fake log endpoint over a growing byte string. */
function fakeLog(initial = "", state = "running") {
  const enc = new TextEncoder();
  const file = { bytes: enc.encode(initial), state, exists: true, fail: null as Error | null };
  const calls: { kind: "info" | "chunk"; offset: number }[] = [];
  const read = (offset: number): Chunk => {
    if (!file.exists) return { kind: "none", size: 0, state: file.state, reason: "no_log" };
    if (offset > file.bytes.length) return { kind: "reset", size: file.bytes.length, state: file.state };
    return { kind: "data", bytes: file.bytes.slice(offset), size: file.bytes.length, state: file.state };
  };
  const source: LogSource = {
    info: async () => {
      calls.push({ kind: "info", offset: 0 });
      if (file.fail) throw file.fail;
      const c = read(0);
      return c.kind === "data" ? { ...c, bytes: new Uint8Array() } : c;
    },
    chunk: async (_id, offset) => {
      calls.push({ kind: "chunk", offset });
      if (file.fail) throw file.fail;
      return read(offset);
    },
  };
  return {
    file,
    calls,
    source,
    append(text: string) {
      file.bytes = Uint8Array.from([...file.bytes, ...enc.encode(text)]);
    },
  };
}

const text = (f: LogFollower) => f.buffer.plainText();

describe("LogFollower: following a live run", () => {
  test("reads the first bytes, then only the new ones", async () => {
    const log = fakeLog("one\ntwo\n");
    const f = new LogFollower("r", log.source);
    let r = await f.step(true);
    expect(r).toEqual({ delayMs: DEFAULT_LIMITS.pollMs, changed: true });
    expect(text(f)).toBe("one\ntwo");

    log.append("three\n");
    r = await f.step(true);
    expect(r.changed).toBe(true);
    expect(text(f)).toBe("one\ntwo\nthree");
    // The second read asked for the bytes after the first 8, not for everything again.
    const chunkOffsets = log.calls.filter((c) => c.kind === "chunk").map((c) => c.offset);
    expect(chunkOffsets).toEqual([0, 8]);
  });

  test("an unchanged poll reports no change", async () => {
    const log = fakeLog("a\n");
    const f = new LogFollower("r", log.source);
    await f.step(true);
    const r = await f.step(true);
    expect(r.changed).toBe(false);
    expect(r.delayMs).toBe(DEFAULT_LIMITS.pollMs);
  });

  test("stops polling once the server says the run is over", async () => {
    const log = fakeLog("done\n", "succeeded");
    const f = new LogFollower("r", log.source);
    const r = await f.step(true);
    expect(r.delayMs).toBeNull();
    expect(text(f)).toBe("done");
  });

  test("stops when the caller says the run is over, after one final read", async () => {
    const log = fakeLog("x\n", "running");
    const f = new LogFollower("r", log.source);
    await f.step(true);
    log.append("last words\n");
    const r = await f.step(false);
    expect(r.delayMs).toBeNull();
    expect(text(f)).toContain("last words");
  });

  test("a multi-byte character split across two reads is not garbled", async () => {
    const log = fakeLog("");
    const f = new LogFollower("r", log.source);
    const euro = new TextEncoder().encode("€"); // 3 bytes
    log.file.bytes = Uint8Array.from([...new TextEncoder().encode("a"), euro[0]!]);
    await f.step(true);
    log.file.bytes = Uint8Array.from([...log.file.bytes, euro[1]!, euro[2]!, 10]);
    await f.step(true);
    expect(text(f)).toBe("a€");
  });

  test("a stale poll (a newer one took over) changes nothing", async () => {
    const log = fakeLog("hello\n");
    const f = new LogFollower("r", log.source);
    const r = await f.step(true, () => true);
    expect(r).toEqual({ delayMs: null, changed: false });
    expect(f.buffer.isEmpty).toBe(true);
    // The next real poll still starts from the beginning, so nothing is lost or doubled.
    await f.step(true);
    expect(text(f)).toBe("hello");
  });
});

describe("LogFollower: runs without a log", () => {
  test("a queued run is a calm notice, and polling continues", async () => {
    const log = fakeLog("", "queued");
    log.file.exists = false;
    const f = new LogFollower("r", log.source);
    const r = await f.step(true);
    expect(f.notice).toEqual({ kind: "none", reason: "no_log" });
    expect(r.delayMs).not.toBeNull();
    expect(r.changed).toBe(true);
    // Same notice again: nothing to re-render.
    expect((await f.step(true)).changed).toBe(false);
  });

  test("a skipped run stops polling", async () => {
    const log = fakeLog("", "skipped");
    log.file.exists = false;
    const f = new LogFollower("r", log.source);
    const r = await f.step(false);
    expect(r.delayMs).toBeNull();
    expect(f.notice?.kind).toBe("none");
  });

  test("queued and skipped runs show the notice without asking the server", async () => {
    const log = fakeLog("", "queued");
    const f = new LogFollower("r", log.source);
    expect(f.noLogExpected()).toBe(true);
    expect(f.notice).toEqual({ kind: "none", reason: "no_log" });
    expect(f.noLogExpected()).toBe(false);
    expect(log.calls).toEqual([]);
    // Once the run starts, the same follower reads the real log and clears the notice.
    log.append("hi\n");
    log.file.state = "running";
    await f.step(true);
    expect(f.notice).toBeNull();
    expect(text(f)).toBe("hi");
  });

  test("the log appearing clears the notice", async () => {
    const log = fakeLog("", "queued");
    log.file.exists = false;
    const f = new LogFollower("r", log.source);
    await f.step(true);
    log.file.exists = true;
    log.append("started\n");
    log.file.state = "running";
    await f.step(true);
    expect(f.notice).toBeNull();
    expect(text(f)).toBe("started");
  });
});

describe("LogFollower: errors", () => {
  test("a network error retries with growing delays", async () => {
    const log = fakeLog("x\n");
    log.file.fail = new ApiError(0, null);
    const f = new LogFollower("r", log.source);
    const first = await f.step(true);
    const second = await f.step(true);
    expect(f.notice).toMatchObject({ kind: "error", retrying: true });
    expect(first.delayMs).toBe(2000);
    expect(second.delayMs).toBe(4000);
    // And it recovers.
    log.file.fail = null;
    await f.step(true);
    expect(f.notice).toBeNull();
    expect(text(f)).toBe("x");
  });

  test("the delay is capped", async () => {
    const log = fakeLog("");
    log.file.fail = new ApiError(503, { error: "not_ready" });
    const f = new LogFollower("r", log.source);
    let last: number | null = 0;
    for (let i = 0; i < 8; i++) last = (await f.step(true)).delayMs;
    expect(last).toBe(10_000);
  });

  test("a 4xx is not retried", async () => {
    const log = fakeLog("");
    log.file.fail = new ApiError(400, { error: "invalid_run_id" });
    const f = new LogFollower("r", log.source);
    const r = await f.step(true);
    expect(r.delayMs).toBeNull();
    expect(f.notice).toMatchObject({ kind: "error", retrying: false });
  });
});

describe("LogFollower: large logs", () => {
  const small = { ...DEFAULT_LIMITS, largeBytes: 100, tailBytes: 40, keepChars: 10_000, fullMaxBytes: 10_000 };
  const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")}`).join("\n") + "\n";

  test("opens a large log at its end, starting on a whole line", async () => {
    const log = fakeLog(lines, "succeeded");
    const f = new LogFollower("r", log.source, small);
    await f.step(false);
    expect(f.tailStart).toBeGreaterThan(0);
    expect(f.cutAtTop).toBe(true);
    const shown = f.buffer.lines.map((l) => l.text);
    expect(shown.at(-1)).toBe("line 29");
    // No half line at the top: every shown line is a complete "line NN".
    for (const l of shown) expect(l).toMatch(/^line \d\d$/);
    expect(shown.length).toBeLessThan(30);
    expect(f.canLoadFull).toBe(true);
    expect(log.calls.find((c) => c.kind === "chunk")!.offset).toBe(lines.length - 40);
  });

  test("a small log is read from the start", async () => {
    const log = fakeLog("tiny\n", "succeeded");
    const f = new LogFollower("r", log.source, small);
    await f.step(false);
    expect(f.tailStart).toBe(0);
    expect(f.cutAtTop).toBe(false);
  });

  test("Load full log reads everything from the start", async () => {
    const log = fakeLog(lines, "succeeded");
    const f = new LogFollower("r", log.source, small);
    await f.step(false);
    f.loadFull();
    await f.step(false);
    expect(f.buffer.lines).toHaveLength(30);
    expect(f.buffer.lines[0]!.text).toBe("line 00");
    expect(f.cutAtTop).toBe(false);
  });

  test("a log past the page budget cannot be loaded in full", async () => {
    const log = fakeLog(lines, "succeeded");
    const f = new LogFollower("r", log.source, { ...small, fullMaxBytes: 50 });
    await f.step(false);
    expect(f.canLoadFull).toBe(false);
  });

  test("while following, old lines are dropped past the cap and counted", async () => {
    const log = fakeLog("");
    const f = new LogFollower("r", log.source, { ...small, keepChars: 60 });
    for (let i = 0; i < 20; i++) {
      log.append(`tick number ${i}\n`);
      await f.step(true);
    }
    expect(f.buffer.dropped).toBeGreaterThan(0);
    expect(f.cutAtTop).toBe(true);
    expect(f.buffer.lines.at(-1)!.text).toBe("tick number 19");
  });

  test("a log trimmed at the top while following can still be loaded in full when it fits the page budget", async () => {
    const log = fakeLog("");
    const f = new LogFollower("r", log.source, { ...small, keepChars: 60, fullMaxBytes: 100_000 });
    for (let i = 0; i < 20; i++) {
      log.append(`tick number ${i}\n`);
      await f.step(true);
    }
    expect(f.tailStart).toBe(0);
    expect(f.cutAtTop).toBe(true);
    expect(f.canLoadFull).toBe(true);
    f.loadFull();
    await f.step(true);
    expect(f.buffer.lines[0]!.text).toBe("tick number 0");
    expect(f.cutAtTop).toBe(false);
  });

  test("a trimmed log that is over the page budget offers no full load", async () => {
    const log = fakeLog("");
    const f = new LogFollower("r", log.source, { ...small, keepChars: 60, fullMaxBytes: 50 });
    for (let i = 0; i < 20; i++) {
      log.append(`tick number ${i}\n`);
      await f.step(true);
    }
    expect(f.cutAtTop).toBe(true);
    expect(f.canLoadFull).toBe(false);
  });

  test("one huge poll shows only its end, from a line start", async () => {
    const log = fakeLog("");
    const f = new LogFollower("r", log.source, { ...small, maxPollBytes: 200, keepChars: 100 });
    log.append(lines.repeat(5));
    await f.step(true);
    const shown = f.buffer.lines.map((l) => l.text);
    expect(shown.length).toBeGreaterThan(0);
    for (const l of shown) expect(l).toMatch(/^line \d\d$/);
  });
});

describe("LogFollower: truncation", () => {
  test("a log that shrinks is re-read from the start", async () => {
    const log = fakeLog("a long first version of the log\n");
    const f = new LogFollower("r", log.source);
    await f.step(true);
    log.file.bytes = new TextEncoder().encode("new\n");
    const reset = await f.step(true);
    expect(reset.delayMs).toBe(0);
    expect(f.buffer.isEmpty).toBe(true);
    await f.step(true);
    expect(text(f)).toBe("new");
  });
});

describe("LogFollower: colors survive the trip", () => {
  test("ANSI in the stream ends up as styled segments", async () => {
    const log = fakeLog("\x1b[31mred\x1b[0m ok\n", "succeeded");
    const f = new LogFollower("r", log.source);
    await f.step(false);
    expect(f.buffer.lines[0]!.segments[0]).toMatchObject({ text: "red", fg: 1 });
    expect(text(f)).toBe("red ok");
  });
});
