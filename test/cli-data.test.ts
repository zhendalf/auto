import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { directoryUsage, fmtBytes, unsafeWipeReason } from "../cli/commands/data.ts";
import { makeWorkspace, runAuto, type Workspace } from "./cli-harness.ts";

const made: Workspace[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
function fresh(): Workspace {
  const ws = makeWorkspace(1);
  made.push(ws);
  return ws;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const ws of made.splice(0)) ws.cleanup();
});

/** A data dir with a database holding `runs` rows, a log file and a token. */
function populate(ws: Workspace, runs: number): void {
  mkdirSync(join(ws.data, "runs", "2026", "01"), { recursive: true });
  writeFileSync(join(ws.data, ".token"), "tok");
  writeFileSync(join(ws.data, "secrets.json"), "{}");
  writeFileSync(join(ws.data, "runs", "2026", "01", "a.log"), "x".repeat(2048));
  const db = new Database(join(ws.data, "automations.db"));
  db.run("CREATE TABLE runs (run_id TEXT)");
  for (let i = 0; i < runs; i++) db.run("INSERT INTO runs VALUES (?)", [`r${i}`]);
  db.close();
}

describe("auto data wipe", () => {
  test("shows path, run count and size, asks for the word 'wipe', and refuses without a terminal", async () => {
    const ws = fresh();
    populate(ws, 7);
    const r = await runAuto(ws, ["data", "wipe"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(ws.data);
    expect(r.stdout).toMatch(/runs\s+7 in the run history/);
    expect(r.stdout).toMatch(/on disk\s+\S+ \S+ in \d+ files/);
    expect(r.stdout).toContain("secrets");
    expect(r.stderr).toContain("--yes");
    expect(existsSync(ws.data)).toBe(true);
  });

  test("has no working-directory requirement and no stale phase text", async () => {
    const ws = fresh();
    populate(ws, 1);
    const r = await runAuto(ws, ["data", "wipe"]); // cwd is the repo, not the workspace
    expect(r.stderr).not.toMatch(/cwd|must run from/);
    expect(r.stdout).not.toMatch(/phase/i);
  });

  test("--yes wipes the data directory and leaves the workspace's config and workers", async () => {
    const ws = fresh();
    populate(ws, 3);
    writeFileSync(join(ws.home, "auto.config.ts"), "export default [];\n");
    const r = await runAuto(ws, ["--yes", "data", "wipe"]);
    expect(r.code).toBe(0);
    expect(existsSync(ws.data)).toBe(false);
    expect(existsSync(join(ws.home, "auto.config.ts"))).toBe(true);
    expect(r.stderr).toContain("wiped");
    expect(r.stderr).toContain("auto install");
  });

  test("--json --yes reports what was deleted on stdout", async () => {
    const ws = fresh();
    populate(ws, 2);
    const r = await runAuto(ws, ["--json", "--yes", "data", "wipe"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, path: ws.data, runs: 2 });
  });

  test("--json without --yes is refused, not silently confirmed", async () => {
    const ws = fresh();
    populate(ws, 2);
    const r = await runAuto(ws, ["--json", "data", "wipe"]);
    expect(r.code).toBe(2);
    expect(existsSync(ws.data)).toBe(true);
  });

  test("refuses while the supervisor is running, even with --yes", async () => {
    const ws = fresh();
    populate(ws, 1);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    servers.push(server);
    const r = await runAuto(ws, ["--yes", "data", "wipe", "--base-url", `http://127.0.0.1:${server.port}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("auto svc stop");
    expect(existsSync(ws.data)).toBe(true);
  });

  test("nothing to wipe is not an error", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["--yes", "data", "wipe"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("nothing to wipe");
  });

  test("refuses a data directory that is the home directory or holds the workspace", async () => {
    const ws = fresh();
    mkdirSync(ws.home, { recursive: true });
    // A stand-in home holding things named like Auto's own: if the guard ever
    // regresses, only this throwaway directory is damaged, never the real HOME.
    const fakeHome = join(dirname(ws.home), "fake-home");
    mkdirSync(join(fakeHome, "runs"), { recursive: true });
    writeFileSync(join(fakeHome, ".token"), "decoy");
    writeFileSync(join(fakeHome, "notes.txt"), "decoy");
    for (const dir of [fakeHome, ws.home, resolve(ws.home, "..")]) {
      const r = await runAuto(ws, ["--yes", "data", "wipe"], { env: { HOME: fakeHome, AUTO_DATA_DIR: dir } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing to wipe");
      expect(existsSync(dir)).toBe(true);
    }
    for (const name of ["runs", ".token", "notes.txt"]) expect(existsSync(join(fakeHome, name))).toBe(true);
  });
});

describe("wipe helpers", () => {
  test("unsafeWipeReason", () => {
    expect(unsafeWipeReason("/")).not.toBeNull();
    expect(unsafeWipeReason(homedir())).not.toBeNull();
    expect(unsafeWipeReason(join(homedir(), ".auto", "data"))).toBeNull();
  });

  test("directoryUsage counts bytes and files and tolerates a missing directory", () => {
    const ws = fresh();
    mkdirSync(join(ws.data, "a", "b"), { recursive: true });
    writeFileSync(join(ws.data, "one"), "12345");
    writeFileSync(join(ws.data, "a", "b", "two"), "1234567890");
    expect(directoryUsage(ws.data)).toEqual({ bytes: 15, files: 2 });
    expect(directoryUsage(join(ws.data, "missing"))).toEqual({ bytes: 0, files: 0 });
  });

  test("fmtBytes", () => {
    expect(fmtBytes(12)).toBe("12 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
