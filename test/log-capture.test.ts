import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { LogCapture, redactBuffer, type Secret } from "../supervisor/log-capture.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "logcap-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeCapture(maxBytes: number, secrets: Secret[] = []): {
  cap: LogCapture;
  path: string;
} {
  const path = join(tmp, "out.log");
  const cap = new LogCapture({
    filePath: path,
    maxBytes,
    secrets: () => secrets,
  });
  return { cap, path };
}

describe("LogCapture", () => {
  test("basic write+close", async () => {
    const { cap, path } = makeCapture(1024);
    await cap.write("hello\n");
    await cap.write("world\n");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("hello\nworld\n");
    expect(cap.bytesWritten()).toBe("hello\nworld\n".length);
    expect(cap.truncated()).toBe(false);
  });

  test("100 sequential writes preserve order", async () => {
    const { cap, path } = makeCapture(1024 * 1024);
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      ps.push(cap.write(`line-${i}\n`));
    }
    await Promise.all(ps);
    await cap.close();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(lines[i]).toBe(`line-${i}`);
    }
  });

  test("cap exceeded — file capped, marker present, truncated()=true", async () => {
    const cap1Mib = 1024 * 1024;
    const { cap, path } = makeCapture(cap1Mib);
    const chunk = Buffer.alloc(64 * 1024, 0x61); // 'a'
    // Write 6 MiB total (96 chunks of 64 KiB).
    for (let i = 0; i < 96; i++) {
      await cap.write(chunk);
    }
    await cap.close();
    const stats = statSync(path);
    // File should be 1 MiB of data + a small marker tail.
    expect(cap.truncated()).toBe(true);
    expect(cap.bytesWritten()).toBe(cap1Mib);
    expect(stats.size).toBeGreaterThan(cap1Mib);
    // Reasonable upper bound on marker size.
    expect(stats.size).toBeLessThan(cap1Mib + 100);
    const tail = readFileSync(path).subarray(cap1Mib).toString("utf8");
    expect(tail).toContain("[truncated:");
    expect(tail).toContain("bytes elided]");
    // Dropped bytes = 6 MiB - 1 MiB = 5 MiB.
    expect(tail).toContain(String(5 * 1024 * 1024));
  });

  test("redaction of single secret", async () => {
    const { cap, path } = makeCapture(1024, [
      { name: "API_KEY", value: "SUPERSECRET" },
    ]);
    await cap.write("hello SUPERSECRET world");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("hello [redacted:API_KEY] world");
  });

  test("multiple secrets, longest-first", async () => {
    const secrets: Secret[] = [
      { name: "A", value: "foo!" },
      { name: "B", value: "foo!bar" },
    ];
    const { cap, path } = makeCapture(1024, secrets);
    await cap.write("xxx foo!bar yyy");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("xxx [redacted:B] yyy");
  });

  test("redactBuffer skips secrets shorter than 4 chars", () => {
    const out = redactBuffer(Buffer.from("hi abc and abcd"), [
      { name: "SHORT", value: "abc" },
      { name: "LONG", value: "abcd" },
    ]);
    expect(out.toString("utf8")).toBe("hi abc and [redacted:LONG]");
  });
});
