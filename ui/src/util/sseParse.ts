/**
 * An incremental parser for `text/event-stream`. Pure: bytes (or strings) in,
 * frames out, no DOM. Follows the SSE spec's line rules:
 *
 *  - lines end with LF, CRLF or a lone CR, and a CRLF may be split across
 *    chunks;
 *  - `event:` sets the name, `data:` lines are joined with "\n", one leading
 *    space after the colon is dropped;
 *  - lines starting with ":" (comments, `: connected`, heartbeats), and the
 *    `id` and `retry` fields, are ignored;
 *  - a blank line dispatches the frame, but only if it has at least one
 *    `data:` line; an unfinished frame at end of stream is dropped;
 *  - bytes are decoded as streaming UTF-8, so a multi-byte character may be
 *    split across chunks anywhere; a leading byte order mark is skipped.
 */
export type SseFrame = { event: string; data: string };

export type SseParser = {
  /** Feed the next chunk (bytes from a fetch body, or already-decoded text). */
  push(chunk: Uint8Array | string): void;
  /** The stream ended: forget any unfinished frame and reset for reuse. */
  end(): void;
};

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  let decoder = new TextDecoder("utf-8");
  let partial = ""; // the current line, not yet terminated
  let skipLF = false; // the last chunk ended in CR; drop an LF that opens the next
  let eventName = "";
  let dataLines: string[] = [];

  const line = (l: string): void => {
    if (l === "") {
      if (dataLines.length > 0) {
        onFrame({ event: eventName || "message", data: dataLines.join("\n") });
      }
      eventName = "";
      dataLines = [];
      return;
    }
    if (l.charCodeAt(0) === 58) return; // ":" comment
    const colon = l.indexOf(":");
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? "" : l.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // id, retry and unknown fields are ignored on purpose.
  };

  const feed = (text: string): void => {
    if (text.length === 0) return;
    let start = 0;
    if (skipLF) {
      skipLF = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      line(partial + text.slice(start, i));
      partial = "";
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        else if (i + 1 === text.length) skipLF = true;
      }
      start = i + 1;
    }
    partial += text.slice(start);
  };

  return {
    push(chunk) {
      feed(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      decoder = new TextDecoder("utf-8");
      partial = "";
      skipLF = false;
      eventName = "";
      dataLines = [];
    },
  };
}

/** Convenience for tests and one-shot use: all frames in a list of chunks. */
export function parseSse(chunks: Array<Uint8Array | string>): SseFrame[] {
  const frames: SseFrame[] = [];
  const parser = createSseParser((f) => frames.push(f));
  for (const c of chunks) parser.push(c);
  parser.end();
  return frames;
}
