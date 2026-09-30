import { describe, expect, test } from "bun:test";
import { devServerExposed, isLoopbackHostHeader } from "../ui/dev-host.ts";
import { DEFAULT_LIMITS, LogFollower } from "../ui/src/util/logFollower.ts";
import type { LogSource } from "../ui/src/util/logFollower.ts";
import { ApiError, staleAction } from "../ui/src/util/errors.ts";
import { MAX_TIMER_MS, expiryDelayMs, nextPauseExpiry } from "../ui/src/util/pause.ts";
import { shellWord } from "../ui/src/util/shell.ts";
import { statusHealth } from "../ui/src/util/statusHealth.ts";

type Chunk = Awaited<ReturnType<LogSource["chunk"]>>;

/** A fake log endpoint over a byte string. */
function fakeLog(initial: string, state = "succeeded") {
  const enc = new TextEncoder();
  const file = { bytes: enc.encode(initial), state };
  const read = (offset: number): Chunk =>
    offset > file.bytes.length
      ? { kind: "reset", size: file.bytes.length, state: file.state }
      : { kind: "data", bytes: file.bytes.slice(offset), size: file.bytes.length, state: file.state };
  const source: LogSource = {
    info: async () => {
      const c = read(0);
      return c.kind === "data" ? { ...c, bytes: new Uint8Array() } : c;
    },
    chunk: async (_id, offset) => read(offset),
  };
  return { file, source, append: (t: string) => { file.bytes = Uint8Array.from([...file.bytes, ...enc.encode(t)]); } };
}

const lineText = (n: number) => `line ${String(n).padStart(5, "0")} ${"x".repeat(30)}\n`;

describe("Load full log keeps a log that is larger than one poll", () => {
  // Same shape as the real limits (largeBytes < maxPollBytes < fullMaxBytes), scaled down.
  const limits = { ...DEFAULT_LIMITS, largeBytes: 1_000, tailBytes: 400, keepChars: 2_000, maxPollBytes: 4_000, fullMaxBytes: 20_000, pollMs: 10 };
  const text = Array.from({ length: 200 }, (_, i) => lineText(i)).join(""); // ~8 KB: between maxPollBytes and fullMaxBytes

  test("everything is shown, from the first line, and no truncation note remains", async () => {
    const log = fakeLog(text);
    const f = new LogFollower("r", log.source, limits);
    await f.step(false);
    expect(f.cutAtTop).toBe(true);
    expect(f.canLoadFull).toBe(true);

    f.loadFull();
    await f.step(false);
    expect(f.buffer.lines).toHaveLength(200);
    expect(f.buffer.lines[0]!.text.startsWith("line 00000")).toBe(true);
    expect(f.buffer.lines.at(-1)!.text.startsWith("line 00199")).toBe(true);
    expect(f.buffer.dropped).toBe(0);
    expect(f.cutAtTop).toBe(false);
  });
});

describe("a poll that returns more than the view can use", () => {
  const limits = { ...DEFAULT_LIMITS, largeBytes: 100_000, tailBytes: 400, keepChars: 500, maxPollBytes: 1_000, fullMaxBytes: 50_000, pollMs: 10 };

  test("does not silently discard what is on screen: the view says it starts mid-log and offers the full log", async () => {
    const log = fakeLog("");
    const f = new LogFollower("r", log.source, limits);
    log.append(lineText(0));
    await f.step(true);
    expect(f.cutAtTop).toBe(false);
    expect(f.buffer.lines).toHaveLength(1);

    // A backgrounded tab: 3 KB of new output arrives between two polls.
    log.file.state = "running";
    log.append(Array.from({ length: 100 }, (_, i) => lineText(i + 1)).join(""));
    await f.step(true);

    expect(f.cutAtTop).toBe(true); // before: buffer.clear() reset the counters and the note vanished
    expect(f.tailStart).toBeGreaterThan(0);
    expect(f.canLoadFull).toBe(true);
    expect(f.buffer.lines.at(-1)!.text.startsWith("line 00100")).toBe(true);
    for (const l of f.buffer.lines) expect(l.text).toMatch(/^line \d{5} x+$/); // starts on a whole line
  });
});

describe("pause expiry", () => {
  test("nextPauseExpiry picks the soonest end that is still ahead", () => {
    expect(nextPauseExpiry([null, undefined], 100)).toBeNull();
    expect(nextPauseExpiry([50, 100], 100)).toBeNull();
    expect(nextPauseExpiry([500, 200, null, 50], 100)).toBe(200);
    expect(nextPauseExpiry(new Set([300]), 100)).toBe(300);
  });

  test("expiryDelayMs pads a little, never goes negative and never overflows a timer", () => {
    expect(expiryDelayMs(1_000, 400)).toBe(600 + 300);
    expect(expiryDelayMs(1_000, 5_000)).toBe(300);
    expect(expiryDelayMs(Date.now() + 365 * 24 * 3600_000, Date.now())).toBe(MAX_TIMER_MS);
  });
});

describe("shellWord", () => {
  test("plain names stay bare", () => {
    expect(shellWord("weekly-report")).toBe("weekly-report");
    expect(shellWord("job_1.v2")).toBe("job_1.v2");
  });
  test("spaces, non-ASCII, quotes and a leading dash are quoted so the shell sees one argument", () => {
    expect(shellWord("my report é")).toBe("'my report é'");
    expect(shellWord("O'Brien")).toBe(`'O'\\''Brien'`);
    expect(shellWord("-rf")).toBe("'-rf'");
    expect(shellWord("a;b")).toBe("'a;b'");
  });
  test("what it prints round-trips through a real shell", async () => {
    for (const name of ["my report é", "O'Brien", "a b  c", "$(echo hi)"]) {
      const out = Bun.spawnSync(["sh", "-c", `printf '%s' ${shellWord(name)}`], { stdout: "pipe" }).stdout.toString();
      expect(out).toBe(name);
    }
  });
});

describe("statusHealth", () => {
  const good = { ok: true, degraded: { active: false, reason: null }, warnings: [] };
  const base = { data: good, issue: null, refreshFailed: false, connectionDown: false };

  test("current data maps to ok / warn / bad", () => {
    expect(statusHealth(base)).toBe("ok");
    expect(statusHealth({ ...base, data: { ...good, warnings: [{ code: "x", job: "a", trigger_id: "a", message: "m" }] } })).toBe("warn");
    expect(statusHealth({ ...base, data: { ...good, ok: false } })).toBe("warn");
    expect(statusHealth({ ...base, data: { ...good, degraded: { active: true, reason: null } } })).toBe("bad");
  });

  test("a failing refresh or a dead event stream is unknown, not a stale healthy", () => {
    expect(statusHealth({ ...base, refreshFailed: true })).toBe("unknown");
    expect(statusHealth({ ...base, connectionDown: true })).toBe("unknown");
    expect(statusHealth({ ...base, data: undefined })).toBe("unknown");
  });
});

describe("staleAction", () => {
  test("a token change offers Reload, never a retry that cannot succeed", () => {
    expect(staleAction(new ApiError(401, null), "open")).toBe("reload");
  });
  test("while the connection bar already offers a button, the warning offers none", () => {
    expect(staleAction(new ApiError(0, null), "retrying")).toBe("none");
    expect(staleAction(new ApiError(401, null), "unauthorized")).toBe("none");
  });
  test("otherwise Retry", () => {
    expect(staleAction(new ApiError(500, null), "open")).toBe("retry");
    expect(staleAction(new ApiError(0, null), "connecting")).toBe("retry");
  });
});

describe("dev server host checks", () => {
  test("only loopback Host headers are served", () => {
    for (const ok of ["127.0.0.1:5173", "localhost:5173", "[::1]:5173", "app.localhost:5173", "LOCALHOST", "127.0.0.1"]) {
      expect(isLoopbackHostHeader(ok)).toBe(true);
    }
    for (const bad of ["192.168.1.50:5173", "evil.example", "10.0.0.1", "127.0.0.1.evil.example:5173", undefined, ""]) {
      expect(isLoopbackHostHeader(bad)).toBe(false);
    }
  });

  test("server.host beyond loopback marks the dev server as exposed", () => {
    expect(devServerExposed(undefined)).toBe(false);
    expect(devServerExposed("127.0.0.1")).toBe(false);
    expect(devServerExposed("localhost")).toBe(false);
    expect(devServerExposed(true)).toBe(true);
    expect(devServerExposed("0.0.0.0")).toBe(true);
    expect(devServerExposed("192.168.1.50")).toBe(true);
  });
});
