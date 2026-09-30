import { describe, expect, test } from "bun:test";
import { createSseParser, parseSse } from "../ui/src/util/sseParse.ts";
import type { SseFrame } from "../ui/src/util/sseParse.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

/** Feed `input` in pieces of `size` bytes and return every frame. */
function inPieces(input: string, size: number): SseFrame[] {
  const all = bytes(input);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += size) chunks.push(all.slice(i, i + size));
  return parseSse(chunks);
}

describe("frames", () => {
  test("event and data", () => {
    expect(parseSse(['event: run.finished\ndata: {"a":1}\n\n'])).toEqual([
      { event: "run.finished", data: '{"a":1}' },
    ]);
  });

  test("the event name defaults to message", () => {
    expect(parseSse(["data: hi\n\n"])).toEqual([{ event: "message", data: "hi" }]);
  });

  test("only one leading space after the colon is dropped", () => {
    expect(parseSse(["data:  two\n\n", "data:none\n\n"])).toEqual([
      { event: "message", data: " two" },
      { event: "message", data: "none" },
    ]);
  });

  test("several data lines join with a newline", () => {
    expect(parseSse(["event: x\ndata: one\ndata: two\ndata:\ndata: four\n\n"])).toEqual([
      { event: "x", data: "one\ntwo\n\nfour" },
    ]);
  });

  test("a data field with no colon is an empty data line", () => {
    expect(parseSse(["data\n\n"])).toEqual([{ event: "message", data: "" }]);
  });

  test("a frame with no data line is not dispatched, and does not leak its event name", () => {
    expect(parseSse(["event: run.started\n\n", "data: next\n\n"])).toEqual([
      { event: "message", data: "next" },
    ]);
  });

  test("several frames in one chunk keep their order", () => {
    const frames = parseSse(["event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"]);
    expect(frames.map((f) => f.event)).toEqual(["a", "b"]);
  });

  test("an unfinished frame at the end of the stream is dropped", () => {
    expect(parseSse(["event: a\ndata: 1\n\nevent: b\ndata: 2\n"])).toEqual([{ event: "a", data: "1" }]);
  });
});

describe("comments and ignored fields", () => {
  test("`: connected` and heartbeats produce nothing", () => {
    expect(parseSse([": connected\n\n", ": ping\n\n"])).toEqual([]);
  });

  test("a comment inside a frame does not break it", () => {
    expect(parseSse(["event: a\n: keep-alive\ndata: 1\n\n"])).toEqual([{ event: "a", data: "1" }]);
  });

  test("id and retry are ignored", () => {
    expect(parseSse(["id: 7\nretry: 3000\nevent: a\ndata: 1\n\n"])).toEqual([{ event: "a", data: "1" }]);
  });

  test("unknown fields are ignored", () => {
    expect(parseSse(["foo: bar\ndata: 1\n\n"])).toEqual([{ event: "message", data: "1" }]);
  });
});

describe("line endings", () => {
  test("CRLF", () => {
    expect(parseSse(["event: a\r\ndata: 1\r\n\r\n"])).toEqual([{ event: "a", data: "1" }]);
  });

  test("lone CR", () => {
    expect(parseSse(["event: a\rdata: 1\r\r"])).toEqual([{ event: "a", data: "1" }]);
  });

  test("a CRLF split between the CR and the LF is one line break, not two", () => {
    // If the split produced two breaks, the blank line would dispatch early
    // and `data: 2` would land in a second frame.
    expect(parseSse(["event: a\r", "\ndata: 1\r", "\ndata: 2\r\n\r", "\n"])).toEqual([
      { event: "a", data: "1\n2" },
    ]);
  });

  test("mixed endings in one stream", () => {
    expect(parseSse(["event: a\r\ndata: 1\n\n", "event: b\ndata: 2\r\r"]).map((f) => f.data)).toEqual(["1", "2"]);
  });
});

describe("chunk boundaries", () => {
  const stream =
    ": connected\n\n" +
    'event: run.started\ndata: {"run_id":"r1"}\n\n' +
    ": ping\n\n" +
    "event: run.finished\r\ndata: {\"run_id\":\"r1\",\"state\":\"succeeded\"}\r\n\r\n" +
    "event: config.error\ndata: line one\ndata: line two\n\n";
  const expected: SseFrame[] = [
    { event: "run.started", data: '{"run_id":"r1"}' },
    { event: "run.finished", data: '{"run_id":"r1","state":"succeeded"}' },
    { event: "config.error", data: "line one\nline two" },
  ];

  test("the same frames come out whatever the chunk size", () => {
    for (let size = 1; size <= 12; size++) expect(inPieces(stream, size)).toEqual(expected);
    expect(inPieces(stream, 10_000)).toEqual(expected);
  });

  test("a split can fall in the middle of a field name, value or terminator", () => {
    const parts = ["ev", "ent: run.fin", "ished\nda", "ta: {\"x\"", ":1}\n", "\n"];
    expect(parseSse(parts)).toEqual([{ event: "run.finished", data: '{"x":1}' }]);
  });
});

describe("UTF-8", () => {
  const text = "data: héllo ✓ 日本語 🚀\n\n";

  test("a multi-byte character split across chunks decodes intact, at every split point", () => {
    const all = bytes(text);
    for (let cut = 1; cut < all.length; cut++) {
      const frames = parseSse([all.slice(0, cut), all.slice(cut)]);
      expect(frames).toEqual([{ event: "message", data: "héllo ✓ 日本語 🚀" }]);
    }
  });

  test("one byte at a time", () => {
    expect(inPieces(text, 1)).toEqual([{ event: "message", data: "héllo ✓ 日本語 🚀" }]);
  });

  test("a leading byte order mark is skipped", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = bytes("event: a\ndata: 1\n\n");
    const joined = new Uint8Array(bom.length + body.length);
    joined.set(bom);
    joined.set(body, bom.length);
    expect(parseSse([joined])).toEqual([{ event: "a", data: "1" }]);
  });
});

describe("parser instance", () => {
  test("end() drops a half-read frame and the parser can be reused", () => {
    const seen: SseFrame[] = [];
    const p = createSseParser((f) => seen.push(f));
    p.push("event: a\ndata: half");
    p.end();
    p.push("data: whole\n\n");
    expect(seen).toEqual([{ event: "message", data: "whole" }]);
  });

  test("a large frame is not quadratic in behavior: 20000 lines parse", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `data: ${i}`).join("\n") + "\n\n";
    const out = inPieces(lines, 4096);
    expect(out).toHaveLength(1);
    expect(out[0]?.data.split("\n")).toHaveLength(20_000);
  });
});
