import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { LogCapture, redactBuffer, type Secret } from "../supervisor/log-capture.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "logcap-redact-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function capture(maxBytes: number, secrets: Secret[]) {
  const path = join(tmp, "out.log");
  return { cap: new LogCapture({ filePath: path, maxBytes, secrets: () => secrets }), path };
}

const KEY: Secret = { name: "KEY", value: "sk-live-abcdef123456" };

describe("redaction across chunk boundaries", () => {
  test("a secret split across two writes is redacted", async () => {
    const { cap, path } = capture(4096, [KEY]);
    await cap.write("token=sk-live-abc");
    await cap.write("def123456 end\n");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("token=[redacted:KEY] end\n");
  });

  test("a secret dribbled one byte at a time is redacted", async () => {
    const { cap, path } = capture(4096, [KEY]);
    for (const ch of `a ${KEY.value} b`) await cap.write(ch);
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("a [redacted:KEY] b");
  });

  test("text that merely looks like the start of a secret is passed through, in order", async () => {
    const { cap, path } = capture(4096, [KEY]);
    await cap.write("sk-live-abc"); // held back (could be the start)
    await cap.write("XYZ and more\n"); // ...but turns out not to be
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("sk-live-abcXYZ and more\n");
  });

  test("bytes held back at the very end are flushed by close()", async () => {
    const { cap, path } = capture(4096, [KEY]);
    await cap.write("start sk-live-ab");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("start sk-live-ab");
  });

  test("output is not delayed when it cannot be the start of a secret", async () => {
    const { cap } = capture(4096, [KEY]);
    await cap.write("plain line\n");
    expect(cap.bytesWritten()).toBe("plain line\n".length);
    await cap.close();
  });

  test("several secrets, including one that is a prefix of another, longest wins", async () => {
    const { cap, path } = capture(4096, [
      { name: "SHORT", value: "abcd" },
      { name: "LONG", value: "abcd-efgh" },
    ]);
    await cap.write("x abcd-ef");
    await cap.write("gh y abcd z");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("x [redacted:LONG] y [redacted:SHORT] z");
  });

  test("a secret picked up after rotation is honoured on the next chunk", async () => {
    let secrets: Secret[] = [];
    const path = join(tmp, "rot.log");
    const cap = new LogCapture({ filePath: path, maxBytes: 4096, secrets: () => secrets });
    await cap.write("before hunter2hunter2\n");
    secrets = [{ name: "NEW", value: "hunter2hunter2" }];
    await cap.write("after hunter2hunter2\n");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("before hunter2hunter2\nafter [redacted:NEW]\n");
  });
});

describe("chunking never changes the result", () => {
  test("random chunkings of random text equal redacting the whole buffer at once", async () => {
    // Small alphabet so secrets, near-misses and overlaps occur constantly.
    const secrets: Secret[] = [
      { name: "A", value: "abab" },
      { name: "B", value: "ababc" },
      { name: "C", value: "bcbcbc" },
      { name: "D", value: "cab-é" },
    ];
    const alphabet = ["a", "b", "c", "-", "é", " "];
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 300; round++) {
      let text = "";
      for (let i = 0, n = 20 + Math.floor(rand() * 60); i < n; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
      const bytes = Buffer.from(text, "utf8");
      const expected = redactBuffer(bytes, secrets).toString("utf8");

      const path = join(tmp, `fuzz-${round}.log`);
      const cap = new LogCapture({ filePath: path, maxBytes: 1 << 20, secrets: () => secrets });
      for (let at = 0; at < bytes.length; ) {
        const len = 1 + Math.floor(rand() * 7);
        await cap.write(bytes.subarray(at, at + len));
        at += len;
      }
      await cap.close();
      expect(readFileSync(path, "utf8")).toBe(expected);
    }
  });
});

describe("non-ASCII secrets", () => {
  const RU: Secret = { name: "RU", value: "пароль-секрет" };
  const JP: Secret = { name: "JP", value: "秘密のキー🔑" };

  test("redactBuffer matches on UTF-8 bytes", () => {
    const out = redactBuffer(Buffer.from("x пароль-секрет y 秘密のキー🔑 z", "utf8"), [RU, JP]);
    expect(out.toString("utf8")).toBe("x [redacted:RU] y [redacted:JP] z");
  });

  test("a multibyte secret split in the middle of a character is still redacted", async () => {
    const { cap, path } = capture(4096, [RU, JP]);
    const bytes = Buffer.from("k=秘密のキー🔑;\n", "utf8");
    const cut = bytes.indexOf(Buffer.from("キ", "utf8")) + 1; // inside a 3-byte char
    await cap.write(bytes.subarray(0, cut));
    await cap.write(bytes.subarray(cut));
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("k=[redacted:JP];\n");
  });

  test("non-secret non-ASCII output survives byte-for-byte", async () => {
    const { cap, path } = capture(4096, [RU]);
    await cap.write("héllo wörld — 日本語\n");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("héllo wörld — 日本語\n");
  });
});

describe("stdout and stderr are tracked independently", () => {
  test("bytes from one stream never complete a secret begun on the other", async () => {
    const { cap, path } = capture(4096, [KEY]);
    await cap.write("sk-live-abc", "stdout");
    await cap.write("def123456\n", "stderr"); // must not join with the stdout half
    await cap.close();
    const text = readFileSync(path, "utf8");
    expect(text).toContain("def123456\n");
    expect(text).toContain("sk-live-abc");
    expect(text).not.toContain("[redacted:KEY]");
  });

  test("each stream redacts its own split secrets with the same secret set", async () => {
    const { cap, path } = capture(4096, [KEY]);
    await cap.write("out sk-live-", "stdout");
    await cap.write("err sk-live-abcdef123456\n", "stderr");
    await cap.write("abcdef123456 out\n", "stdout");
    await cap.close();
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("abcdef123456");
    expect(text.match(/\[redacted:KEY\]/g)?.length).toBe(2);
  });
});

describe("truncation cap", () => {
  test("a secret straddling the cap is replaced by its token, never written in part", async () => {
    const secret: Secret = { name: "K", value: "SUPERSECRETVALUE" };
    const { cap, path } = capture(12, [secret]);
    await cap.write("xxxxxxSUPER");
    await cap.write("SECRETVALUE tail");
    await cap.close();
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("SUPER");
    expect(text).not.toContain("SECRET");
    expect(text.startsWith("xxxxxx[redac")).toBe(true);
    expect(text).toContain("[truncated:");
    expect(cap.truncated()).toBe(true);
  });

  test("a secret that would begin after the cap is never written and bytes are still counted", async () => {
    const { cap, path } = capture(5, [KEY]);
    await cap.write("12345");
    await cap.write(`more ${KEY.value}`);
    await cap.close();
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("12345")).toBe(true);
    expect(text).not.toContain("abcdef");
    expect(cap.bytesWritten()).toBe(5);
  });
});

describe("short secrets", () => {
  test("values under 4 characters are not redacted (documented minimum)", async () => {
    const { cap, path } = capture(4096, [{ name: "PIN", value: "123" }, { name: "EMPTY", value: "" }]);
    await cap.write("pin 123 ok\n");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("pin 123 ok\n");
  });

  test("the minimum counts characters, not bytes", async () => {
    // 4 CJK characters = 12 bytes: eligible. 3 characters = 9 bytes: not.
    const { cap, path } = capture(4096, [
      { name: "FOUR", value: "秘密秘密" },
      { name: "THREE", value: "秘密鍵" },
    ]);
    await cap.write("a 秘密秘密 b 秘密鍵 c");
    await cap.close();
    expect(readFileSync(path, "utf8")).toBe("a [redacted:FOUR] b 秘密鍵 c");
  });
});

describe("file modes", () => {
  test("creates directories 0700 and the file 0600", async () => {
    const path = join(tmp, "a", "b", "c", "out.log");
    const cap = new LogCapture({ filePath: path, maxBytes: 100, secrets: () => [] });
    await cap.write("x");
    await cap.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const dir of ["a", "a/b", "a/b/c"]) {
      expect(statSync(join(tmp, dir)).mode & 0o777).toBe(0o700);
    }
  });

  test("dirRoot tightens directories that already existed with looser modes", async () => {
    const root = join(tmp, "runs");
    mkdirSync(join(root, "2026", "01"), { recursive: true });
    chmodSync(root, 0o755);
    chmodSync(join(root, "2026"), 0o755);
    chmodSync(join(root, "2026", "01"), 0o755);
    const path = join(root, "2026", "01", "02", "out.log");
    const cap = new LogCapture({ filePath: path, maxBytes: 100, secrets: () => [], dirRoot: root });
    await cap.close();
    for (const dir of ["runs", "runs/2026", "runs/2026/01", "runs/2026/01/02"]) {
      expect(statSync(join(tmp, dir)).mode & 0o777).toBe(0o700);
    }
    // Directories above the root are left alone.
    expect(statSync(tmp).mode & 0o777).toBe(0o700); // mkdtemp default, not touched by us
  });

  test("an existing log file is re-tightened to 0600", async () => {
    const path = join(tmp, "old.log");
    await Bun.write(path, "old");
    chmodSync(path, 0o644);
    const cap = new LogCapture({ filePath: path, maxBytes: 100, secrets: () => [] });
    await cap.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
