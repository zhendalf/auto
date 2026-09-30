// Shared helpers for the CLI tests: run `auto` as a subprocess against a
// temporary workspace, start a real supervisor in it, or talk to a fake API.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const CLI_MAIN = resolve(ROOT, "cli/main.ts");
/** Port for tests that start a real supervisor. */
export const LIVE_PORT = Number(process.env.CLI_TEST_PORT ?? 17960);

/**
 * `process.env` without any Auto setting. A developer or CI job that exports
 * AUTO_CONFIG, AUTO_PORT, AUTO_ALLOWED_HOSTS and the like must not change what
 * a test supervisor or CLI loads (or reach the real workspace).
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !k.startsWith("AUTO_")) out[k] = v;
  }
  return out;
}

export type Workspace = {
  home: string;
  data: string;
  env: Record<string, string>;
  cleanup: () => void;
};

/** A throwaway workspace directory (not initialized) with the environment that points the CLI at it. */
export function makeWorkspace(port: number = LIVE_PORT): Workspace {
  const base = mkdtempSync(join(tmpdir(), "auto-cli-test-"));
  const home = join(base, "ws");
  const data = join(home, "data");
  return {
    home,
    data,
    env: {
      ...cleanEnv(),
      AUTO_HOME: home,
      AUTO_DATA_DIR: data,
      AUTO_PORT: String(port),
      NO_COLOR: "1",
      AUTO_NOTIFY: "0",
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export type CliResult = { code: number; stdout: string; stderr: string };

export async function runAuto(
  ws: Pick<Workspace, "env">,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    cwd: ROOT,
    env: { ...ws.env, ...(opts.env ?? {}) },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
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

/** Write a config file and worker scripts into an (already created) workspace. */
export function writeWorkspaceFiles(ws: Workspace, config: string, workers: Record<string, string> = {}): void {
  mkdirSync(join(ws.home, "jobs"), { recursive: true });
  for (const [name, source] of Object.entries(workers)) writeFileSync(join(ws.home, "jobs", name), source);
  writeFileSync(join(ws.home, "auto.config.ts"), config);
}

async function answersHealthz(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

export type LiveSupervisor = { pid: number; stop: () => Promise<void> };

/** Start `bun supervisor/main.ts` directly (never through cron) and wait for /healthz. */
export async function startSupervisor(ws: Workspace, port: number = LIVE_PORT): Promise<LiveSupervisor> {
  // Anything already answering on the port would be mistaken for our child.
  if (await answersHealthz(port)) {
    throw new Error(`port ${port} is already in use (something answers /healthz); is another test run going?`);
  }
  const child = Bun.spawn([process.execPath, resolve(ROOT, "supervisor/main.ts")], {
    cwd: ws.home,
    env: ws.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`supervisor exited early (code ${child.exitCode})`);
    if (await answersHealthz(port)) {
      // Only count it when it is our own process that is still running.
      if (child.exitCode !== null) throw new Error(`supervisor exited early (code ${child.exitCode})`);
      break;
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("supervisor did not start");
    }
    await Bun.sleep(100);
  }
  return {
    pid: child.pid,
    stop: async () => {
      child.kill("SIGTERM");
      const done = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
      if (done === "timeout") child.kill("SIGKILL");
      await child.exited;
    },
  };
}

/** One config with a couple of jobs used by the live tests. */
export const LIVE_CONFIG = `export default [
  {
    id: "quick",
    name: "quick",
    description: "Prints and exits.",
    worker: "./jobs/quick.ts",
    triggers: [{ kind: "cron", id: "morning", schedule: "0 9 * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 5_400_000,
    killGraceMs: 10_000,
    enabled: true,
  },
  {
    id: "boom",
    name: "boom",
    worker: "./jobs/boom.ts",
    triggers: [{ kind: "cron", id: "hourly", schedule: "0 * * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 60_000,
    killGraceMs: 10_000,
    enabled: true,
  },
  {
    id: "slow",
    name: "slow",
    worker: "./jobs/slow.ts",
    triggers: [{ kind: "cron", id: "default", schedule: "30 3 * * *" }],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 60_000,
    killGraceMs: 2_000,
    enabled: true,
  },
  {
    id: "hooked",
    name: "hooked",
    worker: "./jobs/quick.ts",
    triggers: [
      {
        kind: "webhook",
        id: "gh",
        path: "gh-hook",
        auth: { profile: "hmac-sha256", secretRef: "gh-secret", signatureHeader: "x-signature" },
        deliveryIdHeader: "x-delivery",
      },
    ],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 60_000,
    killGraceMs: 10_000,
    enabled: true,
  },
];
`;

export const LIVE_WORKERS: Record<string, string> = {
  "quick.ts": `console.log("quick says hi");\n`,
  "boom.ts": `console.log("about to fail"); process.exit(3);\n`,
  "slow.ts": `console.log("slow start"); await Bun.sleep(30_000); console.log("slow end");\n`,
};
