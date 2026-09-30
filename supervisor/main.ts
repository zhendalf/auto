import { Database } from "bun:sqlite";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CronAdapter } from "./adapters/cron.ts";
import { buildInfo } from "./build-info.ts";
import { ConditionEvaluator } from "./condition-evaluator.ts";
import { WebhookAdapter } from "./adapters/webhook.ts";
import { SecretStore } from "./secrets.ts";
import {
  computeConfigWarnings,
  ConfigStore,
  validateConfigFile,
  type Config,
} from "./config.ts";
import { closeDb, DATA_DIR, DB_PATH, hardenTree, openDb } from "./db/connection.ts";
import { runMigrations, SchemaTooNewError } from "./db/migrate.ts";
import {
  acquireSingletonLock,
  degradedMode,
  dataDirIsForeignAtStart,
  ensureStateDirs,
  EX,
  LockHeld,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_HARD_DEADLINE_MS,
  writeLastError,
  type LockHandle,
} from "./lifecycle.ts";
import { installLogTee, LOG_REDIRECTED_ENV } from "./log-file.ts";
import { notifyOnce } from "./notify.ts";
import { recoverInterruptedRuns, recoveredTotal } from "./recovery.ts";
import { startRetention, type RetentionHandle } from "./retention.ts";
import { createSafetyNet } from "./safety-net.ts";
import { JobRegistry } from "./registry.ts";
import { Runner, type RunFinishedEvent } from "./runner.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { AUTO_PORT, ENV_PROBLEM, MIGRATIONS_DIR, UI_DIST_DIR, WORKSPACE_ROOT } from "../paths.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATION_ERROR_LOG = resolve(DATA_DIR, "migration-error.log");
const DEFAULT_PORT = AUTO_PORT;
// Shutdown budget (SHUTDOWN_GRACE_MS and the hard deadline live in lifecycle.ts
// so `auto svc stop` can wait for exactly as long as we may take).
// Runner.shutdown(SHUTDOWN_GRACE_MS) signals every worker process group and
// always resolves within SHUTDOWN_GRACE_MS + 2000 ms. The HTTP server and the
// config watcher stop concurrently with it, each capped, so the whole teardown
// stays inside SHUTDOWN_RUNNER_CAP_MS and below the hard deadline
// (SHUTDOWN_GRACE_MS + 5000 ms), which is the last-resort exit if a step wedges.
const SHUTDOWN_RUNNER_CAP_MS = SHUTDOWN_GRACE_MS + 2_500;
const SHUTDOWN_STEP_CAP_MS = 2_000;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type ParsedArgs = {
  check: boolean;
  port: number;
};

function usage(): string {
  return [
    "usage: bun supervisor/main.ts [--check] [--port <N>]",
    "  --check          validate config + report pending migrations, exit 0/78",
    `  --port <N>       HTTP port (default ${DEFAULT_PORT}, from AUTO_PORT; bound to 127.0.0.1 only)`,
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { check: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(EX.OK);
    } else if (arg === "--check") {
      out.check = true;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      if (!next) {
        process.stderr.write(`error: --port requires a value\n${usage()}\n`);
        process.exit(EX.USAGE);
      }
      const n = Number(next);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        process.stderr.write(`error: --port must be 1..65535, got ${next}\n`);
        process.exit(EX.USAGE);
      }
      out.port = n;
      i++;
    } else if (arg.startsWith("--port=")) {
      const n = Number(arg.slice("--port=".length));
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        process.stderr.write(`error: --port must be 1..65535\n`);
        process.exit(EX.USAGE);
      }
      out.port = n;
    } else {
      process.stderr.write(`error: unknown argument: ${arg}\n${usage()}\n`);
      process.exit(EX.USAGE);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration helpers (for --check)
// ---------------------------------------------------------------------------

const MIGRATION_FILE_RE = /^(\d{4})_(.+)\.sql$/;

function listMigrationFiles(): { version: string; name: string }[] {
  const entries = readdirSync(MIGRATIONS_DIR);
  const out: { version: string; name: string }[] = [];
  for (const entry of entries) {
    const m = MIGRATION_FILE_RE.exec(entry);
    if (!m) continue;
    out.push({ version: m[1]!, name: m[2]! });
  }
  out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return out;
}

function appliedMigrationVersions(db: Database): Set<string> {
  const tableExists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (!tableExists) return new Set();
  const rows = db
    .query<{ version: string }, []>("SELECT version FROM schema_migrations")
    .all();
  return new Set(rows.map((r) => r.version));
}

// ---------------------------------------------------------------------------
// --check mode
// ---------------------------------------------------------------------------

async function runCheck(): Promise<number> {
  // 1. Validate config. This is the same check a hot reload applies: schema,
  // cron syntax, job names, timer limits, and that every worker and checker
  // file exists.
  const valid = await validateConfigFile();
  if (!valid.ok) {
    process.stderr.write(`config error: ${valid.error}\n`);
    return EX.CONFIG;
  }
  const config: Config = valid.config;

  // 2. Warnings do not fail the check (the supervisor runs with them).
  const secrets = new SecretStore();
  for (const warning of computeConfigWarnings(config, (ref) => secrets.get(ref) !== null, WORKSPACE_ROOT)) {
    process.stderr.write(`warning: ${warning.message}\n`);
  }

  // 3. Compute pending migrations (no DB writes; never run them).
  const allMigrations = listMigrationFiles();
  let pending: { version: string; name: string }[];
  let dbMessage: string;
  if (!existsSync(DB_PATH)) {
    pending = allMigrations;
    dbMessage = `DB not initialized; would apply ${pending.length} migrations on first start`;
  } else {
    let roDb: Database | null = null;
    try {
      roDb = new Database(DB_PATH, { readonly: true });
      const applied = appliedMigrationVersions(roDb);
      const known = new Set(allMigrations.map((m) => m.version));
      const unknown = [...applied].filter((v) => !known.has(v)).sort();
      if (unknown.length > 0) {
        process.stderr.write(`${new SchemaTooNewError(unknown).message}\n`);
        return EX.CONFIG;
      }
      pending = allMigrations.filter((m) => !applied.has(m.version));
      dbMessage = `DB ok; ${pending.length} pending migrations`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`db read error: ${msg}\n`);
      return EX.CONFIG;
    } finally {
      try {
        roDb?.close();
      } catch {
        // ignore
      }
    }
  }

  // 4. Print status.
  const triggerCount = config.reduce((acc, j) => acc + j.triggers.length, 0);
  const pendingNames = pending.length === 0 ? "none" : pending.map((m) => m.version).join(", ");
  process.stdout.write(
    `OK config=valid jobs=${config.length} triggers=${triggerCount} migrations_pending=${pending.length} (${pendingNames}) [${dbMessage}]\n`,
  );
  return EX.OK;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Resources = {
  lock: LockHandle | null;
  db: Database | null;
  configStore: ConfigStore | null;
  registry: JobRegistry | null;
  cron: CronAdapter | null;
  conditions: ConditionEvaluator | null;
  runner: Runner | null;
  server: ServerHandle | null;
  webhook: WebhookAdapter | null;
  secrets: SecretStore | null;
  retention: RetentionHandle | null;
};

let notifiedThisDegradedEntry = false;

function maybeNotifyDegradedEntry(): void {
  const snap = degradedMode.snapshot();
  if (!snap.active) return;
  if (notifiedThisDegradedEntry) return;
  notifiedThisDegradedEntry = true;
  // The watchdog restarts the supervisor every minute; notifyOnce keeps a
  // persistent config error from notifying on every restart.
  void notifyOnce(
    `degraded:${snap.reason?.message ?? ""}`,
    "automations supervisor",
    "supervisor: degraded — config error",
  );
}

function clearDegradedNotification(): void {
  notifiedThisDegradedEntry = false;
}

type MainOptions = {
  /** Started by the cron watchdog: stay quiet when another supervisor is already up. */
  watchdog?: boolean;
};

// Set once startup has a lock to protect; lets the entry point and the
// process-level safety net run the graceful teardown from anywhere.
let activeShutdown: ((reason: string, exitCode: number) => void) | null = null;

async function main(argv: string[], mainOpts: MainOptions = {}): Promise<number> {
  if (ENV_PROBLEM) {
    process.stderr.write(`[supervisor] cannot start: ${ENV_PROBLEM}\n`);
    return EX.CONFIG;
  }
  // 1. Parse args.
  const args = parseArgs(argv);

  // 2. --check short-circuit.
  if (args.check) {
    return runCheck();
  }

  // 3. Ensure dirs (DATA_DIR and state/ are 0700).
  ensureStateDirs();
  // Fix what `auto version` reports to the code that is running now.
  buildInfo();

  // 4. Acquire singleton lock.
  const resources: Resources = {
    lock: null,
    db: null,
    configStore: null,
    registry: null,
    cron: null,
    conditions: null,
    runner: null,
    server: null,
    webhook: null,
    secrets: null,
    retention: null,
  };
  try {
    resources.lock = acquireSingletonLock();
  } catch (err) {
    if (err instanceof LockHeld) {
      if (!mainOpts.watchdog) {
        process.stderr.write(`supervisor already running (pid=${err.holderPid ?? "?"})\n`);
      }
      return EX.OK;
    }
    throw err;
  }

  // Mirror our output into data/state/supervisor.log unless the launcher
  // already pointed our stdio there (`auto svc start`).
  if (process.env[LOG_REDIRECTED_ENV] !== "1") installLogTee();

  // 5. Own the process signals and last-resort error handlers from here on, so
  // a signal or crash during startup still releases the lock and any workers.
  let shuttingDown = false;
  const beginShutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[supervisor] ${reason}, shutting down\n`);
    // Last-resort exit if a teardown step wedges.
    const hardTimer = setTimeout(() => {
      process.stderr.write(`[supervisor] graceful shutdown exceeded deadline; forcing exit\n`);
      try {
        resources.lock?.release();
      } catch {
        // ignore
      }
      process.exit(exitCode === EX.OK ? EX.TEMPFAIL : exitCode);
    }, SHUTDOWN_HARD_DEADLINE_MS);
    void (async () => {
      try {
        await teardown(resources);
      } catch {
        // teardown steps are individually guarded
      } finally {
        clearTimeout(hardTimer);
        process.exit(exitCode);
      }
    })();
  };
  activeShutdown = beginShutdown;
  process.on("SIGTERM", () => beginShutdown("received SIGTERM", EX.OK));
  process.on("SIGINT", () => beginShutdown("received SIGINT", EX.OK));
  process.on("SIGHUP", () => beginShutdown("received SIGHUP", EX.OK));
  createSafetyNet({
    log: (line) => process.stderr.write(`${line}\n`),
    recordError: writeLastError,
    fatal: (code) => beginShutdown("fatal error", code),
    exitCode: EX.SOFTWARE,
  }).install();

  // 6. Tighten permissions on anything already under DATA_DIR.
  const foreignData = dataDirIsForeignAtStart();
  if (foreignData) {
    process.stderr.write(
      `[supervisor] warning: ${DATA_DIR} already holds files that are not Auto's; leaving their permissions alone. Check AUTO_DATA_DIR.\n`,
    );
  }
  const hardened = foreignData ? 0 : hardenTree(DATA_DIR);
  if (hardened > 0) {
    process.stderr.write(`[supervisor] tightened permissions on ${hardened} entries under data/\n`);
  }

  // 7. Open DB.
  try {
    resources.db = openDb(DB_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`db open failed: ${message}\n`);
    writeLastError(err);
    await notifyOnce(`db-open:${message}`, "automations supervisor", "database could not be opened; see last-error.txt");
    resources.lock?.release();
    return EX.SOFTWARE;
  }

  // 8. Run migrations. A database newer than this build is refused untouched.
  try {
    await runMigrations(resources.db);
  } catch (err) {
    const tooNew = err instanceof SchemaTooNewError;
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    process.stderr.write(`${tooNew ? "refusing to start" : "migration failed"}: ${message}\n`);
    writeLastError(err);
    try {
      writeFileSync(MIGRATION_ERROR_LOG, message, { mode: 0o600 });
    } catch {
      // best-effort
    }
    await notifyOnce(
      `migration:${err instanceof Error ? err.message : message}`,
      "automations supervisor",
      tooNew
        ? "database is newer than this Auto build; update Auto"
        : "migration failed; see migration-error.log",
    );
    try {
      closeDb(resources.db);
    } catch {
      // ignore
    }
    resources.lock?.release();
    return tooNew ? EX.CONFIG : EX.SOFTWARE;
  }

  // 9. Recover from a previous supervisor that stopped uncleanly: finalize its
  // queued/running rows, stop orphaned workers, clear stale condition markers.
  let recoveredRows = 0;
  try {
    const recovery = recoverInterruptedRuns(resources.db, {
      log: (line) => process.stderr.write(`[supervisor] recovery: ${line}\n`),
    });
    recoveredRows = recoveredTotal(recovery);
    if (recoveredRows > 0) {
      process.stderr.write(
        `[supervisor] recovery: queued=${recovery.queued} running=${recovery.running} ` +
          `orphans_killed=${recovery.killed.length} conditions_reset=${recovery.conditionsCleared + recovery.conditionsCommitted}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[supervisor] recovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    writeLastError(err);
  }

  // 10. Secrets, then the config store, which loads the config and builds the
  // runtime (registry, runner, adapters) through `applyConfig`.
  resources.secrets = new SecretStore();
  try {
    resources.secrets.load();
  } catch (err) {
    process.stderr.write(`secrets load failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const secrets = resources.secrets;
  const hasSecret = (ref: string): boolean => secrets.get(ref) !== null;
  const emitSse = (event: string, data: unknown): void => {
    resources.server?.emit(event, data);
  };

  // Reconcile the schedulers with the registry's current state (config,
  // enabled flags, pauses). Also what the registry calls when the API changes
  // that state or a pause runs out.
  const applyScheduling = (): void => {
    const registry = resources.registry;
    if (!registry) return;
    resources.cron?.reconcile(registry.activeCronJobs());
    resources.webhook?.reconcile(registry.webhookJobs());
  };

  // Build the whole runtime from a first good config. Nothing is published
  // into `resources` until every part exists, so a failure leaves no
  // half-built runtime behind.
  const buildRuntime = (config: Config): void => {
    const db = resources.db!;
    const registry = new JobRegistry({ db, hasSecret });
    let cron: CronAdapter | null = null;
    try {
      registry.reconcile(config);
      const runner = new Runner({
        db,
        registry,
        workspaceRoot: WORKSPACE_ROOT,
        secrets: () => secrets.redactionValues(),
      });
      runner.on("run.queued", (e: { run_id: string; job_id: string; position?: number }) =>
        emitSse("run.queued", { ts: Date.now(), ...e }),
      );
      runner.on("run.started", (e: { run_id: string; job_id: string }) =>
        emitSse("run.started", { ts: Date.now(), ...e }),
      );
      runner.on("run.finished", (e: RunFinishedEvent) => emitSse("run.finished", { ts: Date.now(), ...e }));
      runner.on("run.skipped", (e: { run_id: string; job_id: string; reason: string }) =>
        emitSse("run.skipped", {
          ts: Date.now(),
          run_id: e.run_id,
          job_id: e.job_id,
          skip_reason: e.reason,
        }),
      );
      const conditionEvaluator = new ConditionEvaluator({ db, runner, workspaceRoot: WORKSPACE_ROOT });
      // A restart must not lose (or repeat) the fire of the minute it lands in.
      const fireRecorded = db.prepare(
        `SELECT 1 FROM runs WHERE trigger_id = ? AND trigger_kind = 'cron'
            AND json_extract(trigger_meta, '$.fire_at') = ? LIMIT 1`,
      );
      cron = new CronAdapter({
        runner,
        conditionEvaluator,
        alreadyRan: (triggerId, fireAt) => fireRecorded.get(triggerId, fireAt) !== null,
        onEvent: (ev) => {
          if (ev.kind === "missed") {
            process.stderr.write(
              `[cron] skipped a missed fire of ${ev.trigger_id} (${Math.round(ev.late_ms / 1000)}s late; machine asleep?)\n`,
            );
          } else if (ev.kind === "fire_error") {
            process.stderr.write(`[cron] ${ev.trigger_id} fire failed: ${ev.error}\n`);
          }
        },
      });
      const webhook = new WebhookAdapter({
        db,
        registry: () => resources.registry,
        runner: () => resources.runner,
        secrets,
        dataDir: DATA_DIR,
      });
      cron.reconcile(registry.activeCronJobs());
      webhook.reconcile(registry.webhookJobs());
      resources.registry = registry;
      resources.runner = runner;
      resources.cron = cron;
      resources.conditions = conditionEvaluator;
      resources.webhook = webhook;
    } catch (err) {
      try {
        cron?.stop();
      } catch {
        // ignore
      }
      registry.close();
      throw err;
    }
    registry.onStateChange(applyScheduling);
  };

  // The store commits a config only after this returns: a throw here keeps the
  // last-known-good config, records the error and emits no "reloaded".
  const applyConfig = (config: Config, previous: Config | null): void => {
    const registry = resources.registry;
    if (!registry || !resources.runner) {
      // Cold start, or the first good config after a degraded start.
      buildRuntime(config);
    } else {
      try {
        registry.reconcile(config);
        applyScheduling();
      } catch (err) {
        // The registry may already hold the new jobs; put the old ones back
        // so the database and the schedulers keep matching what is running.
        if (previous) {
          try {
            registry.reconcile(previous);
            applyScheduling();
          } catch {
            // best effort
          }
        }
        throw err;
      }
    }
    const snap = degradedMode.snapshot();
    if (snap.active && snap.reason?.kind === "config_error") {
      degradedMode.exit();
      clearDegradedNotification();
      // Dashboards left open on the degraded screen learn about the recovery.
      emitSse("degraded.exited", { ts: Date.now() });
    }
  };

  const configStore = new ConfigStore({ apply: applyConfig, hasSecret });
  resources.configStore = configStore;

  const announceReload = (payload: { previous: Config | null; current: Config }): void => {
    const triggers = payload.current.reduce((acc, j) => acc + j.triggers.length, 0);
    emitSse("config.reloaded", {
      ts: Date.now(),
      jobs: payload.current.length,
      triggers,
      loadedAt: Date.now(),
    });
  };
  // "loaded" is the first good config (at boot, or the recovery from a
  // degraded start); "reloaded" every later one.
  for (const event of ["loaded", "reloaded"] as const) {
    configStore.on(event, (payload: { previous: Config | null; current: Config }) => {
      const triggers = payload.current.reduce((acc, j) => acc + j.triggers.length, 0);
      process.stderr.write(`[supervisor] config ${event} jobs=${payload.current.length} triggers=${triggers}\n`);
      announceReload(payload);
    });
  }
  configStore.on("error", (err: Error) => {
    process.stderr.write(`[supervisor] config error: ${err.message}\n`);
    emitSse("config.error", { ts: Date.now(), message: err.message, at: Date.now() });
    // With no runtime yet the supervisor is degraded. Once a config has been
    // applied, a later bad edit keeps last-known-good running (D-05).
    if (!configStore.current) {
      degradedMode.enter({ kind: "config_error", message: err.message });
      maybeNotifyDegradedEntry();
    }
  });

  // Loads the config, builds the runtime, and keeps watching the file; a
  // missing or invalid config starts the supervisor degraded and it recovers
  // when the file becomes valid.
  await configStore.start();
  if (!configStore.current) {
    const message = configStore.lastError?.message ?? "config could not be loaded";
    writeLastError(new Error(message));
  } else if (!degradedMode.snapshot().active) {
    // A previous supervisor may have died while degraded.
    degradedMode.clearFlag();
  }

  // 13. Start HTTP server (always, even in degraded mode).
  try {
    resources.server = await startServer({
      db: resources.db,
      registry: () => resources.registry,
      cronAdapter: () => resources.cron,
      runner: () => resources.runner,
      webhookAdapter: () => resources.webhook,
      configStore: () => resources.configStore,
      port: args.port,
      uiDistDir: UI_DIST_DIR,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`http server failed to bind: ${message}\n`);
    writeLastError(err);
    await notifyOnce(`http-bind:${message}`, "automations supervisor", `could not bind port ${args.port}; see last-error.txt`);
    await teardown(resources);
    return EX.SOFTWARE;
  }

  // 14. One-line up message.
  const jobsCount = resources.registry ? resources.registry.activeJobs().length : 0;
  const isDegraded = degradedMode.snapshot().active;
  process.stdout.write(
    `[supervisor] up port=${args.port} jobs=${jobsCount} degraded=${isDegraded} recovered=${recoveredRows}\n`,
  );

  // Prune old runs, logs and receipts in the background (first sweep after 60 s).
  resources.retention = startRetention({ db: resources.db, dataDir: DATA_DIR });

  // Keep the event loop alive forever (HTTP server holds it; this is belt+braces).
  return await new Promise<number>(() => {
    // never resolves under normal operation
  });
}

/** Resolve when `work` settles or after `ms`, whichever comes first. Never rejects. */
async function within(ms: number, work: () => Promise<unknown> | unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => {}),
      new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function teardown(resources: Resources): Promise<void> {
  // No new work: stop the schedulers first.
  try {
    resources.cron?.stop();
  } catch {
    // ignore
  }

  resources.registry?.close();
  // The HTTP server and the config watcher stop while the runner drains, so
  // the total stays within the runner's own bound.
  await Promise.all([
    within(SHUTDOWN_STEP_CAP_MS, () => resources.server?.stop()),
    within(SHUTDOWN_STEP_CAP_MS, () => resources.configStore?.stop()),
    // A sweep in flight stops at its next batch boundary.
    within(SHUTDOWN_STEP_CAP_MS, () => resources.retention?.stop()),
    // A checker that is mid-run would otherwise outlive the supervisor.
    within(SHUTDOWN_STEP_CAP_MS, () => resources.conditions?.stop()),
    within(SHUTDOWN_RUNNER_CAP_MS, () => resources.runner?.shutdown(SHUTDOWN_GRACE_MS)),
  ]);
  // Safety net: whatever the runner left queued/running belongs to this
  // process, so finalize it and stop any worker it failed to reap.
  try {
    if (resources.db) {
      recoverInterruptedRuns(resources.db, { phase: "shutdown", termGraceMs: 500 });
    }
  } catch {
    // ignore
  }
  try {
    if (resources.db) closeDb(resources.db);
  } catch {
    // ignore
  }
  // Release lock last.
  try {
    resources.lock?.release();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  // Bun cron watchdog tick. While a supervisor is up this call never returns
  // (it is the supervisor); otherwise it returns quietly when one is already
  // running and throws on a startup failure so the host scheduler records it.
  async scheduled(): Promise<void> {
    const code = await main([], { watchdog: true });
    if (code !== EX.OK) throw new Error(`supervisor exited with code ${code}`);
  },
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  void main(argv).then(
    (code) => {
      // For --check (and other early returns), exit with the returned code.
      if (typeof code === "number") process.exit(code);
    },
    (err) => {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      process.stderr.write(`[supervisor] fatal: ${message}\n`);
      try {
        writeLastError(err);
      } catch {
        // ignore
      }
      process.exit(EX.SOFTWARE);
    },
  );
}
