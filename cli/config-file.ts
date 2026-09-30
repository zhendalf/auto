// Helpers for reading and editing the workspace's `auto.config.ts` from the
// CLI (`auto create`, `auto init`, `auto config check`).
//
// The supervisor owns validation (supervisor/config.ts); the CLI reuses that
// exact function so a config the CLI writes is one the supervisor will load.

import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { PACKAGE_ROOT } from "../paths.ts";
import { loadConfigOnce, validateConfigFile } from "../supervisor/config.ts";
import { CONFIG_PATH } from "./runtime.ts";

// ---------------------------------------------------------------------------
// Offline check (what `auto config check` runs)
// ---------------------------------------------------------------------------

export type OfflineCheck = { code: number; stdout: string; stderr: string };

/** Run `supervisor/main.ts --check` and capture its output: config validation plus pending migrations, no side effects. */
export async function checkConfigOffline(): Promise<OfflineCheck> {
  const child = Bun.spawn([process.execPath, resolve(PACKAGE_ROOT, "supervisor", "main.ts"), "--check"], {
    cwd: PACKAGE_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Job names already in the config
// ---------------------------------------------------------------------------

/**
 * Names and ids of the jobs in the config file. Uses the real loader; when the
 * config cannot be loaded, falls back to scanning the text for `name:` / `id:`
 * strings so `auto create` can still refuse an obvious duplicate.
 */
export async function existingJobNames(configPath: string = CONFIG_PATH): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const { config } = await loadConfigOnce({ configPath, checkFiles: false });
    for (const job of config) {
      names.add(job.name);
      names.add(job.id);
    }
    return names;
  } catch {
    // fall through to the text scan
  }
  try {
    const text = readFileSync(configPath, "utf8");
    for (const m of text.matchAll(/\b(?:name|id)\s*:\s*(["'`])([^"'`\n]+)\1/g)) names.add(m[2]!);
  } catch {
    // no readable file: nothing to compare against
  }
  return names;
}

// ---------------------------------------------------------------------------
// Job entry text and appending it
// ---------------------------------------------------------------------------

/** The config entry for a new job, as text ready to paste into the exported array. */
export function jobEntryText(name: string, cron: string): string {
  return [
    "  {",
    `    id: ${JSON.stringify(name)},`,
    `    name: ${JSON.stringify(name)},`,
    `    worker: ${JSON.stringify(`./jobs/${name}.ts`)},`,
    `    triggers: [{ kind: "cron", id: "default", schedule: ${JSON.stringify(cron)} }],`,
    `    reentrancy: "drop",`,
    "    queueDepth: 1,",
    "    timeoutMs: 60_000,",
    "    killGraceMs: 10_000,",
    "    enabled: true,",
    "  },",
  ].join("\n");
}

export type AppendResult = { ok: true; source: string } | { ok: false; reason: string };

/**
 * Insert `entry` before the closing `];` of a config that has the standard
 * shape (`export default [ ... ];`). Anything else (a function call, a
 * variable, `satisfies`, ...) is refused with the reason so the caller can
 * print the entry for the user to paste.
 */
export function appendEntryToConfigSource(source: string, entry: string): AppendResult {
  const defaults = source.match(/^export\s+default\s+\[/gm);
  if (!defaults || defaults.length !== 1) {
    return { ok: false, reason: "the config does not have the standard `export default [ ... ];` shape" };
  }
  const trimmed = source.trimEnd();
  if (!trimmed.endsWith("];")) {
    return { ok: false, reason: "the config does not end with `];`" };
  }
  const head = trimmed.slice(0, -2).trimEnd();
  const trailing = source.slice(trimmed.length);
  // The previous element needs a comma unless the array is empty or already has one.
  const needsComma = !head.endsWith("[") && !head.endsWith(",");
  return {
    ok: true,
    source: `${head}${needsComma ? "," : ""}\n${entry}\n];${trailing || "\n"}`,
  };
}

export type AddToConfigResult =
  | { ok: true }
  | { ok: false; kind: "unsupported_shape" | "invalid"; reason: string };

/**
 * Append `entry` to the config file, validating the result before it replaces
 * the file. The candidate is written next to the config (so relative imports
 * resolve the same way), checked with the supervisor's own validation, and only
 * then renamed over the real file. A failed check therefore leaves the config
 * byte-for-byte as it was, and a running supervisor never sees the bad version.
 */
export async function addEntryToConfigFile(
  entry: string,
  opts: {
    configPath?: string;
    validate?: (candidatePath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  } = {},
): Promise<AddToConfigResult> {
  const configPath = opts.configPath ?? CONFIG_PATH;
  const validate = opts.validate ?? ((path: string) => validateConfigFile({ configPath: path }));

  const source = readFileSync(configPath, "utf8");
  const appended = appendEntryToConfigSource(source, entry);
  if (!appended.ok) return { ok: false, kind: "unsupported_shape", reason: appended.reason };

  const candidate = resolve(dirname(configPath), `.${basename(configPath, ".ts")}.candidate-${process.pid}.ts`);
  writeFileSync(candidate, appended.source, { mode: 0o600 });
  try {
    const result = await validate(candidate);
    if (!result.ok) return { ok: false, kind: "invalid", reason: result.error };
    try {
      chmodSync(candidate, statSync(configPath).mode & 0o777);
    } catch {
      // keep the candidate's mode
    }
    renameSync(candidate, configPath);
    return { ok: true };
  } finally {
    if (existsSync(candidate)) {
      try {
        unlinkSync(candidate);
      } catch {
        // best effort
      }
    }
  }
}
