#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { EX, errColor, flushOutput, globals, setGlobals, status, stdoutClosedByReader } from "./runtime.ts";
import { ApiError, SupervisorTimeout, SupervisorUnreachable, TokenMissing } from "./client.ts";
import { ENV_PROBLEM } from "../paths.ts";

import { packageVersion, runVersion } from "./commands/version.ts";
import { runRuns } from "./commands/runs.ts";
import { runLog } from "./commands/log.ts";
import { runLast } from "./commands/last.ts";
import { runRun } from "./commands/run.ts";
import { runJob } from "./commands/job.ts";
import { runJobs } from "./commands/jobs.ts";
import { runCancel } from "./commands/cancel.ts";
import { runEnable } from "./commands/enable.ts";
import { runDisable } from "./commands/disable.ts";
import { runPause } from "./commands/pause.ts";
import { runTriggerEnable, runTriggerDisable } from "./commands/trigger.ts";
import {
  runConfigStatus,
  runConfigReload,
  runConfigEdit,
  runConfigCheck,
} from "./commands/config.ts";
import { runUi } from "./commands/ui.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runDataWipe } from "./commands/data.ts";
import {
  svcInstall,
  svcRestart,
  svcStart,
  svcStop,
  svcTail,
  svcUninstall,
} from "./commands/svc.ts";
import { runSecretList, runSecretRemove, runSecretSet } from "./commands/secret.ts";
import { runTokenRotate } from "./commands/token.ts";
import { runInit } from "./commands/init.ts";
import { runCreate } from "./commands/create.ts";

// ---------------------------------------------------------------------------
// Error -> message + exit code
// ---------------------------------------------------------------------------

export { EX };

/** Wrap an async command body with the standard error-class -> exit-code map. */
export async function safeRun(fn: () => Promise<number>): Promise<number> {
  // --version and --help never get here, so they work with a broken environment.
  if (ENV_PROBLEM) {
    status(`error: ${ENV_PROBLEM}`);
    return EX.USAGE;
  }
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SupervisorUnreachable) {
      status(`supervisor unreachable at ${err.message}`);
      status("start it with `auto install` (first time) or `auto svc start`; `auto doctor` shows what is wrong");
      return EX.UNREACHABLE;
    }
    if (err instanceof SupervisorTimeout) {
      status(`${err.message}; it is running but slow to answer. Try again, or look at \`auto svc tail\``);
      return EX.ERR;
    }
    if (err instanceof TokenMissing) {
      if (globals().tokenFile) {
        // The user pointed at a file; the supervisor being down is not the problem.
        status(`cannot read an API token from ${err.path} (--token-file); check the path`);
        return EX.ERR;
      }
      status("supervisor has not started yet: run `auto install`");
      status(`(no API token at ${err.path})`);
      return EX.ERR;
    }
    if (err instanceof ApiError) {
      if (err.status === 409) {
        status(`conflict: ${describeApiBody(err.body)}`);
        return EX.CONFLICT;
      }
      if (err.status === 401) {
        status("the supervisor rejected the API token (401); it may have been rotated. Retry, or check --token-file");
        return EX.ERR;
      }
      if (err.status === 403 && describeApiBody(err.body).startsWith("bad_host")) {
        status("the supervisor rejected the Host header; list a custom host in AUTO_ALLOWED_HOSTS on the supervisor");
        return EX.ERR;
      }
      status(`api error ${err.status}: ${describeApiBody(err.body)}`);
      return EX.ERR;
    }
    const msg = err instanceof Error ? err.message : String(err);
    status(`error: ${msg}`);
    return EX.ERR;
  }
}

function describeApiBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const b = body as Record<string, unknown>;
    return typeof b.message === "string" ? `${String(b.error)}: ${b.message}` : String(b.error);
  }
  if (body == null) return "(no body)";
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

function applyGlobalsFromOpts(cmd: Command): void {
  const opts = cmd.optsWithGlobals();
  setGlobals({
    json: Boolean(opts.json),
    // commander stores `--no-color` as `color: false`
    noColor: opts.color === false,
    yes: Boolean(opts.yes),
    tokenFile: typeof opts.tokenFile === "string" ? (opts.tokenFile as string) : null,
    baseUrl: typeof opts.baseUrl === "string" ? (opts.baseUrl as string) : null,
  });
}

/** Why `url` cannot be a supervisor address, or null when it can (or is not set). */
export function baseUrlProblem(url: string | null | undefined): string | null {
  if (!url) return null;
  let protocol: string | null = null;
  try {
    protocol = new URL(url).protocol;
  } catch {
    // reported below
  }
  if (protocol === "http:" || protocol === "https:") return null;
  return `error: the supervisor URL must start with http:// or https:// (got "${url}"); for example http://127.0.0.1:7777`;
}

/**
 * `--token-file jobs` would swallow the command name as the path and then
 * show the whole help. Say what is wrong instead. Returns a message, or null.
 */
export function missingOptionValue(argv: string[], commandNames: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== "--token-file" && arg !== "--base-url") continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-") || commandNames.includes(value)) {
      const placeholder = arg === "--token-file" ? "<path>" : "<url>";
      return `error: option '${arg} ${placeholder}' needs a value${value ? ` (got '${value}')` : ""}`;
    }
    i++;
  }
  return null;
}

type Handler = (args: string[], opts: Record<string, unknown>) => Promise<number>;

const HELP_GROUPS = {
  setup: "Setup:",
  jobs: "Jobs:",
  runs: "Runs:",
  service: "Service:",
  diagnostics: "Diagnostics:",
} as const;

const EXIT_CODES_HELP = `
Exit codes:
  0    success
  1    error, or the run did not succeed
  2    usage error
  3    the supervisor is unreachable
  4    \`auto run\`: another run of the job is in progress (use --force)
  130  interrupted with Ctrl-C while following a run

Run \`auto <command> --help\` for details and examples. Add --json to any
command that prints data: stdout is then JSON only; status goes to stderr.`;

function buildProgram(): { program: Command; result: { code: number } } {
  const result: { code: number } = { code: EX.OK };
  const program = new Command();
  program
    .name("auto")
    .description("Local-first automation supervisor: schedule scripts, keep run history and logs.")
    .version(packageVersion(), "-V, --version", "print the Auto version")
    .option("--json", "machine-readable JSON on stdout (status messages stay on stderr)")
    .option("--no-color", "disable colored output (also honors NO_COLOR)")
    .option("--token-file <path>", "read the API token from this file (default: <data dir>/.token)")
    .option("--base-url <url>", "supervisor URL (default: http://127.0.0.1:$AUTO_PORT)")
    .option("-y, --yes", "answer yes to confirmation prompts")
    .helpOption("-h, --help", "show help")
    .addHelpText("after", EXIT_CODES_HELP)
    // Throw instead of exiting so main() can return the exit code (and tests can call it).
    .exitOverride();
  program.showSuggestionAfterError(true);

  /** Register `handler` as the action of `cmd`: apply global flags, run, map errors to an exit code. */
  const act = (cmd: Command, handler: Handler): Command =>
    cmd.action(async (...raw: unknown[]) => {
      const command = raw[raw.length - 1] as Command;
      const opts = raw[raw.length - 2] as Record<string, unknown>;
      const args = raw.slice(0, -2) as string[];
      applyGlobalsFromOpts(command);
      const badUrl = baseUrlProblem(globals().baseUrl ?? process.env.AUTO_BASE_URL);
      if (badUrl) {
        status(badUrl);
        result.code = EX.USAGE;
        return;
      }
      result.code = await safeRun(() => handler(args, opts));
    });

  // ---- Setup ----
  act(
    program
      .command("init")
      .helpGroup(HELP_GROUPS.setup)
      .description("create an Auto workspace (safe to re-run; only creates what is missing)")
      .addHelpText("after", "\nCreates the workspace directory, a starter config and a hello-world job.\nExample:\n  auto init"),
    () => runInit(),
  );
  act(
    program
      .command("create <name>")
      .helpGroup(HELP_GROUPS.setup)
      .description("create a worker script for a new job, optionally adding it to the config")
      .option("--cron <expr>", "five-field cron schedule in machine local time (default: \"0 9 * * *\")")
      .option("--add", "append the job to auto.config.ts (validated first; the file is left alone if it would break)")
      .addHelpText(
        "after",
        "\nNeeds a workspace (`auto init`). Examples:\n  auto create weekly-report --add --cron \"0 8 * * 1\"\n  auto create backup            # creates the worker and prints the config entry to paste",
      ),
    ([name], opts) => runCreate(name!, { cron: opts.cron as string | undefined, add: Boolean(opts.add) }),
  );
  act(
    program
      .command("install")
      .helpGroup(HELP_GROUPS.setup)
      .description("register the supervisor with the OS scheduler and start it now")
      .addHelpText("after", "\n`auto svc install` is the same command."),
    () => svcInstall(),
  );

  const secret = program
    .command("secret")
    .helpGroup(HELP_GROUPS.setup)
    .description("manage the named secrets webhook triggers sign with (values are never shown)");
  act(
    secret.command("list").description("list secret names (never values)"),
    () => runSecretList(),
  );
  act(
    secret
      .command("set <name>")
      .description("set a secret from a hidden prompt, or from stdin when piped")
      .option("--stdin", "read the value from stdin even in a terminal")
      .addHelpText("after", "\nExamples:\n  auto secret set github-release-webhook\n  printf %s \"$TOKEN\" | auto secret set github-release-webhook"),
    ([name], opts) => runSecretSet(name!, { stdin: Boolean(opts.stdin) }),
  );
  act(
    secret.command("remove <name>").description("delete a secret"),
    ([name]) => runSecretRemove(name!),
  );

  const cfg = program
    .command("config")
    .helpGroup(HELP_GROUPS.setup)
    .description("check, inspect, edit and reload auto.config.ts");
  act(
    cfg.command("check").description("validate auto.config.ts offline (no supervisor needed)"),
    () => runConfigCheck(),
  );
  act(
    cfg.command("status").description("show whether the supervisor loaded the config, and any errors"),
    () => runConfigStatus(),
  );
  act(
    cfg.command("reload").description("make the supervisor re-read the config now"),
    () => runConfigReload(),
  );
  act(
    cfg.command("edit").description("open the config in $EDITOR, validate it, then reload"),
    () => runConfigEdit(),
  );

  // ---- Jobs ----
  act(
    program
      .command("jobs")
      .helpGroup(HELP_GROUPS.jobs)
      .description("list jobs with their state, triggers, last run and next run"),
    () => runJobs(),
  );
  act(
    program
      .command("job <name>")
      .helpGroup(HELP_GROUPS.jobs)
      .description("show one job: triggers with schedules and next runs, limits, recent runs"),
    ([name]) => runJob(name!),
  );
  act(
    program
      .command("run <name>")
      .helpGroup(HELP_GROUPS.jobs)
      .description("start a job now and follow its output until it finishes")
      .option("-f, --force", "start regardless: also when the job is disabled or paused, or another run of it is in progress")
      .addHelpText(
        "after",
        "\nExit code is 0 only if the run succeeded; 1 if it failed, timed out or was cancelled;\n4 if another run is in progress (retry with --force, or answer the prompt / pass -y);\n3 if the supervisor is unreachable. Press Ctrl-C to stop following: the run keeps going (exit 130).\nExample:\n  auto run hello-world",
      ),
    ([name], opts) => runRun(name!, { force: Boolean(opts.force) }),
  );
  act(
    program.command("enable <name>").helpGroup(HELP_GROUPS.jobs).description("enable a job (undoes `auto disable`; `enabled: false` in the config file is not overridden)"),
    ([name]) => runEnable(name!),
  );
  act(
    program.command("disable <name>").helpGroup(HELP_GROUPS.jobs).description("disable a job: no trigger starts it until re-enabled"),
    ([name]) => runDisable(name!),
  );
  act(
    program
      .command("pause <name> [duration]")
      .helpGroup(HELP_GROUPS.jobs)
      .description("pause a job for a while (default 1h); `off` resumes it")
      .addHelpText("after", "\nExamples:\n  auto pause hello-world 2h30m\n  auto pause hello-world off"),
    ([name, duration]) => runPause(name!, duration),
  );
  const trig = program
    .command("trigger")
    .helpGroup(HELP_GROUPS.jobs)
    .description("enable or disable one trigger of a job");
  act(
    trig
      .command("enable <trigger_id>")
      .description("enable a trigger; ids look like job-name:trigger-id (see `auto job <name>`)")
      .addHelpText("after", "\nExample:\n  auto trigger enable hello-world:morning"),
    ([id]) => runTriggerEnable(id!),
  );
  act(
    trig
      .command("disable <trigger_id>")
      .description("disable a trigger; ids look like job-name:trigger-id (see `auto job <name>`)")
      .addHelpText("after", "\nExample:\n  auto trigger disable hello-world:morning"),
    ([id]) => runTriggerDisable(id!),
  );

  // ---- Runs ----
  act(
    program
      .command("runs")
      .helpGroup(HELP_GROUPS.runs)
      .description("list recent runs, newest first")
      .option("--job <name>", "only runs of this job")
      .option("--state <state>", "only runs in this state (running, succeeded, failed, ...)")
      .option("-n, --limit <N>", "number of rows (default 20, at most 500)"),
    (_args, opts) =>
      runRuns({ job: opts.job as string | undefined, n: opts.limit as string | undefined, state: opts.state as string | undefined }),
  );
  act(
    program
      .command("log <run_id>")
      .helpGroup(HELP_GROUPS.runs)
      .description("print a run's log; with --follow keep printing until it finishes")
      .option("-f, --follow", "keep following the log until the run finishes")
      .addHelpText(
        "after",
        "\n<run_id> is the id shown by `auto runs` (8 characters is enough).\nWith --follow the exit code is 0 only if the run succeeded.\nExample:\n  auto log 1a2b3c4d --follow",
      ),
    ([id], opts) => runLog(id!, { follow: Boolean(opts.follow) }),
  );
  act(
    program
      .command("last <name>")
      .helpGroup(HELP_GROUPS.runs)
      .description("show the most recent run of a job with its log"),
    ([name]) => runLast(name!),
  );
  act(
    program
      .command("cancel <target>")
      .helpGroup(HELP_GROUPS.runs)
      .description("cancel a queued or running run, by run id or by job name")
      .addHelpText("after", "\nCancelling a running run asks first; pass -y to skip the question.\nExamples:\n  auto cancel 1a2b3c4d\n  auto -y cancel hello-world"),
    ([target]) => runCancel(target!),
  );

  // ---- Service ----
  const svc = program
    .command("svc")
    .helpGroup(HELP_GROUPS.service)
    .description("control the supervisor process and its OS watchdog");
  act(svc.command("install").description("same as `auto install`"), () => svcInstall());
  act(
    svc.command("uninstall").description("stop the supervisor and remove the watchdog (data/ and the auto shim are kept)"),
    () => svcUninstall(),
  );
  act(
    svc.command("start").description("start the supervisor now and register the watchdog (does nothing if it is already running)"),
    () => svcStart(),
  );
  act(
    svc.command("stop").description("stop the supervisor and remove the watchdog, so it stays stopped"),
    () => svcStop(),
  );
  act(
    svc.command("restart").description("stop, wait for the old supervisor to exit, then start again"),
    () => svcRestart(),
  );
  act(
    svc.command("tail").description("follow the supervisor log (data/state/supervisor.log)"),
    () => svcTail(),
  );

  const token = program
    .command("token")
    .helpGroup(HELP_GROUPS.service)
    .description("manage the API token");
  act(
    token
      .command("rotate")
      .description("replace the API token; open dashboards need a reload")
      .addHelpText("after", "\nThe CLI reads the new token itself. Reload open dashboards to pick it up."),
    () => runTokenRotate(),
  );

  act(
    program
      .command("ui")
      .helpGroup(HELP_GROUPS.service)
      .description("open the dashboard in your browser (with --json: print {\"url\"} only and do not open one)"),
    () => runUi(),
  );

  const data = program
    .command("data")
    .helpGroup(HELP_GROUPS.service)
    .description("manage the data directory (run history, logs, secrets, token)");
  act(
    data
      .command("wipe")
      .description("DESTRUCTIVE: delete all run history, logs, secrets and the token (config and workers stay)")
      .addHelpText("after", "\nShows what will be deleted and asks you to type 'wipe'; -y skips the question.\nThe supervisor must be stopped first (`auto svc stop`)."),
    () => runDataWipe(),
  );

  // ---- Diagnostics ----
  act(
    program
      .command("doctor")
      .helpGroup(HELP_GROUPS.diagnostics)
      .description("check the installation and say how to fix each problem")
      .addHelpText("after", "\nExit code is 1 if any check fails. Warnings and info lines do not fail."),
    () => runDoctor(),
  );
  act(
    program
      .command("version")
      .helpGroup(HELP_GROUPS.diagnostics)
      .description("print the CLI, supervisor and Bun versions"),
    () => runVersion(),
  );

  return { program, result };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const { program, result } = buildProgram();
  if (argv.length <= 2) {
    // A bare `auto` shows the command list rather than an error.
    program.outputHelp();
    return EX.OK;
  }
  const missing = missingOptionValue(argv, program.commands.map((c) => c.name()));
  if (missing) {
    status(missing);
    return EX.USAGE;
  }
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already printed help, the version, or its usage error.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return EX.OK;
      // `auto help <cmd>` exits 0; a group typed without its subcommand (`auto svc`) is a usage error.
      if (err.code === "commander.help") return err.exitCode === 0 ? EX.OK : EX.USAGE;
      return EX.USAGE;
    }
    const msg = err instanceof Error ? err.message : String(err);
    status(`error: ${msg}`);
    return EX.ERR;
  }
  return result.code;
}

/** Flush stdout and stderr before exiting, so piped output is not cut off. */
async function exitWhenFlushed(code: number): Promise<never> {
  await flushOutput();
  process.exit(code);
}

if (import.meta.main) {
  // `auto log ... | head` closes the pipe early; that is not an error.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" && stdoutClosedByReader()) process.exit(EX.OK);
  });
  void main(process.argv).then(
    (code) => exitWhenFlushed(code),
    (err) => {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      status(errColor.red(`fatal: ${msg}`));
      return exitWhenFlushed(EX.ERR);
    },
  );
}
