// `auto init` — create (or complete) an Auto workspace.
//
// Safe to run again: it creates only the pieces that are missing and never
// overwrites the config, the starter worker or an existing .gitignore's
// content.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  CONFIG_PATH,
  DATA_DIR,
  EX,
  MIN_BUN_VERSION,
  STATE_DIR,
  WORKSPACE_ROOT,
  globals,
  printJson,
  status,
} from "../runtime.ts";

const STARTER_WORKER = `console.log(\`Hello from Auto at \${new Date().toISOString()}\`);\n`;

const STARTER_CONFIG = `// Auto workspace configuration.
//
// Each entry describes one job: a worker script and the triggers that start
// it. Auto watches this file and applies valid edits without a restart; an
// invalid edit is reported and the previous version keeps running.
//
//   worker    a script under this workspace, run as "bun <worker>"
//   triggers  cron (five fields, machine local time), webhook, or a cron
//             trigger with a condition checker
//
// Check it with \`auto config check\`. Add another job with
// \`auto create <name> --add\`. Docs: README.md in the Auto checkout.
export default [
  {
    id: "hello-world",
    name: "hello-world",
    description: "Print a friendly message every morning.",
    worker: "./jobs/hello-world.ts",
    triggers: [{ kind: "cron", id: "morning", schedule: "0 9 * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 60_000,
    killGraceMs: 10_000,
    enabled: true,
  },
];
`;

const GITIGNORE_LINES = ["data/", ".auto-runtime/"];

/** True when `version` ("1.4.2") is at least `min` ("1.3.0"). */
export function bunVersionAtLeast(version: string, min: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((p) => parseInt(p, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function ensureDir(path: string, created: string[], existing: string[]): void {
  // The workspace and the config's directory are usually the same one.
  if (created.includes(path) || existing.includes(path)) return;
  if (existsSync(path)) {
    existing.push(path);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // best effort (e.g. Windows)
  }
  created.push(path);
}

export async function runInit(): Promise<number> {
  const bunVersion = (typeof Bun !== "undefined" && Bun.version) || "0.0.0";
  if (!bunVersionAtLeast(bunVersion, MIN_BUN_VERSION)) {
    status(`Auto needs Bun ${MIN_BUN_VERSION} or newer; this is Bun ${bunVersion}. Upgrade with \`bun upgrade\`.`);
    return EX.ERR;
  }

  const created: string[] = [];
  const existing: string[] = [];
  const configExisted = existsSync(CONFIG_PATH);

  ensureDir(WORKSPACE_ROOT, created, existing);
  ensureDir(dirname(CONFIG_PATH), created, existing);
  const jobsDir = resolve(WORKSPACE_ROOT, "jobs");
  ensureDir(jobsDir, created, existing);
  ensureDir(DATA_DIR, created, existing);
  ensureDir(STATE_DIR, created, existing);

  // The starter worker only goes with a freshly created config; an existing
  // config is the owner's and is left alone.
  if (!configExisted) {
    writeFileSync(CONFIG_PATH, STARTER_CONFIG, { flag: "wx", mode: 0o644 });
    created.push(CONFIG_PATH);
    const worker = resolve(jobsDir, "hello-world.ts");
    if (existsSync(worker)) existing.push(worker);
    else {
      writeFileSync(worker, STARTER_WORKER, { flag: "wx" });
      created.push(worker);
    }
  } else {
    existing.push(CONFIG_PATH);
  }

  const gitignore = resolve(WORKSPACE_ROOT, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, GITIGNORE_LINES.join("\n") + "\n", { flag: "wx" });
    created.push(gitignore);
  } else {
    const have = new Set(readFileSync(gitignore, "utf8").split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE_LINES.filter((l) => !have.has(l) && !have.has(l.replace(/\/$/, "")));
    if (missing.length > 0) {
      const text = readFileSync(gitignore, "utf8");
      appendFileSync(gitignore, (text.length > 0 && !text.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
      created.push(`${gitignore} (added ${missing.join(", ")})`);
    } else {
      existing.push(gitignore);
    }
  }

  if (globals().json) {
    printJson({ workspace: WORKSPACE_ROOT, config: CONFIG_PATH, created, existing });
    return EX.OK;
  }

  if (created.length === 0) {
    status(`workspace already set up at ${WORKSPACE_ROOT}; nothing to create`);
  } else {
    status(`${configExisted ? "completed" : "initialized"} Auto workspace at ${WORKSPACE_ROOT}`);
    // Paths relative to the workspace read better than absolute ones.
    for (const path of created) {
      status(`  created ${path === WORKSPACE_ROOT ? "the workspace directory" : path.replace(WORKSPACE_ROOT + sep, "")}`);
    }
  }
  status("");
  status("next steps:");
  status("  auto config check   validate the configuration");
  status("  auto install        register the supervisor with the OS and start it");
  status("  auto doctor         confirm everything is healthy");
  status("  auto ui             open the dashboard");
  return EX.OK;
}
