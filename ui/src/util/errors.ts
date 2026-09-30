/**
 * API errors and the one place that turns them into words. Pure (no DOM, no
 * React) so the mapping is unit tested; `api/client.ts` re-exports ApiError.
 */

/**
 * A failed API call. `status` 0 means no HTTP response at all (the supervisor
 * is not running, or the network is down).
 */
export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(status === 0 ? "network error" : `api ${status}`);
  }

  /** The machine code from `{"error": "..."}`, when the body has one. */
  get code(): string | null {
    return errorBody(this.body).error ?? null;
  }
}

type ErrorBody = {
  error?: string;
  message?: string;
  details?: unknown;
  candidates?: string[];
  running_run_id?: string;
  run_id?: string;
  reason?: string;
  previous_state?: string;
  allowed?: string[];
  stage?: string;
};

function errorBody(body: unknown): ErrorBody {
  return body && typeof body === "object" ? (body as ErrorBody) : {};
}

/** The API rejected the token this page carries: it was rotated after the page loaded. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * The supervisor could not be reached. Besides a failed fetch this covers the
 * gateway statuses a dev proxy answers with when nothing listens behind it.
 */
export function isUnreachable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0 || err.status === 502 || err.status === 504) return true;
  // The Vite proxy answers 500 with an empty body when the supervisor is down;
  // the supervisor itself always sends a JSON error body.
  return err.status === 500 && err.body == null;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code !== "no_log";
}

/** 4xx responses are answers, not glitches: retrying them cannot change the outcome. */
export function isClientError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

/** React Query `retry` option: retry brief outages, never a 4xx. */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (isClientError(err)) return false;
  return failureCount < 2;
}

export type ErrorKind =
  | "unauthorized"
  | "unreachable"
  | "not_found"
  | "conflict"
  | "invalid"
  | "server"
  | "unknown";

export type DescribedError = {
  kind: ErrorKind;
  /** One short line, suitable as a heading or toast. */
  title: string;
  /** A sentence of detail; may be empty. */
  message: string;
  /** The API's machine code, when there is one. */
  code: string | null;
  status: number | null;
};

/** A 401 means the token changed; the page embeds the token, so a reload picks up the new one. */
export const TOKEN_CHANGED_TITLE = "The API token changed";
export const TOKEN_CHANGED_ACTION = "Reload this page to pick up the new one.";
export const TOKEN_CHANGED_MESSAGE = `${TOKEN_CHANGED_TITLE}. ${TOKEN_CHANGED_ACTION}`;

/** Why a run was skipped or ended without a normal exit, in words. */
const REASONS: Record<string, string> = {
  overlap: "the job is already running and its overlap policy is skip",
  queue_full: "the job is already running and its queue is full",
  disabled: "the job is disabled",
  paused: "the job is paused",
  shutdown: "the supervisor is shutting down",
  supervisor_shutdown: "the supervisor shut down while the run was in flight",
  supervisor_interrupted: "the supervisor stopped unexpectedly while the run was in flight",
  spawn_error: "the worker could not be started",
  finalize_error: "the supervisor could not record the run's result",
  cancelled: "the run was cancelled",
};

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  return REASONS[reason] ?? reason.replace(/_/g, " ");
}

function detailsText(details: unknown): string {
  if (typeof details === "string") return details;
  if (Array.isArray(details)) return details.map((d) => String(d)).join("; ");
  if (details && typeof details === "object") return JSON.stringify(details);
  return "";
}

const BY_CODE: Record<string, { title: string; message?: string; kind?: ErrorKind }> = {
  unauthorized: { title: TOKEN_CHANGED_TITLE, message: TOKEN_CHANGED_ACTION, kind: "unauthorized" },
  bad_host: {
    title: "Host not allowed",
    message:
      "The supervisor only accepts requests addressed to its own loopback address (127.0.0.1 or localhost with its port). Open the dashboard with `auto ui`, or list this host in AUTO_ALLOWED_HOSTS.",
    kind: "invalid",
  },
  bad_origin: { title: "Request blocked", message: "The request came from an unexpected origin.", kind: "invalid" },
  origin_required: { title: "Request blocked", message: "The request carried no Origin header.", kind: "invalid" },
  not_found: { title: "Not found", kind: "not_found" },
  invalid_run_id: { title: "Not a valid run id", message: "Use at least 6 hex digits of the run id.", kind: "invalid" },
  ambiguous_prefix: { title: "Ambiguous run id", message: "More than one run matches.", kind: "conflict" },
  already_finished: { title: "Run already finished", kind: "conflict" },
  conflict: { title: "Already running", kind: "conflict" },
  skipped: { title: "Run skipped", kind: "conflict" },
  invalid_body: { title: "The request was not accepted", kind: "invalid" },
  invalid_json: { title: "The request was not valid JSON", kind: "invalid" },
  invalid_until_iso: { title: "That time is not allowed", message: "Pick a time in the future, within a year.", kind: "invalid" },
  missing_duration_or_until: { title: "Give a duration or an end time", kind: "invalid" },
  payload_too_large: { title: "The request was too large", kind: "invalid" },
  not_ready: {
    title: "Supervisor is starting",
    message: "It is not ready to take requests yet. Try again in a moment.",
    kind: "unreachable",
  },
  supervisor_degraded: { title: "Supervisor is degraded", message: "Run `auto config status` for the cause.", kind: "server" },
  config_invalid: { title: "Config is invalid", kind: "invalid" },
  offset_out_of_range: { title: "The log was truncated", kind: "invalid" },
  no_log: { title: "No log yet", kind: "not_found" },
  log_missing: { title: "The log file is missing", kind: "not_found" },
  too_many_subscribers: { title: "Too many dashboards are open", kind: "server" },
  internal_error: { title: "The supervisor hit an internal error", message: "Check `auto svc tail`.", kind: "server" },
};

/** Turn anything thrown by an API call into a title and a sentence. */
export function describeError(err: unknown): DescribedError {
  if (!(err instanceof ApiError)) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "unknown", title: "Something went wrong", message, code: null, status: null };
  }
  const body = errorBody(err.body);
  const code = err.code;
  const base = { code, status: err.status || null } as const;

  if (err.status === 401) {
    return { ...base, kind: "unauthorized", title: TOKEN_CHANGED_TITLE, message: TOKEN_CHANGED_ACTION };
  }
  if (isUnreachable(err)) {
    return {
      ...base,
      kind: "unreachable",
      title: "Supervisor is not running",
      message: "Run `auto install` or `auto svc start`, then reload this page.",
    };
  }

  const known = code ? BY_CODE[code] : undefined;
  if (known) {
    let message = known.message ?? "";
    switch (code) {
      case "already_finished":
        message = body.previous_state ? `It had already ended (${body.previous_state}).` : "It had already ended.";
        break;
      case "conflict":
        message = "The job already has a run in flight.";
        break;
      case "skipped":
        message = body.reason ? `It was not started because ${reasonLabel(body.reason)}.` : "It was not started.";
        break;
      case "config_invalid":
        message = detailsText(body.details) || "The config file could not be loaded.";
        break;
      case "invalid_body":
      case "invalid_until_iso":
        message = detailsText(body.details) || message;
        break;
      case "ambiguous_prefix":
        message = body.candidates ? `${body.candidates.length} runs match; use more digits.` : message;
        break;
    }
    return { ...base, kind: known.kind ?? "unknown", title: known.title, message };
  }

  const detail = body.message ?? detailsText(body.details);
  if (err.status === 404) {
    return { ...base, kind: "not_found", title: "Not found", message: detail };
  }
  if (err.status >= 500) {
    return { ...base, kind: "server", title: "The supervisor reported an error", message: detail || `HTTP ${err.status}` };
  }
  return {
    ...base,
    kind: "unknown",
    title: `The request failed (HTTP ${err.status})`,
    message: [code, detail].filter(Boolean).join(": "),
  };
}

/** `title: message` on one line, for toasts and inline notes. */
export function errorSentence(err: unknown): string {
  const d = describeError(err);
  return d.message ? `${d.title}. ${d.message}` : d.title;
}

/**
 * The one action a stale-data warning should offer. A 401 cannot be retried
 * away (the token is baked into the page), so it says Reload; and while the
 * connection bar under the header is already showing a button for the same
 * problem, the warning offers none, instead of a second identical one.
 */
export function staleAction(
  err: unknown,
  connection: "connecting" | "open" | "retrying" | "unauthorized",
): "retry" | "reload" | "none" {
  if (connection === "unauthorized") return "none";
  if (isUnauthorized(err)) return "reload";
  if (connection === "retrying") return "none";
  return "retry";
}
