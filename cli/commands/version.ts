import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getApiClient, globals, printJson, println } from "../runtime.ts";
import { PACKAGE_ROOT } from "../../paths.ts";

/** The Auto version from package.json, or "unknown". */
export function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function gitShortSha(): Promise<string> {
  if (!existsSync(resolve(PACKAGE_ROOT, ".git"))) return "unknown";
  try {
    const proc = Bun.spawn(["/usr/bin/env", "git", "rev-parse", "--short", "HEAD"], {
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return "unknown";
    const text = await new Response(proc.stdout).text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : "unknown";
  } catch {
    return "unknown";
  }
}

function bunVersion(): string {
  const v =
    (typeof Bun !== "undefined" && (Bun as { version?: string }).version) ||
    (process.versions as Record<string, string | undefined>).bun ||
    "unknown";
  return v;
}

/**
 * Probe the supervisor without exiting on unreachable. The version command
 * is a diagnostic; it should NOT exit 3 just because the supervisor is down.
 */
type SupervisorReport = {
  status: string;
  loaded_at: number | null;
  /** What the RUNNING supervisor reports; null when it is unreachable or too old to say. */
  version: string | null;
  commit: string | null;
};

async function supervisorReport(): Promise<SupervisorReport> {
  try {
    const client = getApiClient();
    const ok = await client.reachable();
    if (!ok) return { status: "unreachable", loaded_at: null, version: null, commit: null };
    const cfg = await client.configStatus();
    return {
      // "degraded" means nothing is scheduled (no config ever loaded). A rejected
      // edit while the last good config keeps running is a config error only.
      status: cfg.degraded?.active ? "degraded" : cfg.ok ? "ok" : "config_error",
      loaded_at: cfg.loadedAt,
      version: cfg.supervisor?.version ?? null,
      commit: cfg.supervisor?.commit ?? null,
    };
  } catch {
    return { status: "unreachable", loaded_at: null, version: null, commit: null };
  }
}

export async function runVersion(): Promise<number> {
  const version = packageVersion();
  const sha = await gitShortSha();
  const bun = bunVersion();
  const sup = await supervisorReport();

  if (globals().json) {
    printJson({
      auto: version,
      // The supervisor's own version and commit, as it reports them (null when
      // it is not running); the CLI's are under `auto` and `cli`.
      cli: { version, commit: sha === "unknown" ? null : sha },
      supervisor: { version: sup.version, commit: sup.commit, status: sup.status, loaded_at: sup.loaded_at },
      bun,
    });
    return 0;
  }
  println(`auto ${version}${sha === "unknown" ? "" : `+${sha}`}  (cli)`);
  if (sup.version) {
    println(`supervisor ${sup.version}${sup.commit ? `+${sup.commit}` : ""}  (${sup.status.replace(/_/g, " ")})`);
    const stale = sup.version !== version || (sup.commit !== null && sha !== "unknown" && sup.commit !== sha);
    if (stale) println(`  the running supervisor differs from this checkout; \`auto svc restart\` to run the new code`);
  } else {
    println(`supervisor ${sup.status === "unreachable" ? "not running" : "version unknown (older than this CLI)"}  (${sup.status})`);
  }
  println(`bun ${bun}`);
  return 0;
}
