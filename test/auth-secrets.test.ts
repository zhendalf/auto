import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SecretStore } from "../supervisor/secrets.ts";

let dir: string;
let path: string;

function write(secrets: Record<string, string>, mode = 0o600): void {
  writeFileSync(path, JSON.stringify({ version: 1, secrets }), { mode });
  chmodSync(path, mode);
}

/** Give the file a distinctive mtime so a rewrite in the same millisecond is still seen as a change. */
let clock = 1_700_000_000;
function bump(): void {
  clock += 10;
  utimesSync(path, clock, clock);
}

const names = (s: SecretStore) => s.redactionValues().map((v) => v.name).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
  path = join(dir, "secrets.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SecretStore", () => {
  test("loads values and exposes them for get() and redaction", () => {
    write({ alpha: "aaaa-1111", beta: "bbbb-2222" });
    const s = new SecretStore(path);
    s.load();
    expect(s.get("alpha")).toBe("aaaa-1111");
    expect(s.get("missing")).toBeNull();
    expect(s.redactionValues()).toEqual([
      { name: "alpha", value: "aaaa-1111" },
      { name: "beta", value: "bbbb-2222" },
    ]);
  });

  test("a missing file is an empty store", () => {
    const s = new SecretStore(path);
    s.load();
    expect(s.redactionValues()).toEqual([]);
  });

  test("load() rejects a file with group/other permission bits", () => {
    write({ a: "aaaa" }, 0o644);
    expect(() => new SecretStore(path).load()).toThrow(/0600/);
  });

  test("load() rejects malformed documents", () => {
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(() => new SecretStore(path).load()).toThrow();
    write({ a: "" });
    expect(() => new SecretStore(path).load()).toThrow();
  });

  test("redactionValues() picks up a secret added after startup, without load()", () => {
    write({ first: "1111-first" });
    const s = new SecretStore(path);
    s.load();
    expect(names(s)).toEqual(["first"]);

    write({ first: "1111-first", second: "2222-second" });
    bump();
    expect(names(s)).toEqual(["first", "second"]);
    expect(s.get("second")).toBe("2222-second");
  });

  test("redactionValues() drops a removed secret and follows an atomic rename", () => {
    write({ a: "aaaa-1", b: "bbbb-2" });
    const s = new SecretStore(path);
    s.load();

    const tmp = path + ".new";
    writeFileSync(tmp, JSON.stringify({ version: 1, secrets: { a: "aaaa-1" } }), { mode: 0o600 });
    renameSync(tmp, path);
    expect(names(s)).toEqual(["a"]);
  });

  test("an unchanged file is served from the cache (identity is size + mtime + inode)", () => {
    write({ a: "aaaa-1" });
    bump();
    const s = new SecretStore(path);
    s.load();
    // Same size, same mtime: the cache must be trusted, not re-parsed.
    const before = statSync(path);
    writeFileSync(path, JSON.stringify({ version: 1, secrets: { a: "bbbb-2" } }), { mode: 0o600 });
    utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);
    expect(s.get("a")).toBe("aaaa-1");
    // A different size is a change.
    write({ a: "bbbb-22" });
    expect(s.get("a")).toBe("bbbb-22");
  });

  test("a half-written file keeps the last good values and never throws from redactionValues()", () => {
    write({ keep: "keep-me-1" });
    const s = new SecretStore(path);
    s.load();
    // A writer that has truncated and not yet finished.
    writeFileSync(path, '{"version":1,"secrets":{"keep":"kee', { mode: 0o600 });
    bump();
    expect(() => s.redactionValues()).not.toThrow();
    expect(names(s)).toEqual(["keep"]);
    expect(() => s.load()).toThrow();
    // The writer finishes.
    write({ keep: "keep-me-1", more: "more-2222" });
    bump();
    expect(names(s)).toEqual(["keep", "more"]);
  });

  test("a file whose mode was loosened keeps redacting with the last good values", () => {
    write({ keep: "keep-me-1" });
    const s = new SecretStore(path);
    s.load();
    chmodSync(path, 0o644);
    expect(names(s)).toEqual(["keep"]);
    expect(() => s.load()).toThrow(/0600/);
    // Once fixed and changed, it reloads.
    write({ keep: "keep-me-1", new: "new-33333" });
    bump();
    expect(names(s)).toEqual(["keep", "new"]);
  });

  test("deleting the file clears the store", () => {
    write({ a: "aaaa-1" });
    const s = new SecretStore(path);
    s.load();
    rmSync(path);
    expect(s.redactionValues()).toEqual([]);
    expect(s.get("a")).toBeNull();
  });
});
