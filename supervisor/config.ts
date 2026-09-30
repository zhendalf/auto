import { EventEmitter } from "node:events";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT, CONFIG_PATH, WORKSPACE_ROOT } from "../paths.ts";
import { validateCronExpression } from "./adapters/cron.ts";
import { CONFIG_JSON_MARKER } from "./config-loader.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** setTimeout stores its delay in a signed 32-bit int; larger values fire after ~1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;
export const MAX_QUEUE_DEPTH = 1000;
export const JOB_NAME_MAX_LENGTH = 64;

const ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const ID_REGEX_MESSAGE = "lowercase, hyphens, no leading hyphen";
const WORKSPACE_PATH_MESSAGE = "must be workspace-relative, begin with ./, and not contain ..";
const WorkspacePathSchema = z.string().min(3).superRefine((value, ctx) => {
  const segments = value.replaceAll("\\", "/").split("/");
  if (!value.startsWith("./") || segments.includes("..")) {
    ctx.addIssue({ code: "custom", message: WORKSPACE_PATH_MESSAGE });
  }
});

// A job name is the job's identity everywhere: DB rows, the `<name>:<trigger>`
// trigger ids, URLs (`/api/jobs/:name`) and log lines. So it is limited to
// letters, digits, space, ".", "_" and "-": no ":" (it separates the trigger
// id), no "/", no control characters, no leading/trailing space, and not just
// dots ("." and ".." are path segments in a URL).
const JOB_NAME_CHARS = /^[\p{L}\p{N} ._-]+$/u;
const JOB_NAME_MESSAGE =
  `must be 1-${JOB_NAME_MAX_LENGTH} characters: letters, digits, space, ".", "_" or "-" ` +
  `(no ":" or "/", no leading or trailing space)`;
const JobNameSchema = z.string().superRefine((value, ctx) => {
  const ok =
    value.length >= 1 &&
    value.length <= JOB_NAME_MAX_LENGTH &&
    JOB_NAME_CHARS.test(value) &&
    value === value.trim() &&
    !/^\.+$/.test(value);
  if (!ok) ctx.addIssue({ code: "custom", message: JOB_NAME_MESSAGE });
});

export const CronTriggerSchema = z.object({
  kind: z.literal("cron"),
  id: z.string().min(1).regex(ID_REGEX, ID_REGEX_MESSAGE),
  // 5-field cron, machine local time. The syntax is checked by ConfigSchema
  // (validateCronExpression) so a bad schedule is rejected with the rest of
  // the config instead of failing later in the scheduler.
  schedule: z.string().min(1),
  condition: z.object({
    checker: WorkspacePathSchema,
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  }).optional(),
});

export const WebhookTriggerSchema = z.object({
  kind: z.literal("webhook"),
  id: z.string().min(1).regex(ID_REGEX, ID_REGEX_MESSAGE),
  path: z.string().min(1).regex(ID_REGEX, ID_REGEX_MESSAGE),
  auth: z.object({
    profile: z.literal("hmac-sha256"),
    secretRef: z.string().min(1).regex(ID_REGEX, ID_REGEX_MESSAGE),
    signatureHeader: z.string().min(1).transform((v) => v.toLowerCase()),
    signaturePrefix: z.string().default("sha256="),
  }),
  deliveryIdHeader: z.string().min(1).transform((v) => v.toLowerCase()).optional(),
  contentTypes: z.array(z.string().min(1)).min(1).default(["application/json"]),
  maxBodyBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1024 * 1024),
  keepPayload: z.boolean().default(false),
});

export const TriggerSchema = z.discriminatedUnion("kind", [CronTriggerSchema, WebhookTriggerSchema]);

export const ReentrancySchema = z.enum(["drop", "queue", "parallel"]);

export const AutomationSchema = z.object({
  // Config-level label, validated and unique, and shown by the API. It is NOT
  // the job's identity: the database keys a job by `name`, so renaming a job
  // archives the old row and starts a fresh history.
  id: z.string().min(1).regex(ID_REGEX, ID_REGEX_MESSAGE),
  // The job's identity (see JobNameSchema). UNIQUE across the config.
  name: JobNameSchema,
  description: z.string().optional(),
  // Path relative to the workspace root, leading "./".
  worker: WorkspacePathSchema,
  triggers: z.array(TriggerSchema).min(1),
  reentrancy: ReentrancySchema.default("drop"),
  queueDepth: z.number().int().positive().max(MAX_QUEUE_DEPTH).default(1),
  // 10 min default per Q-04.
  timeoutMs: z.number().int().positive().max(MAX_TIMER_MS).default(600_000),
  // 10 s grace before SIGKILL.
  killGraceMs: z.number().int().positive().max(MAX_TIMER_MS).default(10_000),
  enabled: z.boolean().default(true),
});

export const ConfigSchema = z
  .array(AutomationSchema)
  .superRefine((list, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    const triggerIds = new Set<string>();
    const webhookPaths = new Set<string>();
    list.forEach((a, i) => {
      if (ids.has(a.id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `duplicate job id: ${a.id}`,
        });
      }
      if (names.has(a.name)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "name"],
          message: `duplicate job name: ${a.name}`,
        });
      }
      ids.add(a.id);
      names.add(a.name);
      a.triggers.forEach((t, j) => {
        const key = `${a.name}:${t.id}`;
        if (triggerIds.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [i, "triggers", j, "id"],
            message: `duplicate trigger id within job: ${t.id}`,
          });
        }
        triggerIds.add(key);
        if (t.kind === "cron") {
          try {
            validateCronExpression(t.schedule);
          } catch (err) {
            ctx.addIssue({
              code: "custom",
              path: [i, "triggers", j, "schedule"],
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (t.kind === "webhook") {
          if (webhookPaths.has(t.path)) {
            ctx.addIssue({
              code: "custom",
              path: [i, "triggers", j, "path"],
              message: `duplicate webhook path: ${t.path}`,
            });
          }
          webhookPaths.add(t.path);
        }
      });
    });
  });

export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export { CONFIG_PATH };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The config (or the file that should hold it) was rejected; `failures` has one entry per problem. */
export class ConfigValidationError extends Error {
  constructor(public failures: string[], message?: string) {
    super(message ?? failures.join("; "));
    this.name = "ConfigValidationError";
  }
}

/** The config file could not be evaluated at all (missing, threw, timed out, not plain data). */
export class ConfigLoadError extends ConfigValidationError {
  constructor(failure: string) {
    super([failure], failure);
    this.name = "ConfigLoadError";
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const LOADER_PATH = resolve(PACKAGE_ROOT, "supervisor", "config-loader.ts");
const LOAD_TIMEOUT_MS = 10_000;
/** Largest config document accepted from the loader. */
const LOAD_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
/** Loader diagnostics kept for the error message. */
const LOAD_STDERR_MAX_BYTES = 16 * 1024;
const ERROR_TEXT_MAX_CHARS = 4000;

export type LoadConfigOptions = {
  /** Defaults to the resolved CONFIG_PATH. */
  configPath?: string;
  /** Loader cwd and base for `./` worker paths. Defaults to the workspace root. */
  workspaceRoot?: string;
  timeoutMs?: number;
  /** Extra environment for the loader; the supervisor's own environment is the base. */
  env?: Record<string, string | undefined>;
  /** Set to false to skip the worker/checker existence check. */
  checkFiles?: boolean;
  /** Aborting kills a loader that is still running (shutdown). */
  signal?: AbortSignal;
};

function labelFor(kind: string, raw: unknown, index: number, key: string): string {
  const value =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.length > 0 ? `${kind} "${value}"` : `${kind} #${index + 1}`;
}

/** "job "x", trigger "daily", schedule" from an issue path, using the raw document for names. */
function describeIssuePath(path: PropertyKey[], raw: unknown): string {
  if (path.length === 0) return "config";
  const parts: string[] = [];
  let rest = path;
  const jobIndex = rest[0];
  let jobRaw: unknown;
  if (typeof jobIndex === "number") {
    jobRaw = Array.isArray(raw) ? raw[jobIndex] : undefined;
    parts.push(labelFor("job", jobRaw, jobIndex, "name"));
    rest = rest.slice(1);
    if (rest[0] === "triggers" && typeof rest[1] === "number") {
      const triggers =
        typeof jobRaw === "object" && jobRaw !== null
          ? (jobRaw as Record<string, unknown>).triggers
          : undefined;
      const triggerRaw = Array.isArray(triggers) ? triggers[rest[1]] : undefined;
      parts.push(labelFor("trigger", triggerRaw, rest[1], "id"));
      rest = rest.slice(2);
    }
  }
  if (rest.length > 0) parts.push(rest.map(String).join("."));
  return parts.join(", ");
}

function zodFailures(err: z.ZodError, raw: unknown): string[] {
  return err.issues.map((issue) => `${describeIssuePath(issue.path, raw)}: ${issue.message}`);
}

function validationError(failures: string[], heading = "Config validation failed:"): ConfigValidationError {
  return new ConfigValidationError(failures, [heading, ...failures.map((f) => `  - ${f}`)].join("\n"));
}

type MissingFile = { owner: string; field: string; relative: string; problem: string };

/** Worker and condition-checker files of one job that are missing or not regular files. */
function missingFilesOf(job: Automation, workspaceRoot: string): MissingFile[] {
  const out: MissingFile[] = [];
  const check = (owner: string, field: string, relative: string): void => {
    const absolute = resolve(workspaceRoot, relative);
    let problem: string | null = null;
    try {
      if (!statSync(absolute).isFile()) problem = "is not a file";
    } catch {
      problem = "does not exist";
    }
    if (problem) out.push({ owner, field, relative, problem });
  };
  check(`job "${job.name}"`, "worker", job.worker);
  for (const trigger of job.triggers) {
    if (trigger.kind === "cron" && trigger.condition) {
      check(`job "${job.name}", trigger "${trigger.id}"`, "condition.checker", trigger.condition.checker);
    }
  }
  return out;
}

/**
 * Worker and condition-checker files of ENABLED jobs that are missing or not
 * regular files. A job with `enabled: false` never runs on its own, so its
 * files may be moved or deleted without making the whole config invalid
 * (that would stop every healthy job at the next restart); those show up as
 * warnings instead, see `computeConfigWarnings`.
 */
export function findMissingWorkspaceFiles(config: Config, workspaceRoot: string): string[] {
  const failures: string[] = [];
  for (const job of config) {
    if (!job.enabled) continue;
    for (const m of missingFilesOf(job, workspaceRoot)) {
      failures.push(`${m.owner}, ${m.field}: ${m.relative} ${m.problem} in the workspace`);
    }
  }
  return failures;
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  cap: number,
): Promise<{ text: string; overflow: boolean }> {
  if (!stream) return { text: "", overflow: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of stream) {
    if (overflow) continue;
    size += chunk.byteLength;
    if (size > cap) {
      overflow = true;
      continue;
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

function spawnLoader(
  configPath: string,
  workspaceRoot: string,
  env: Record<string, string | undefined> | undefined,
) {
  try {
    return Bun.spawn([process.execPath, LOADER_PATH, configPath], {
      cwd: workspaceRoot,
      env: { ...process.env, AUTO_HOME: workspaceRoot, AUTO_CONFIG: configPath, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new ConfigLoadError(
      `could not start the config loader: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Evaluate the config file in a short-lived subprocess and return its default export as parsed JSON. */
async function evaluateConfigFile(
  configPath: string,
  workspaceRoot: string,
  timeoutMs: number,
  env: Record<string, string | undefined> | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!existsSync(configPath)) throw new ConfigLoadError(`config file not found: ${configPath}`);
  if (signal?.aborted) throw new ConfigLoadError("config load cancelled");

  const proc = spawnLoader(configPath, workspaceRoot, env);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  // The loader runs user code that may never finish; whoever cancels the load
  // (supervisor shutdown) must not leave it behind as an orphan.
  const onAbort = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let out: { text: string; overflow: boolean };
  let errText: { text: string; overflow: boolean };
  let code: number;
  try {
    [out, errText, code] = await Promise.all([
      readCapped(proc.stdout, LOAD_STDOUT_MAX_BYTES),
      readCapped(proc.stderr, LOAD_STDERR_MAX_BYTES),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (signal?.aborted) throw new ConfigLoadError("config load cancelled");
  if (timedOut) {
    throw new ConfigLoadError(
      `config file did not finish loading within ${Math.round(timeoutMs / 1000)}s ` +
        `(a top-level await or a loop that never ends?)`,
    );
  }
  const diagnostics = errText.text.trim().slice(0, ERROR_TEXT_MAX_CHARS);
  if (code !== 0) {
    // The file can vanish between the existence check and the import (an
    // editor's delete-and-recreate save): say so instead of the raw import error.
    if (!existsSync(configPath)) throw new ConfigLoadError(`config file not found: ${configPath}`);
    throw new ConfigLoadError(
      `config file failed to load (exit ${code})${diagnostics ? `:\n${diagnostics}` : ""}`,
    );
  }
  if (out.overflow) {
    throw new ConfigLoadError(`config is larger than ${LOAD_STDOUT_MAX_BYTES} bytes once serialized`);
  }
  const at = out.text.lastIndexOf(CONFIG_JSON_MARKER);
  if (at < 0) throw new ConfigLoadError("config loader produced no output");
  const line = out.text.slice(at + CONFIG_JSON_MARKER.length).split("\n", 1)[0] ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new ConfigLoadError("config loader output was not valid JSON");
  }
}

/**
 * Load, parse and validate the config file. Everything that makes a config
 * unusable is rejected here, once, for hot reload and `--check` alike: the
 * schema, cron syntax, job names, timer limits and the existence of every
 * worker and checker file. Throws ConfigValidationError (ConfigLoadError when
 * the file could not be evaluated at all).
 */
export async function loadConfigOnce(opts: LoadConfigOptions = {}): Promise<{
  config: Config;
  raw: unknown;
}> {
  const configPath = opts.configPath ?? CONFIG_PATH;
  const workspaceRoot = opts.workspaceRoot ?? WORKSPACE_ROOT;
  const raw = await evaluateConfigFile(
    configPath,
    workspaceRoot,
    opts.timeoutMs ?? LOAD_TIMEOUT_MS,
    opts.env,
    opts.signal,
  );
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw validationError(zodFailures(parsed.error, raw));
  if (opts.checkFiles !== false) {
    const missing = findMissingWorkspaceFiles(parsed.data, workspaceRoot);
    if (missing.length > 0) throw validationError(missing, "workspace files missing:");
  }
  return { config: parsed.data, raw };
}

export async function validateConfigFile(
  opts: LoadConfigOptions = {},
): Promise<{ ok: true; config: Config } | { ok: false; error: string }> {
  try {
    const { config } = await loadConfigOnce(opts);
    return { ok: true, config };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** A problem that does not stop the config from loading but that the owner should fix. */
export type ConfigWarning = {
  code: "missing_secret" | "missing_file";
  job: string;
  trigger_id: string;
  message: string;
  /** For `missing_secret`: the name to give `auto secret set`. */
  secret?: string;
};

/**
 * Problems that leave the config usable:
 *  - webhook triggers whose `secretRef` has no value yet (every delivery is
 *    refused with 401 until it is set; needs `hasSecret`);
 *  - disabled jobs whose worker or checker file is missing (needs
 *    `workspaceRoot`); the same problem on an enabled job rejects the config.
 */
export function computeConfigWarnings(
  config: Config | null,
  hasSecret?: (ref: string) => boolean,
  workspaceRoot?: string,
): ConfigWarning[] {
  if (!config) return [];
  const out: ConfigWarning[] = [];
  if (workspaceRoot) {
    for (const job of config) {
      if (job.enabled) continue;
      const missing = missingFilesOf(job, workspaceRoot);
      if (missing.length === 0) continue;
      out.push({
        code: "missing_file",
        job: job.name,
        trigger_id: job.name,
        message:
          `job "${job.name}" is disabled and ${missing.map((m) => `${m.field} ${m.relative} ${m.problem}`).join(", ")}; ` +
          `it cannot run until that is fixed`,
      });
    }
  }
  if (!hasSecret) return out;
  for (const job of config) {
    for (const trigger of job.triggers) {
      if (trigger.kind !== "webhook") continue;
      let present = false;
      try {
        present = hasSecret(trigger.auth.secretRef);
      } catch {
        present = false;
      }
      if (!present) {
        out.push({
          code: "missing_secret",
          job: job.name,
          trigger_id: `${job.name}:${trigger.id}`,
          secret: trigger.auth.secretRef,
          message:
            `webhook trigger "${trigger.id}" of job "${job.name}" needs secret ` +
            `"${trigger.auth.secretRef}", which is not set; /hooks/${trigger.path} refuses every delivery (401) until it is set`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation diff
// ---------------------------------------------------------------------------

export function diffConfigForReconciliation(
  prev: Config | null,
  next: Config,
): { added: string[]; removed: string[]; changed: string[] } {
  const prevByName = new Map<string, Automation>();
  if (prev) for (const a of prev) prevByName.set(a.name, a);
  const nextByName = new Map<string, Automation>();
  for (const a of next) nextByName.set(a.name, a);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, a] of nextByName) {
    const before = prevByName.get(name);
    if (!before) {
      added.push(name);
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(a)) {
      changed.push(name);
    }
  }
  for (const name of prevByName.keys()) {
    if (!nextByName.has(name)) removed.push(name);
  }

  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

const RELOAD_DEBOUNCE_MS = 200;
/** Backstop for missed file-system events (and for a config file that does not exist yet). */
const POLL_INTERVAL_MS = 5_000;

export interface ConfigStoreStatus {
  ok: boolean;
  loadedAt: number | null;
  lastError: { at: number; message: string } | null;
  jobCount: number;
  warnings: ConfigWarning[];
}

/**
 * Puts a freshly validated config into effect (reconcile the registry and the
 * adapters). Throw to reject it: the store then keeps the last-known-good
 * config and reports the error.
 */
export type ConfigApplier = (next: Config, previous: Config | null) => void | Promise<void>;

export type ReloadOutcome =
  | { ok: true; config: Config; previous: Config | null; warnings: ConfigWarning[] }
  | { ok: false; stage: "load" | "apply" | "stopped"; error: string };

export type ConfigStoreOptions = {
  /** Defaults to the resolved CONFIG_PATH. */
  configPath?: string;
  /** Defaults to the workspace root. */
  workspaceRoot?: string;
  /** Replaces the subprocess loader (tests). */
  load?: () => Promise<{ config: Config }>;
  apply?: ConfigApplier;
  /** Tells whether a webhook secret has a value; feeds `warnings`. */
  hasSecret?: (ref: string) => boolean;
  debounceMs?: number;
  pollMs?: number;
};

/**
 * Holds the active config and keeps it in step with the file.
 *
 * `current`, `lastLoadedAt` and `lastError` describe what the supervisor is
 * actually running: they change only after the applier accepted a new config.
 * A file that fails to load or to apply leaves the last-known-good config in
 * place, sets `lastError` and emits "error". Events: "loaded" (first
 * successful load), "reloaded" ({previous, current}, every later success) and
 * "error" (Error). Reloads never run concurrently; edits that arrive while one
 * is running trigger exactly one more.
 */
export class ConfigStore extends EventEmitter {
  current: Config | null = null;
  lastError: { at: number; message: string } | null = null;
  lastLoadedAt: number | null = null;

  private readonly configPath: string;
  private readonly workspaceRoot: string;
  private readonly loadFn: () => Promise<{ config: Config }>;
  private applier: ConfigApplier | null;
  private hasSecret: ((ref: string) => boolean) | null;
  private readonly debounceMs: number;
  private readonly pollMs: number;

  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  // Aborted by stop() so a loader that never finishes dies with the store.
  private loading = new AbortController();
  private loadedOnce = false;
  // Reload serialization: `tail` is the last scheduled reload, `queued` the
  // one that has not started yet (callers share it).
  private tail: Promise<unknown> = Promise.resolve();
  private queued: Promise<ReloadOutcome> | null = null;
  // Identity of the file version the last (or running) reload read.
  private seenSignature: string | null = null;

  constructor(opts: ConfigStoreOptions = {}) {
    super();
    this.configPath = opts.configPath ?? CONFIG_PATH;
    this.workspaceRoot = opts.workspaceRoot ?? WORKSPACE_ROOT;
    this.loadFn =
      opts.load ??
      (() =>
        loadConfigOnce({
          configPath: this.configPath,
          workspaceRoot: this.workspaceRoot,
          signal: this.loading.signal,
        }));
    this.applier = opts.apply ?? null;
    this.hasSecret = opts.hasSecret ?? null;
    this.debounceMs = opts.debounceMs ?? RELOAD_DEBOUNCE_MS;
    this.pollMs = opts.pollMs ?? POLL_INTERVAL_MS;
  }

  /** Install the callback that puts a validated config into effect (before `start()`). */
  setApplier(apply: ConfigApplier | null): void {
    this.applier = apply;
  }

  setSecretProbe(hasSecret: ((ref: string) => boolean) | null): void {
    this.hasSecret = hasSecret;
  }

  /**
   * Load the config once, then start watching the file. Never throws: a
   * failure is recorded in `lastError` (and emitted) and the store keeps
   * watching, so the config is picked up as soon as it becomes valid.
   */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.loading.signal.aborted) this.loading = new AbortController();
    this.openWatcher();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), this.pollMs);
      this.pollTimer.unref?.();
    }
    await this.reload();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.loading.abort();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.closeWatcher();
  }

  getStatus(): ConfigStoreStatus {
    return {
      ok: this.current !== null && this.lastError === null,
      loadedAt: this.lastLoadedAt,
      lastError: this.lastError,
      jobCount: this.current?.length ?? 0,
      warnings: computeConfigWarnings(this.current, this.hasSecret ?? undefined, this.workspaceRoot),
    };
  }

  /** Re-read the file now. Resolves once the new config is in effect (or was rejected). */
  reload(): Promise<ReloadOutcome> {
    if (this.queued) return this.queued;
    const run = this.tail.then(() => {
      this.queued = null;
      return this.runReload();
    });
    this.queued = run;
    this.tail = run.catch(() => {});
    return run;
  }

  private async runReload(): Promise<ReloadOutcome> {
    if (this.stopped) return { ok: false, stage: "stopped", error: "config store is stopped" };
    this.seenSignature = this.fileSignature();

    let loaded: { config: Config };
    try {
      loaded = await this.loadFn();
    } catch (err) {
      return this.fail("load", err);
    }
    if (this.stopped) return { ok: false, stage: "stopped", error: "config store is stopped" };

    const previous = this.current;
    try {
      await this.applier?.(loaded.config, previous);
    } catch (err) {
      return this.fail("apply", err);
    }

    // Commit only now: the runtime runs this config.
    const first = !this.loadedOnce;
    this.loadedOnce = true;
    this.current = loaded.config;
    this.lastLoadedAt = Date.now();
    this.lastError = null;
    this.safeEmit(first ? "loaded" : "reloaded", { previous, current: loaded.config });
    return {
      ok: true,
      config: loaded.config,
      previous,
      warnings: computeConfigWarnings(loaded.config, this.hasSecret ?? undefined, this.workspaceRoot),
    };
  }

  private fail(stage: "load" | "apply", err: unknown): ReloadOutcome {
    // Keep last-known-good (Q-05/Q-09): `current` is untouched.
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = { at: Date.now(), message };
    if (this.listenerCount("error") > 0) this.safeEmit("error", new Error(message));
    return { ok: false, stage, error: message };
  }

  /** Emit, but never let a listener's exception undo or mask a decision already taken. */
  private safeEmit(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (err) {
      process.stderr.write(
        `[config] ${event} listener failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private fileSignature(): string {
    try {
      const st = statSync(this.configPath);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  // Watch the parent directory, not the file: an editor that saves by writing
  // a temp file and renaming it over the config replaces the inode a
  // file-level watcher is bound to, and a missing file cannot be watched at
  // all. The directory watch sees both, filtered by file name.
  private openWatcher(): void {
    if (this.stopped || this.watcher) return;
    const name = basename(this.configPath);
    try {
      const watcher = watch(dirname(this.configPath), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== name) return;
        this.scheduleReload();
      });
      watcher.on("error", () => {
        // The directory went away or the watch died; the poll re-opens it.
        if (this.watcher === watcher) this.closeWatcher();
      });
      this.watcher = watcher;
    } catch {
      // Parent directory missing; the poll retries.
      this.watcher = null;
    }
  }

  private closeWatcher(): void {
    if (!this.watcher) return;
    try {
      this.watcher.close();
    } catch {
      // ignore
    }
    this.watcher = null;
  }

  private poll(): void {
    if (this.stopped) return;
    if (!this.watcher) this.openWatcher();
    if (this.fileSignature() !== this.seenSignature) this.scheduleReload();
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reload();
    }, this.debounceMs);
  }
}
