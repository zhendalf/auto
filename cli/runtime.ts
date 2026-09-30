import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import pc from "picocolors";
import {
  CONFIG_PATH,
  DATA_DIR,
  DB_PATH,
  STATE_DIR,
  WORKSPACE_ROOT,
} from "../paths.ts";
import { ApiClient, SupervisorUnreachable } from "./client.ts";

// ---------------------------------------------------------------------------
// Repo paths
// ---------------------------------------------------------------------------

export const REPO_ROOT = WORKSPACE_ROOT;
export { CONFIG_PATH, DATA_DIR, DB_PATH, STATE_DIR, WORKSPACE_ROOT };

/** Oldest Bun release Auto supports (see `engines` in package.json). */
export const MIN_BUN_VERSION = "1.3.0";

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EX = {
  OK: 0,
  ERR: 1,
  USAGE: 2,
  UNREACHABLE: 3,
  CONFLICT: 4,
  /** 128 + SIGINT: the user stopped waiting (`auto run` / `auto log --follow`). */
  INTERRUPTED: 130,
} as const;

// ---------------------------------------------------------------------------
// Global flag state (set once by main.ts after commander parse)
// ---------------------------------------------------------------------------

export type Globals = {
  json: boolean;
  noColor: boolean;
  /** `-y/--yes`: answer yes to confirmation prompts. */
  yes: boolean;
  /** `--token-file`: read the API token from this path instead of <data dir>/.token. */
  tokenFile: string | null;
  /** `--base-url`: talk to this supervisor URL instead of the configured one. */
  baseUrl: string | null;
};

const state: { g: Globals } = {
  g: {
    json: false,
    noColor: false,
    yes: false,
    tokenFile: null,
    baseUrl: null,
  },
};

export function setGlobals(g: Partial<Globals>): void {
  state.g = { ...state.g, ...g };
}

export function globals(): Globals {
  return state.g;
}

// ---------------------------------------------------------------------------
// Color helpers (no-op when --no-color, NO_COLOR is set, or the stream is not a TTY)
// ---------------------------------------------------------------------------

/** https://no-color.org: any non-empty NO_COLOR turns color off. */
function noColorEnv(): boolean {
  const v = process.env.NO_COLOR;
  return typeof v === "string" && v.length > 0;
}

/** Color is on only for a terminal, when neither `--no-color` nor NO_COLOR asks for plain text. */
export function colorEnabled(stream: { isTTY?: boolean }): boolean {
  if (state.g.noColor || noColorEnv()) return false;
  return Boolean(stream.isTTY);
}

// picocolors' default instance decides once, from stdout, whether to emit
// escapes; that would ignore the stream a painter is actually for. This
// instance always emits them and colorEnabled(stream) does the deciding.
const colors = pc.createColors(true);

function makePainter(stream: { isTTY?: boolean }) {
  const wrap = (fn: (s: string) => string) => (s: string) => (colorEnabled(stream) ? fn(s) : s);
  return {
    green: wrap(colors.green),
    red: wrap(colors.red),
    yellow: wrap(colors.yellow),
    dim: wrap(colors.dim),
    bold: wrap(colors.bold),
    cyan: wrap(colors.cyan),
  };
}

/** For text written to stdout. */
export const color = makePainter(process.stdout);
/** For text written to stderr (status lines): keyed on stderr being a terminal. */
export const errColor = makePainter(process.stderr);

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

// Writes to a pipe are asynchronous in Bun: calling process.exit() right after a
// large write cuts the output off. Every write here is tracked, and
// flushOutput() waits for all of them before the CLI exits.
const pendingWrites = new Set<Promise<void>>();

function track(stream: NodeJS.WriteStream, text: string): void {
  const done = new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });
  pendingWrites.add(done);
  void done.then(() => pendingWrites.delete(done));
}

/** Resolves once everything written through this module has been handed to the OS (capped, so a stuck pipe cannot hang the exit). */
export async function flushOutput(capMs = 5_000): Promise<void> {
  if (pendingWrites.size === 0) return;
  await Promise.race([
    (async () => {
      while (pendingWrites.size > 0) await Promise.all([...pendingWrites]);
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, capMs).unref?.()),
  ]);
}

let stdoutClosed = false;
let exitWhenStdoutCloses = true;

/**
 * The reader of stdout went away (`auto log | head`). Ordinarily that ends the
 * command quietly with 0. A command whose exit code is a run's result (`auto
 * run`) calls `keepGoingWhenStdoutCloses()` first: output is then dropped and
 * the command carries on to the run's end, so `auto run job | head` still
 * exits 1 when the run fails. Returns true when the caller should exit now.
 */
export function stdoutClosedByReader(): boolean {
  stdoutClosed = true;
  return exitWhenStdoutCloses;
}

export function keepGoingWhenStdoutCloses(): void {
  exitWhenStdoutCloses = false;
}

/** Write text to stdout exactly as given. */
export function writeOut(text: string): void {
  if (stdoutClosed) return;
  track(process.stdout, text);
}

/** Write text to stderr exactly as given. */
export function writeErr(text: string): void {
  track(process.stderr, text);
}

/** Write a status / progress / error line to stderr. Never goes to stdout. */
export function status(line: string): void {
  writeErr(line.endsWith("\n") ? line : line + "\n");
}

/** Print a data line to stdout. Suppressed by callers when in --json mode. */
export function println(line: string): void {
  writeOut(line.endsWith("\n") ? line : line + "\n");
}

/** Emit JSON to stdout (compact). */
export function printJson(value: unknown): void {
  writeOut(JSON.stringify(value) + "\n");
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Open the supervisor DB read-only. Returns null if it doesn't exist. */
export function openDbReadOnly(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true, create: false });
}

// ---------------------------------------------------------------------------
// TTY / prompt helpers
// ---------------------------------------------------------------------------

export function isStdinTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Ask an interactive question. The prompt is drawn on stderr, not stdout:
 * stdout is data (and, with `--json`, JSON only), so a prompt on it would
 * corrupt `| jq`. Colors follow the same rule as the status lines (only for a
 * terminal, never with `--no-color` or NO_COLOR); the prompt library decides
 * once, when it is first loaded, from NODE_DISABLE_COLORS.
 */
export async function ask<T extends Record<string, unknown>>(question: Record<string, unknown>): Promise<T> {
  if (!colorEnabled(process.stderr)) process.env.NODE_DISABLE_COLORS = "1";
  const promptsModule = (await import("prompts")) as { default: any };
  const answer = await promptsModule.default(
    { ...question, stdout: process.stderr },
    {
      onCancel: () => {
        // user hit Ctrl-C / Esc: the answer stays empty
        return false;
      },
    },
  );
  return answer as T;
}

/**
 * Prompt for y/n confirmation. `-y/--yes` answers yes without asking.
 * Returns true on yes, false on no, null if there is no TTY to ask on (the
 * caller should fail and tell the user to pass `--yes`).
 */
export async function confirm(message: string): Promise<boolean | null> {
  if (state.g.yes) return true;
  if (!isStdinTty()) return null;
  const response = await ask<{ value?: boolean }>({ type: "confirm", name: "value", message, initial: false });
  return Boolean(response.value);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * The id shown for a run: the last 8 hex digits of its UUID. The leading
 * digits of a UUIDv7 are timestamp bits, so two runs started within a minute
 * or so share their first 8; the trailing digits are random. The API resolves
 * this form back to the run (exact id, else unique prefix, else unique suffix).
 */
export function shortRunId(runId: string): string {
  const stripped = runId.replace(/-/g, "");
  return stripped.slice(-8);
}

/**
 * A job name as one shell word, for the commands printed as hints. Names may
 * hold spaces, which an unquoted command line would split. Plain names stay bare.
 */
export function shellWord(name: string): string {
  if (/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)) return name;
  return `'${name.replaceAll("'", `'\\''`)}'`;
}

/** "1 run" / "2 runs". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Turn an epoch-ms into "YYYY-MM-DD HH:MM:SS" in local time. */
export function fmtTime(epochMs: number | null | undefined): string {
  if (typeof epochMs !== "number") return "-";
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "YYYY-MM-DD HH:MM" in local time (schedules have minute resolution). */
export function fmtTimeMinutes(epochMs: number | null | undefined): string {
  if (typeof epochMs !== "number") return "-";
  return fmtTime(epochMs).slice(0, 16);
}

/** Format duration in ms as "234ms" / "13s" / "1m23s" / "2h05m" / "-". */
export function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${pad2(m)}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/**
 * Exact human form of a configured span: 90 minutes is "1h30m", never "2h".
 * Zero-valued units are dropped ("2h", "1m30s", "500ms").
 */
export function fmtSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms === 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  let rest = Math.round(ms);
  const parts: string[] = [];
  const units: [string, number][] = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
    ["ms", 1],
  ];
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
  }
  return parts.join("");
}

/** Coarse two-unit distance: "45s", "12m", "3h20m", "2d4h". */
function fmtDistance(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
}

/** "3h ago" for a past time. */
export function fmtAgo(epochMs: number | null | undefined, now = Date.now()): string {
  if (typeof epochMs !== "number") return "-";
  if (now - epochMs < 1000) return "just now";
  return `${fmtDistance(now - epochMs)} ago`;
}

/** "in 3h20m" for a future time. */
export function fmtIn(epochMs: number | null | undefined, now = Date.now()): string {
  if (typeof epochMs !== "number") return "-";
  if (epochMs - now < 1000) return "now";
  return `in ${fmtDistance(epochMs - now)}`;
}

/** Pad-right to width (no truncation; never lies about content). */
export function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

export type Column<T> = {
  header: string;
  cell: (row: T) => string;
  /** Applied after padding, so escape codes never disturb the alignment. */
  paint?: (row: T, padded: string) => string;
};

/** Render rows as an aligned table with a header line (columns separated by two spaces). */
export function renderTable<T>(columns: Column<T>[], rows: T[], indent = ""): string {
  const cells = rows.map((r) => columns.map((c) => c.cell(r)));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i]!.length)));
  const header = columns.map((c, i) => padRight(c.header, widths[i]!)).join("  ").trimEnd();
  const lines = [indent + header];
  rows.forEach((r, ri) => {
    const line = columns
      .map((c, i) => {
        const padded = padRight(cells[ri]![i]!, widths[i]!);
        return c.paint ? c.paint(r, padded) : padded;
      })
      .join("  ")
      .trimEnd();
    lines.push(indent + line);
  });
  return lines.join("\n");
}

/** Colorize a run state for a table cell (stdout). */
export function paintState(state: string, text: string): string {
  switch (state) {
    case "succeeded":
      return color.green(text);
    case "failed":
    case "timed_out":
    case "killed":
    case "lost":
      return color.red(text);
    case "running":
    case "queued":
      return color.yellow(text);
    default:
      return color.dim(text);
  }
}

/** Run states that will not change again. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "killed",
  "cancelled",
  "skipped",
  "lost",
]);

// ---------------------------------------------------------------------------
// API client helpers
// ---------------------------------------------------------------------------

let cachedClient: ApiClient | null = null;
let cachedKey = "";

/**
 * Build (or return the cached) API client honoring --token-file / --base-url.
 * The cache is keyed on those two flags so tests / chained calls don't
 * accidentally reuse a stale client when globals change between commands.
 */
export function getApiClient(): ApiClient {
  const g = state.g;
  const key = `${g.tokenFile ?? ""}|${g.baseUrl ?? ""}`;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedClient = new ApiClient({
    tokenFile: g.tokenFile ?? undefined,
    baseUrl: g.baseUrl ?? undefined,
  });
  cachedKey = key;
  return cachedClient;
}

/**
 * Probe the supervisor and throw `SupervisorUnreachable` (exit 3) when it does
 * not answer. Called at the top of every command that talks to /api/*.
 */
export async function requireSupervisor(client: ApiClient): Promise<void> {
  if (!(await client.reachable())) throw new SupervisorUnreachable(client.baseUrl);
}
