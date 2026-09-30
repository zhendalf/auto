// API client for the supervisor's HTTP surface.
//
// All `/api/*` calls send a Bearer token (loaded from <DATA_DIR>/.token) and
// the loopback Origin so the supervisor's Origin/Host check passes. Read /
// write methods return parsed JSON or throw a typed error class.
//
// Errors:
//   - SupervisorUnreachable  — fetch refused / timed out (CLI maps to exit 3)
//   - TokenMissing           — .token file absent (CLI prints + exits 1)
//   - ApiError               — non-2xx response carrying parsed body
//
// No third-party deps; only `fetch`, `node:fs`, and `node:path`.
//
// Type definitions mirror the API JSON shapes (see supervisor/api/*.ts) but
// are intentionally redefined here so the CLI never imports from the
// supervisor module — the contract is HTTP, not file-level.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AUTO_BASE_URL, DATA_DIR } from "../paths.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SupervisorUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorUnreachable";
  }
}

/** The supervisor accepted the connection but did not answer in time: it is running, just slow. */
export class SupervisorTimeout extends Error {
  constructor(
    public readonly baseUrl: string,
    public readonly timeoutMs: number,
  ) {
    super(`the supervisor at ${baseUrl} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "SupervisorTimeout";
  }
}

export class TokenMissing extends Error {
  constructor(public readonly path: string) {
    super(`token file missing: ${path}`);
    this.name = "TokenMissing";
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`api error ${status}: ${describeBody(body)}`);
    this.name = "ApiError";
  }
}

function describeBody(body: unknown): string {
  if (body === null || body === undefined) return "(no body)";
  if (typeof body === "string") return body.slice(0, 200);
  try {
    return JSON.stringify(body).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}

// ---------------------------------------------------------------------------
// Public types — mirror API JSON shapes
// ---------------------------------------------------------------------------

export type LastRun = {
  run_id: string;
  state: string;
  finished_at: number | null;
};

export type TriggerEntry = {
  trigger_id: string;
  kind: string;
  enabled: boolean;
  /** Cron triggers: epoch ms of the next fire, or null when nothing is scheduled (disabled, paused, degraded). */
  next_run_at?: number | null;
  /** Cron triggers with a checker. */
  condition?: { checker: string; timeoutMs: number };
  /** Webhook triggers: the public path (/hooks/<path>), never the secret itself. */
  public_path?: string;
  secretRef?: string;
  signatureHeader?: string;
  deliveryIdHeader?: string | null;
  contentTypes?: string[];
  maxBodyBytes?: number;
  /** Whether the webhook secret currently has a value. */
  secret_present?: boolean;
  // additional kind-specific fields (e.g. schedule for cron) are flattened in.
  [key: string]: unknown;
};

/** The run in flight for a job: the running one, else the oldest queued one. */
export type ActiveRun = {
  run_id: string;
  state: string;
  started_at: number | null;
};

export type Job = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** `enabled: false` in the config file, independent of `auto disable`. */
  config_enabled?: boolean;
  paused_until: number | null;
  archived_at: number | null;
  reentrancy: string;
  queueDepth: number;
  timeoutMs: number;
  killGraceMs: number;
  triggers: TriggerEntry[];
  last_run: LastRun | null;
  active_run?: ActiveRun | null;
};

export type RecentRun = {
  run_id: string;
  job_id?: string;
  job_name?: string;
  duration_ms?: number | null;
  log_path?: string | null;
  definition_hash?: string | null;
  state: string;
  trigger_kind: string;
  trigger_id: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  signal: string | null;
  skip_reason?: string | null;
};

export type JobDetail = Job & { recent_runs: RecentRun[] };

export type Run = {
  run_id: string;
  job_id: string;
  job_name: string;
  trigger_kind: string;
  trigger_id: string | null;
  state: string;
  exit_code: number | null;
  signal: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  log_path: string | null;
  definition_hash: string | null;
  /** Why the run was skipped or ended abnormally on the supervisor's side (absent on older supervisors). */
  skip_reason?: string | null;
};

export type RunDetail = Run & { trigger_meta: unknown };

export type RunResult =
  | { status: 200; run_id: string }
  | { status: 202; run_id: string; position: number };

export type RotateResult = {
  ok: true;
  message: string;
  token_file: string;
};

/** A problem that does not stop the config from loading (for example a webhook secret that is not set). */
export type ConfigWarning = {
  code: string;
  job: string;
  trigger_id: string;
  message: string;
  /** For `missing_secret`: the name to give `auto secret set`. */
  secret?: string;
};

/** One read of a run's log at a byte offset (see `ApiClient.runLogFrom`). */
export type LogChunk = {
  /** Bytes from the requested offset to the end of the log as of this read. */
  bytes: Uint8Array;
  /** Total size of the log in bytes, as reported by the supervisor. */
  size: number;
  /** The run's state (X-Run-State header), or null when the supervisor did not send it. */
  state: string | null;
  /** The run has no log file yet (queued, or it never produced one). */
  missing: boolean;
  /** The requested offset was past the end of the log (the log was truncated or replaced). */
  outOfRange: boolean;
};

export type ConfigStatus = {
  ok: boolean;
  loadedAt: number | null;
  lastError: { at: number; message: string } | null;
  jobs: number;
  triggers: number;
  degraded: { active: boolean; reason: { kind: string; message: string } | null };
  warnings?: ConfigWarning[];
  /** The code the running supervisor was started from (absent on older supervisors). */
  supervisor?: { version: string; commit: string | null };
};

export type ReloadResult = {
  ok: true;
  jobs: number;
  triggers: number;
  errors?: unknown[];
  warnings?: ConfigWarning[];
  changes?: { added: string[]; removed: string[]; changed: string[] };
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = AUTO_BASE_URL;
const DEFAULT_TIMEOUT_MS = 5_000;
/** A reload waits for the config file to be evaluated (the supervisor allows that 10 s). */
const RELOAD_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

export type ApiClientOpts = {
  baseUrl?: string;
  tokenFile?: string;
  timeoutMs?: number;
};

export class ApiClient {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly timeoutMs: number;
  private cachedToken: string | null = null;

  constructor(opts?: ApiClientOpts) {
    this.baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.tokenFile = opts?.tokenFile ?? resolve(DATA_DIR, ".token");
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Load + cache the token. Throws TokenMissing if the file is absent. */
  get token(): string {
    if (this.cachedToken !== null) return this.cachedToken;
    if (!existsSync(this.tokenFile)) throw new TokenMissing(this.tokenFile);
    const raw = readFileSync(this.tokenFile, "utf8").trim();
    if (raw.length === 0) throw new TokenMissing(this.tokenFile);
    this.cachedToken = raw;
    return raw;
  }

  /** Forget the cached token so the next call re-reads the token file (e.g. after rotation). */
  refreshToken(): string {
    this.cachedToken = null;
    return this.token;
  }

  /** The SSE endpoint. Authenticate with `Authorization: Bearer <token>`; never put the token in the URL. */
  eventsUrl(): string {
    return this.url("/events");
  }

  /** Build the full URL for an API path (path may start with `/`). */
  url(path: string): string {
    if (!path.startsWith("/")) path = "/" + path;
    return `${this.baseUrl}${path}`;
  }

  /**
   * Lightweight reachability check. Returns true on 200 or 503 (supervisor
   * is up, even if degraded). Returns false on connection refusal / timeout.
   */
  async reachable(): Promise<boolean> {
    try {
      const res = await this.rawFetch(this.url("/healthz"), {
        method: "GET",
        // No auth, no Origin needed.
      });
      return res.status === 200 || res.status === 503;
    } catch (err) {
      if (err instanceof SupervisorUnreachable) return false;
      // Anything else (e.g. malformed URL) we treat as unreachable too.
      return false;
    }
  }

  /** Time a healthz GET; returns latency ms on success or null on failure. */
  async healthzLatencyMs(): Promise<{ ok: boolean; status: number | null; ms: number | null }> {
    const start = Date.now();
    try {
      const res = await this.rawFetch(this.url("/healthz"), { method: "GET" });
      return { ok: res.status === 200 || res.status === 503, status: res.status, ms: Date.now() - start };
    } catch {
      return { ok: false, status: null, ms: null };
    }
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  private async rawFetch(url: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      throw mapFetchError(err, this.baseUrl, timeoutMs);
    }
  }

  /**
   * An authenticated fetch. A 401 with a token that has since changed on disk
   * (`auto token rotate` in another shell) is retried once with the new token,
   * so a long-running `auto run` or `auto log --follow` survives a rotation.
   */
  private async authedFetch(
    url: string,
    build: () => RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const res = await this.rawFetch(url, build(), timeoutMs);
    if (res.status !== 401) return res;
    const before = this.cachedToken;
    let fresh: string;
    try {
      fresh = this.refreshToken();
    } catch {
      return res;
    }
    if (fresh === before) return res;
    await res.body?.cancel().catch(() => {});
    return this.rawFetch(url, build(), timeoutMs);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      origin: this.baseUrl,
      ...(extra ?? {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const build = (): RequestInit => {
      const init: RequestInit = { method, headers: this.headers() };
      if (body !== undefined) {
        (init.headers as Record<string, string>)["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return init;
    };
    const res = await this.authedFetch(this.url(path), build, timeoutMs);
    if (res.status >= 200 && res.status < 300) {
      // Some endpoints return no JSON body (e.g. enable/disable on success).
      const text = await res.text();
      if (text.length === 0) return undefined as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    let parsed: unknown = null;
    try {
      const text = await res.text();
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw new ApiError(res.status, parsed);
  }

  /** Special-case: a request that may return 200 OR 202 with a body. */
  private async requestRunStarter(
    path: string,
    body: unknown,
  ): Promise<RunResult> {
    const res = await this.authedFetch(this.url(path), () => ({
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }));
    let parsed: unknown = null;
    const text = await res.text();
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.status === 200) {
      const obj = parsed as { run_id?: string };
      if (typeof obj?.run_id !== "string") throw new ApiError(res.status, parsed);
      return { status: 200, run_id: obj.run_id };
    }
    if (res.status === 202) {
      const obj = parsed as { run_id?: string; position?: number };
      if (typeof obj?.run_id !== "string") throw new ApiError(res.status, parsed);
      return {
        status: 202,
        run_id: obj.run_id,
        position: typeof obj.position === "number" ? obj.position : 0,
      };
    }
    throw new ApiError(res.status, parsed);
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  jobs(): Promise<Job[]> {
    return this.request<Job[]>("GET", "/api/jobs");
  }

  job(name: string): Promise<JobDetail> {
    return this.request<JobDetail>("GET", `/api/jobs/${encodeURIComponent(name)}`);
  }

  runJob(name: string, body?: { force?: boolean; reason?: string }): Promise<RunResult> {
    return this.requestRunStarter(
      `/api/jobs/${encodeURIComponent(name)}/run`,
      body ?? {},
    );
  }

  enableJob(name: string): Promise<void> {
    return this.request<void>("POST", `/api/jobs/${encodeURIComponent(name)}/enable`);
  }

  disableJob(name: string): Promise<void> {
    return this.request<void>("POST", `/api/jobs/${encodeURIComponent(name)}/disable`);
  }

  pauseJob(
    name: string,
    body: { duration_ms?: number; until_iso?: string },
  ): Promise<{ ok: true; paused_until: number }> {
    return this.request<{ ok: true; paused_until: number }>(
      "POST",
      `/api/jobs/${encodeURIComponent(name)}/pause`,
      body,
    );
  }

  unpauseJob(name: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(
      "POST",
      `/api/jobs/${encodeURIComponent(name)}/unpause`,
    );
  }

  enableTrigger(triggerId: string): Promise<void> {
    return this.request<void>(
      "POST",
      `/api/triggers/${encodeURIComponent(triggerId)}/enable`,
    );
  }

  disableTrigger(triggerId: string): Promise<void> {
    return this.request<void>(
      "POST",
      `/api/triggers/${encodeURIComponent(triggerId)}/disable`,
    );
  }

  runs(query?: {
    job?: string;
    state?: string;
    limit?: number;
    before?: number;
  }): Promise<Run[]> {
    const qs: string[] = [];
    if (query?.job) qs.push(`job=${encodeURIComponent(query.job)}`);
    if (query?.state) qs.push(`state=${encodeURIComponent(query.state)}`);
    if (typeof query?.limit === "number") qs.push(`limit=${query.limit}`);
    if (typeof query?.before === "number") qs.push(`before=${query.before}`);
    const suffix = qs.length > 0 ? `?${qs.join("&")}` : "";
    return this.request<Run[]>("GET", `/api/runs${suffix}`);
  }

  run(runId: string): Promise<RunDetail> {
    return this.request<RunDetail>("GET", `/api/runs/${encodeURIComponent(runId)}`);
  }

  async runLog(runId: string): Promise<string> {
    const res = await this.authedFetch(this.url(`/api/runs/${encodeURIComponent(runId)}/log`), () => ({
      method: "GET",
      headers: this.headers(),
    }));
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) return text;
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    throw new ApiError(res.status, parsed);
  }

  /**
   * Read the log from `offset` (bytes). Unlike `runLog` this never throws for
   * "no log yet": it reports `missing` together with the run's state, so a
   * follower can wait for a queued run to start. Bytes, not text, so a
   * multi-byte character split across two reads decodes correctly.
   */
  async runLogFrom(runId: string, offset: number): Promise<LogChunk> {
    const res = await this.authedFetch(
      this.url(`/api/runs/${encodeURIComponent(runId)}/log?offset=${offset}`),
      () => ({ method: "GET", headers: this.headers() }),
    );
    const state = res.headers.get("x-run-state");
    const sizeHeader = Number(res.headers.get("x-log-size"));
    if (res.status === 200) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const size = Number.isFinite(sizeHeader) && res.headers.has("x-log-size") ? sizeHeader : offset + bytes.length;
      return { bytes, size, state, missing: false, outOfRange: false };
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const code = (parsed as { error?: unknown } | null)?.error;
    if (res.status === 404 && state !== null && (code === "no_log" || code === "log_missing")) {
      return { bytes: new Uint8Array(0), size: 0, state, missing: true, outOfRange: false };
    }
    if (res.status === 416) {
      const size = (parsed as { size?: unknown } | null)?.size;
      return {
        bytes: new Uint8Array(0),
        size: typeof size === "number" ? size : 0,
        state,
        missing: false,
        outOfRange: true,
      };
    }
    throw new ApiError(res.status, parsed);
  }

  cancelRun(runId: string): Promise<{ ok: true; previous_state: string }> {
    return this.request<{ ok: true; previous_state: string }>(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }

  configStatus(): Promise<ConfigStatus> {
    return this.request<ConfigStatus>("GET", "/api/config/status");
  }

  configReload(): Promise<ReloadResult> {
    return this.request<ReloadResult>("POST", "/api/config/reload", undefined, RELOAD_TIMEOUT_MS);
  }

  /**
   * Replace the API token. The old token and every open event stream stop
   * working at once; open dashboards must be reloaded to fetch the new token
   * from `/`. The new token is only in the token file, which this client
   * re-reads afterwards.
   */
  async rotateToken(): Promise<RotateResult> {
    const result = await this.request<RotateResult>("POST", "/api/token/rotate");
    this.cachedToken = null;
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFetchError(err: unknown, baseUrl: string, timeoutMs: number): Error {
  if (err instanceof Error) {
    const message = err.message ?? "";
    const name = err.name ?? "";
    // AbortSignal.timeout(): the connection was made, the answer was slow.
    if (name === "TimeoutError") return new SupervisorTimeout(baseUrl, timeoutMs);
    // Bun's fetch surfaces "ConnectionRefused", "Failed to fetch", or
    // "ECONNREFUSED" depending on the failure mode.
    if (
      name === "AbortError" ||
      message.includes("ECONNREFUSED") ||
      message.includes("ConnectionRefused") ||
      message.toLowerCase().includes("connection refused") ||
      message.includes("Unable to connect") ||
      message.includes("failed to fetch") ||
      message.includes("Failed to fetch") ||
      message.includes("connect ECONNREFUSED")
    ) {
      return new SupervisorUnreachable(baseUrl);
    }
  }
  // Other errors — wrap them too; treating them as unreachable is the
  // conservative move (CLI exits 3 with a clear message).
  return new SupervisorUnreachable(baseUrl);
}
