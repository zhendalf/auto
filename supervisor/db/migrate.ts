import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, DATA_DIR, DB_PATH, ensurePrivateDir, openDb, STATE_DIR } from "./connection.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "migrations");
const FILE_RE = /^(\d{4})_(.+)\.sql$/;

type Migration = { version: string; name: string; sql: string };

function discover(): Migration[] {
  const entries = readdirSync(MIGRATIONS_DIR);
  const migrations: Migration[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const match = FILE_RE.exec(entry);
    if (!match) {
      throw new Error(`migration filename does not match ^\\d{4}_.+\\.sql$: ${entry}`);
    }
    const sql = readFileSync(resolve(MIGRATIONS_DIR, entry), "utf8");
    migrations.push({ version: match[1]!, name: match[2]!, sql });
  }
  migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return migrations;
}

function appliedVersions(db: Database): Set<string> {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (!row) return new Set();
  const rows = db
    .query<{ version: string }, []>("SELECT version FROM schema_migrations")
    .all();
  return new Set(rows.map((r) => r.version));
}

/** The database records migrations this build does not ship (newer DB than code). */
export class SchemaTooNewError extends Error {
  constructor(public unknown: string[]) {
    super(
      `database has migrations this build does not know about (${unknown.join(", ")}); ` +
        "it was written by a newer version of Auto. Update Auto instead of downgrading the database.",
    );
    this.name = "SchemaTooNewError";
  }
}

export function knownMigrationVersions(): string[] {
  return discover().map((m) => m.version);
}

/** Applied versions that are missing from this build's migration set. */
export function unknownAppliedVersions(db: Database): string[] {
  const known = new Set(knownMigrationVersions());
  return [...appliedVersions(db)].filter((v) => !known.has(v)).sort();
}

export async function runMigrations(db: Database): Promise<{ applied: string[] }> {
  const all = discover();
  const have = appliedVersions(db);
  const unknown = [...have].filter((v) => !all.some((m) => m.version === v)).sort();
  if (unknown.length > 0) throw new SchemaTooNewError(unknown);
  const pending = all.filter((m) => !have.has(m.version));
  const applied: string[] = [];
  for (const m of pending) {
    const apply = db.transaction((mig: Migration) => {
      db.run(mig.sql);
      db.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(mig.version, mig.name, Date.now());
    });
    apply(m);
    applied.push(m.version);
  }
  return { applied };
}

if (import.meta.main) {
  let db: Database | null = null;
  try {
    db = openDb(DB_PATH);
    const result = await runMigrations(db);
    console.log(JSON.stringify(result));
    closeDb(db);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    try {
      ensurePrivateDir(STATE_DIR);
      writeFileSync(resolve(STATE_DIR, "last-error.txt"), message, { mode: 0o600 });
      writeFileSync(resolve(DATA_DIR, "migration-error.log"), message, { mode: 0o600 });
    } catch {
      // best-effort; the process is already failing
    }
    if (db) {
      try {
        closeDb(db);
      } catch {
        // ignore
      }
    }
    console.error(message);
    process.exit(78);
  }
}
