import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export { DATA_DIR, DB_PATH, STATE_DIR } from "../../paths.ts";
import { DATA_DIR, DB_PATH, isAutoDataEntry } from "../../paths.ts";

/** How long a writer waits on a locked database before SQLITE_BUSY surfaces. */
export const BUSY_TIMEOUT_MS = 5_000;

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort (not the owner, unsupported filesystem, Windows)
  }
}

/** Roots whose own mode must stay as found (see `dataDirIsForeign`). */
const leaveModeAlone = new Set<string>();

/** Never chmod `root` itself from `ensurePrivateDir`; its contents are not Auto's. */
export function leaveRootModeAlone(root: string): void {
  leaveModeAlone.add(resolve(root));
}

/**
 * Create `dir` (and parents) with mode 0700. Directories inside DATA_DIR are
 * additionally tightened if they already exist with looser permissions.
 */
export function ensurePrivateDir(dir: string, root: string = DATA_DIR): void {
  const target = resolve(dir);
  const existed = existsSync(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (within(root, target)) {
    const rel = relative(resolve(root), target);
    let current = resolve(root);
    if (!leaveModeAlone.has(current)) tryChmod(current, 0o700);
    for (const part of rel === "" ? [] : rel.split(sep)) {
      current = join(current, part);
      tryChmod(current, 0o700);
    }
  } else if (!existed) {
    tryChmod(target, 0o700);
  }
}

/**
 * True when `dir` exists, has content, and none of it is something Auto
 * created: a mistaken AUTO_DATA_DIR (the workspace, a shared folder). Nothing
 * may rewrite the permissions of such a directory.
 */
export function dataDirIsForeign(dir: string): boolean {
  try {
    const names = readdirSync(dir);
    return names.length > 0 && !names.some(isAutoDataEntry);
  } catch {
    return false;
  }
}

/**
 * Make what Auto keeps under `root` private: the directory itself and the
 * subdirectories Auto owns (`runs/`, `payloads/`, `state/`) become 0700, and
 * every regular file below Auto's own entries 0600. Anything else at the top
 * of `root` is not Auto's and is left alone, and so is a `root` that holds
 * no Auto data at all. Symlinks are never followed. Returns how many entries
 * had to change.
 */
export function hardenTree(root: string): number {
  if (dataDirIsForeign(root)) return 0;
  let changed = 0;
  const harden = (path: string, stat: import("node:fs").Stats): void => {
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o700) {
        tryChmod(path, 0o700);
        changed++;
      }
      walk(path);
    } else if (stat.isFile() && (stat.mode & 0o077) !== 0) {
      tryChmod(path, 0o600);
      changed++;
    }
  };
  const walk = (dir: string, topLevel = false): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (topLevel && !isAutoDataEntry(entry.name)) continue;
      const path = join(dir, entry.name);
      try {
        harden(path, lstatSync(path));
      } catch {
        continue;
      }
    }
  };
  try {
    const top = lstatSync(root);
    if (top.isDirectory() && (top.mode & 0o777) !== 0o700) {
      tryChmod(root, 0o700);
      changed++;
    }
  } catch {
    return 0;
  }
  walk(root, true);
  return changed;
}

export function openDb(path: string = DB_PATH): Database {
  ensurePrivateDir(dirname(path));
  const db = new Database(path);
  // busy_timeout first so the journal-mode switch below also waits on a lock.
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA synchronous = NORMAL;");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) tryChmod(path + suffix, 0o600);
  }
  return db;
}

export function closeDb(db: Database): void {
  db.close();
}
