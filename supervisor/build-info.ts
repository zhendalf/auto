import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "../paths.ts";

export type BuildInfo = {
  /** `version` from package.json as of when this supervisor started, or "unknown". */
  version: string;
  /** Short git commit of the checkout, or null when this is not a git checkout. */
  commit: string | null;
};

let cached: BuildInfo | null = null;

/**
 * What code this process is running. Read once (call it at startup): a `git
 * pull` after the supervisor started must not change what it reports, since the
 * old code is still what runs until it restarts.
 */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  let version = "unknown";
  try {
    const parsed = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string") version = parsed.version;
  } catch {
    // keep "unknown"
  }
  let commit: string | null = null;
  if (existsSync(resolve(PACKAGE_ROOT, ".git"))) {
    try {
      const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
        cwd: PACKAGE_ROOT,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
      if (text) commit = text;
    } catch {
      // git missing
    }
  }
  cached = { version, commit };
  return cached;
}
