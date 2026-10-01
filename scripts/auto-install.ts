import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installBunCronService,
  runningSupervisorPid,
  startSupervisorNow,
  verifyServiceEntry,
  waitForHealthz,
} from "../supervisor/bun-cron-service.ts";
import { installShim } from "../cli/install-shim.ts";
import { ensureStateDirs } from "../supervisor/lifecycle.ts";
import { SUPERVISOR_LOG_PATH } from "../supervisor/log-file.ts";
import { isPidAlive } from "../supervisor/process-identity.ts";
import { AUTO_PORT, ENV_PROBLEM } from "../paths.ts";

// The supervisor this script starts listens on loopback whatever AUTO_BASE_URL names.
const LOCAL_URL = `http://127.0.0.1:${AUTO_PORT}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

async function run(command: string[], cwd = ROOT): Promise<void> {
  process.stdout.write(`+ ${command.join(" ")}\n`);
  if (dryRun) return;
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

async function main(): Promise<void> {
  if (!Bun.version) throw new Error("Bun is required");
  if (ENV_PROBLEM) throw new Error(ENV_PROBLEM);
  if (!dryRun) ensureStateDirs();
  // One install covers the dashboard too: the supervisor bundles ui/ itself (D-44).
  await run([process.execPath, "install", "--frozen-lockfile"]);
  await run([process.execPath, "supervisor/main.ts", "--check"]);
  if (dryRun) {
    process.stdout.write("dry-run complete; service registration, shim, and health verification skipped\n");
    return;
  }
  // Rewrites the watchdog entry (and its baked absolute supervisor path) every time.
  await installBunCronService();
  const entry = verifyServiceEntry();
  if (!entry.ok) throw new Error(entry.problem ?? "watchdog entry is invalid");
  const shim = installShim();
  const running = runningSupervisorPid();
  const pid = running ?? startSupervisorNow();
  process.stdout.write(
    `installed Bun cron watchdog; shim=${shim.path}; ${running ? "already running" : "starting"} pid=${pid}\n`,
  );
  if (!shim.onPath) {
    process.stdout.write(`note: ${dirname(shim.path)} is not on your PATH; add it to run \`auto\` by name\n`);
  }
  const health = await waitForHealthz(LOCAL_URL, {
    timeoutMs: 15_000,
    stillStarting: () => isPidAlive(pid) || runningSupervisorPid() !== null,
  });
  if (!health.ok) {
    throw new Error(
      health.reason === "exited"
        ? `supervisor exited before it became reachable; see \`auto svc tail\` (${SUPERVISOR_LOG_PATH})`
        : `supervisor did not become reachable within 15 seconds; see \`auto svc tail\` (${SUPERVISOR_LOG_PATH})`,
    );
  }
  process.stdout.write(`supervisor is up at ${LOCAL_URL}\n`);
  process.stdout.write(`Dashboard: ${LOCAL_URL}/\n`);
}

await main();
