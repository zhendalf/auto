import { getBootstrap } from "../bootstrap.ts";
import { ApiError, isUnauthorized } from "../util/errors.ts";
import { isTerminalState } from "../util/runState.ts";
import type {
  ConfigStatus,
  Job,
  JobDetail,
  LogChunk,
  ReloadResult,
  Run,
  RunDetail,
  RunResult,
  RunsCursor,
  RunsPage,
} from "./types.ts";

export { ApiError, isUnauthorized, isTerminalState };
export type * from "./types.ts";

type Raw<T> = { data: T; status: number; headers: Headers };

/** The API token from the page's bootstrap tag, as a bearer header. */
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getBootstrap().token}` };
}

/**
 * One fetch with `Authorization: Bearer`; nothing else identifies the caller. A
 * failed fetch (supervisor down, network gone) becomes `ApiError(0)` so
 * callers only ever deal with one error type. A 401 becomes `ApiError(401)`.
 */
async function requestRaw<T>(method: string, path: string, body?: unknown): Promise<Raw<T>> {
  const { baseUrl } = getBootstrap();
  const headers: Record<string, string> = authHeaders();
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      credentials: "omit",
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new ApiError(res.status, errBody);
  }
  if (res.status === 204) return { data: undefined as T, status: res.status, headers: res.headers };
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? ((await res.json()) as T) : ((await res.text()) as T);
  return { data, status: res.status, headers: res.headers };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await requestRaw<T>(method, path, body)).data;
}

function cursorFrom(headers: Headers): RunsCursor | null {
  const before = Number(headers.get("x-next-before"));
  const beforeId = headers.get("x-next-before-id");
  return Number.isFinite(before) && before > 0 && beforeId ? { before, before_id: beforeId } : null;
}

async function fetchLogChunk(id: string, offset: number, method: "GET" | "HEAD"): Promise<LogChunk> {
  const { baseUrl } = getBootstrap();
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl}/api/runs/${encodeURIComponent(id)}/log${offset > 0 ? `?offset=${offset}` : ""}`,
      { method, headers: authHeaders(), credentials: "omit", cache: "no-store" },
    );
  } catch {
    throw new ApiError(0, null);
  }
  const state = res.headers.get("x-run-state");
  const size = Number(res.headers.get("x-log-size") ?? 0);
  if (res.ok) {
    const bytes = method === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
    return { kind: "data", bytes, size: Number.isFinite(size) ? size : offset + bytes.length, state };
  }
  const body = await res.json().catch(() => null);
  const code = (body as { error?: string } | null)?.error;
  if (res.status === 404 && (code === "no_log" || code === "log_missing")) {
    return { kind: "none", size: 0, state, reason: code };
  }
  if (res.status === 416) return { kind: "reset", size: Number.isFinite(size) ? size : 0, state };
  throw new ApiError(res.status, body);
}

/**
 * Saves a run's whole log to disk. A plain download link cannot send the
 * bearer header, so this fetches the log and hands the browser a blob.
 */
async function downloadRunLog(id: string, filename: string): Promise<void> {
  const { baseUrl } = getBootstrap();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(id)}/log`, {
      headers: authHeaders(),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The browser has started reading the blob by the time the click returns; a
  // short delay keeps the URL valid for slow starts.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const api = {
  jobs: () => request<Job[]>("GET", "/api/jobs"),
  job: (name: string) => request<JobDetail>("GET", `/api/jobs/${encodeURIComponent(name)}`),
  /** 200 = started, 202 = queued (with `position`). 409 and 422 arrive as ApiError. */
  runJob: async (name: string, body?: { force?: boolean; reason?: string }): Promise<RunResult> => {
    const r = await requestRaw<{ run_id: string; position?: number }>(
      "POST",
      `/api/jobs/${encodeURIComponent(name)}/run`,
      body,
    );
    return { ...r.data, status: r.status === 202 ? 202 : 200 };
  },
  enableJob: (name: string) =>
    request<void>("POST", `/api/jobs/${encodeURIComponent(name)}/enable`),
  disableJob: (name: string) =>
    request<void>("POST", `/api/jobs/${encodeURIComponent(name)}/disable`),
  pauseJob: (name: string, body: { duration_ms?: number; until_iso?: string }) =>
    request<{ paused_until: number }>(
      "POST",
      `/api/jobs/${encodeURIComponent(name)}/pause`,
      body,
    ),
  unpauseJob: (name: string) =>
    request<void>("POST", `/api/jobs/${encodeURIComponent(name)}/unpause`),
  enableTrigger: (id: string) =>
    request<void>("POST", `/api/triggers/${encodeURIComponent(id)}/enable`),
  disableTrigger: (id: string) =>
    request<void>("POST", `/api/triggers/${encodeURIComponent(id)}/disable`),
  runs: async (q?: {
    job?: string;
    state?: string;
    limit?: number;
    cursor?: RunsCursor | null;
  }): Promise<RunsPage> => {
    const sp = new URLSearchParams();
    if (q?.job) sp.set("job", q.job);
    if (q?.state) sp.set("state", q.state);
    if (q?.limit) sp.set("limit", String(q.limit));
    if (q?.cursor) {
      sp.set("before", String(q.cursor.before));
      sp.set("before_id", q.cursor.before_id);
    }
    const qs = sp.toString();
    const r = await requestRaw<Run[]>("GET", `/api/runs${qs ? `?${qs}` : ""}`);
    return { runs: r.data, next: cursorFrom(r.headers) };
  },
  run: (id: string) => request<RunDetail>("GET", `/api/runs/${encodeURIComponent(id)}`),
  /** Log bytes from `offset` on; see LogChunk for the calm no-log and truncated cases. */
  runLogChunk: (id: string, offset = 0) => fetchLogChunk(id, offset, "GET"),
  /** Size and run state only (HEAD), to decide how much of a long log to load. */
  runLogInfo: (id: string) => fetchLogChunk(id, 0, "HEAD"),
  downloadRunLog,
  cancelRun: (id: string) =>
    request<{ ok: true; previous_state: string }>(
      "POST",
      `/api/runs/${encodeURIComponent(id)}/cancel`,
    ),
  configStatus: () => request<ConfigStatus>("GET", "/api/config/status"),
  configReload: () => request<ReloadResult>("POST", "/api/config/reload"),
};

