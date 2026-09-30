import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Files shipped by the package: supervisor code, migrations, and the built UI. */
export const PACKAGE_ROOT = HERE;

// A bad environment must not crash on import: `auto --version` and `--help`
// have to work, and the entry points report the problem as one clean line
// (see ENV_PROBLEM). The values below are then placeholders that nothing may act on.
const problems: string[] = [];

function homeDirectory(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    problems.push("HOME (or USERPROFILE) is not set; set it, or set AUTO_HOME to your workspace");
    return process.cwd();
  }
  return home;
}

function defaultWorkspaceRoot(): string {
  return resolve(homeDirectory(), ".auto");
}

export const WORKSPACE_ROOT = resolve(process.env.AUTO_HOME || defaultWorkspaceRoot());
export const DATA_DIR = resolve(process.env.AUTO_DATA_DIR || resolve(WORKSPACE_ROOT, "data"));
export const STATE_DIR = resolve(DATA_DIR, "state");
export const DB_PATH = resolve(DATA_DIR, "automations.db");

/** Names Auto itself creates at the top of a data directory (files match by name or prefix, e.g. `automations.db-wal`). */
const DATA_FILE_PREFIXES = ["automations.db", ".token", "secrets.json", "supervisor.lock", "migration-error.log"];
const DATA_SUBDIRS = ["runs", "payloads", "state"];

/** Is `name` (a direct child of a data directory) something Auto created? */
export function isAutoDataEntry(name: string): boolean {
  return DATA_SUBDIRS.includes(name) || DATA_FILE_PREFIXES.some((p) => name === p || name.startsWith(p));
}

export function resolveConfigPath(): string {
  if (process.env.AUTO_CONFIG) return resolve(process.env.AUTO_CONFIG);
  return resolve(WORKSPACE_ROOT, "auto.config.ts");
}

export const CONFIG_PATH = resolveConfigPath();
export const UI_DIST_DIR = resolve(PACKAGE_ROOT, "ui", "dist");
export const MIGRATIONS_DIR = resolve(PACKAGE_ROOT, "supervisor", "db", "migrations");

function configuredPort(): number {
  const raw = process.env.AUTO_PORT;
  if (!raw) return 7777;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`AUTO_PORT must be an integer from 1 to 65535, got ${raw}`);
    return 7777;
  }
  return port;
}

export const AUTO_PORT = configuredPort();
export const AUTO_BASE_URL = process.env.AUTO_BASE_URL || `http://127.0.0.1:${AUTO_PORT}`;

/**
 * Set when the environment cannot be used (HOME missing, AUTO_PORT invalid).
 * Entry points must stop with this message before touching anything; the
 * exported paths and port are placeholders in that case.
 */
export const ENV_PROBLEM: string | null = problems.length > 0 ? problems.join("; ") : null;
