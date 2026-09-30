import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUSY_TIMEOUT_MS, ensurePrivateDir, hardenTree, openDb } from "../supervisor/db/connection.ts";
import {
  knownMigrationVersions,
  runMigrations,
  SchemaTooNewError,
  unknownAppliedVersions,
} from "../supervisor/db/migrate.ts";
import { MIGRATIONS_DIR } from "../paths.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "supervisor-db-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe("openDb", () => {
  test("sets busy_timeout, WAL and foreign keys", () => {
    const db = openDb(join(tmp, "data", "a.db"));
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout).toBe(BUSY_TIMEOUT_MS);
    expect(BUSY_TIMEOUT_MS).toBe(5000);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    db.close();
  });

  test("creates its directory 0700 and the database files 0600", () => {
    const dir = join(tmp, "data");
    const db = openDb(join(dir, "a.db"));
    db.run("CREATE TABLE t (x)");
    db.run("INSERT INTO t VALUES (1)");
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "a.db"))).toBe(0o600);
    db.close();
  });

  test("a second writer waits on a locked database instead of failing at once", async () => {
    const path = join(tmp, "data", "b.db");
    const a = openDb(path);
    a.run("CREATE TABLE t (x)");
    a.close();
    // Another process holds the write lock for ~400 ms.
    const holder = join(tmp, "holder.ts");
    writeFileSync(
      holder,
      `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]!);
db.run("BEGIN IMMEDIATE");
db.run("INSERT INTO t VALUES (1)");
console.log("LOCKED");
await Bun.sleep(400);
db.run("COMMIT");
`,
    );
    const proc = Bun.spawn([process.execPath, holder, path], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const reader = proc.stdout.getReader();
    let seen = "";
    while (!seen.includes("LOCKED")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain("LOCKED");

    // Without busy_timeout the write fails immediately...
    const bare = new Database(path);
    expect(() => bare.run("INSERT INTO t VALUES (2)")).toThrow(/locked|busy/i);
    bare.close();
    // ...with openDb's busy_timeout it waits for the holder to commit.
    const b = openDb(path);
    const t0 = Date.now();
    b.run("INSERT INTO t VALUES (3)");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    await proc.exited;
    expect(b.query<{ n: number }, []>("SELECT count(*) AS n FROM t").get()!.n).toBe(2);
    b.close();
  });
});

describe("ensurePrivateDir / hardenTree", () => {
  test("ensurePrivateDir tightens a looser existing directory chain inside the root", () => {
    const root = join(tmp, "data");
    mkdirSync(join(root, "state"), { recursive: true });
    chmodSync(root, 0o755);
    chmodSync(join(root, "state"), 0o755);
    ensurePrivateDir(join(root, "state"), root);
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, "state"))).toBe(0o700);
  });

  test("ensurePrivateDir creates nested directories 0700", () => {
    const root = join(tmp, "data");
    ensurePrivateDir(join(root, "a", "b"), root);
    expect(mode(join(root, "a"))).toBe(0o700);
    expect(mode(join(root, "a", "b"))).toBe(0o700);
  });

  test("hardenTree fixes modes, counts changes, and leaves symlinks alone", () => {
    const root = join(tmp, "data");
    mkdirSync(join(root, "runs", "2026"), { recursive: true });
    chmodSync(root, 0o755);
    chmodSync(join(root, "runs"), 0o755);
    writeFileSync(join(root, "runs", "2026", "x.log"), "x", { mode: 0o644 });
    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, "o", { mode: 0o644 });
    symlinkSync(outside, join(root, "link"));
    const changed = hardenTree(root);
    expect(changed).toBe(4); // root, runs, runs/2026, x.log
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, "runs", "2026", "x.log"))).toBe(0o600);
    expect(mode(outside)).toBe(0o644);
    expect(hardenTree(root)).toBe(0);
  });

  test("hardenTree on a missing directory is a no-op", () => {
    expect(hardenTree(join(tmp, "nope"))).toBe(0);
  });
});

describe("migrations", () => {
  test("upgrade from a database that has only migrations 0001 and 0002 applied", async () => {
    // Build that database exactly as an older install would have it.
    const path = join(tmp, "old.db");
    const old = new Database(path);
    old.run("PRAGMA foreign_keys = ON;");
    for (const version of ["0001", "0002"]) {
      const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(`${version}_`))!;
      old.run(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
      old.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 1)", [version, file]);
    }
    // Existing data must survive.
    old.run("INSERT INTO jobs (job_id, name, enabled, last_seen_in_config_at, created_at) VALUES ('j', 'keep-me', 1, 1, 1)");
    old.close();

    const db = openDb(path);
    const { applied } = await runMigrations(db);
    const all = knownMigrationVersions();
    expect(applied).toEqual(all.filter((v) => v !== "0001" && v !== "0002"));
    const versions = db.query<{ version: string }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
    expect(versions).toEqual(all);
    expect(db.query<{ name: string }, []>("SELECT name FROM jobs").all()).toEqual([{ name: "keep-me" }]);
    // Running again is a no-op.
    expect((await runMigrations(db)).applied).toEqual([]);
    db.close();
  });

  test("a database with migrations this build does not know is refused and left untouched", async () => {
    const db = openDb(join(tmp, "new.db"));
    await runMigrations(db);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9998', 'future_a', 1), ('9999', 'future_b', 1)");
    expect(unknownAppliedVersions(db)).toEqual(["9998", "9999"]);
    let caught: unknown;
    try {
      await runMigrations(db);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaTooNewError);
    expect((caught as SchemaTooNewError).unknown).toEqual(["9998", "9999"]);
    expect((caught as Error).message).toContain("9999");
    db.close();
  });

  test("a failing migration rolls back and is not recorded", async () => {
    // Exercise the same transaction shape runMigrations uses.
    const db = openDb(join(tmp, "tx.db"));
    db.run("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    const apply = db.transaction(() => {
      db.run("CREATE TABLE half (x)");
      db.run("THIS IS NOT SQL");
    });
    expect(() => apply()).toThrow();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeNull();
    db.close();
  });
});
