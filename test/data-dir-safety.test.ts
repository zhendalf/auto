import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirIsForeign, ensurePrivateDir, hardenTree, leaveRootModeAlone } from "../supervisor/db/connection.ts";
import { SecretStore } from "../supervisor/secrets.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "data-dir-safety-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A directory of someone else's files: a script that must stay executable, in a folder that must stay readable. */
function foreignTree(root: string): { tool: string; sub: string } {
  const sub = join(root, "other");
  mkdirSync(sub, { recursive: true });
  const tool = join(sub, "tool.sh");
  writeFileSync(tool, "#!/bin/sh\necho hi\n");
  chmodSync(tool, 0o755);
  chmodSync(sub, 0o755);
  chmodSync(root, 0o755);
  return { tool, sub };
}

describe("a data directory that holds no Auto data", () => {
  test("dataDirIsForeign: content that is not Auto's, but not an empty or missing directory, or one with Auto files", () => {
    const root = join(tmp, "d");
    expect(dataDirIsForeign(root)).toBe(false); // missing
    mkdirSync(root);
    expect(dataDirIsForeign(root)).toBe(false); // empty
    writeFileSync(join(root, "notes.txt"), "x");
    expect(dataDirIsForeign(root)).toBe(true);
    mkdirSync(join(root, "state"));
    expect(dataDirIsForeign(root)).toBe(false); // now it holds Auto's own directory
  });

  test("hardenTree changes nothing in it", () => {
    const root = join(tmp, "foreign");
    const { tool, sub } = foreignTree(root);
    expect(hardenTree(root)).toBe(0);
    expect(mode(tool)).toBe(0o755);
    expect(mode(sub)).toBe(0o755);
    expect(mode(root)).toBe(0o755);
  });

  test("ensurePrivateDir leaves the root's own mode alone once it is marked, but still tightens what is below", () => {
    const root = join(tmp, "marked");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
    leaveRootModeAlone(root);
    ensurePrivateDir(join(root, "state"), root);
    expect(mode(root)).toBe(0o755);
    expect(mode(join(root, "state"))).toBe(0o700);
  });
});

describe("a data directory that holds Auto data", () => {
  test("hardenTree tightens Auto's own entries and leaves everything else at the top alone", () => {
    const root = join(tmp, "data");
    mkdirSync(join(root, "runs", "2026"), { recursive: true });
    writeFileSync(join(root, "runs", "2026", "a.log"), "x", { mode: 0o644 });
    writeFileSync(join(root, "automations.db"), "x", { mode: 0o644 });
    writeFileSync(join(root, "automations.db-wal"), "x", { mode: 0o644 });
    const { tool, sub } = foreignTree(root);
    chmodSync(join(root, "runs"), 0o755);

    hardenTree(root);
    expect(mode(join(root, "runs", "2026", "a.log"))).toBe(0o600);
    expect(mode(join(root, "runs"))).toBe(0o700);
    expect(mode(join(root, "automations.db"))).toBe(0o600);
    expect(mode(join(root, "automations.db-wal"))).toBe(0o600);
    expect(mode(root)).toBe(0o700);
    // The foreign entries, even inside a real data directory, are untouched.
    expect(mode(tool)).toBe(0o755);
    expect(mode(sub)).toBe(0o755);
  });
});

describe("a malformed secrets file", () => {
  const good = JSON.stringify({ version: 1, secrets: { a: "abcdefgh" } });

  test("costs one read until it changes: lookups do not block the event loop", () => {
    const path = join(tmp, "secrets.json");
    writeFileSync(path, '{"version":1,"secrets":{"a":"abcdefgh"', { mode: 0o600 });
    const store = new SecretStore(path);
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) {
      store.redactionValues();
      store.get("a");
    }
    // Each lookup used to sleep ~45 ms while retrying the parse (about 5 s for this loop).
    expect(performance.now() - t0).toBeLessThan(500);
    expect(() => store.load()).toThrow(/not valid JSON/);
  });

  test("is read again as soon as its contents change, and keeps the last good values meanwhile", () => {
    const path = join(tmp, "secrets.json");
    writeFileSync(path, good, { mode: 0o600 });
    const store = new SecretStore(path);
    expect(store.get("a")).toBe("abcdefgh");

    writeFileSync(path, '{"version":1,"secrets":{"a":"abc', { mode: 0o600 });
    expect(store.get("a")).toBe("abcdefgh"); // last good
    expect(store.get("a")).toBe("abcdefgh"); // not re-parsed, still last good

    writeFileSync(path, JSON.stringify({ version: 1, secrets: { a: "abcdefgh", b: "12345678" } }), { mode: 0o600 });
    expect(store.get("b")).toBe("12345678");
  });
});
