// A small fake of the supervisor's HTTP API for CLI tests: runs with logs,
// job detail, run start/cancel, and an SSE stream the test can push events to.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeRun = {
  run_id: string;
  job_name: string;
  state: string;
  exit_code?: number | null;
  duration_ms?: number | null;
  /** Log text, or null when the run has no log file yet. */
  log: string | null;
  /** Send the X-Run-State header on log reads (default true). */
  stateHeader?: boolean;
};

export type FakeCall = { method: string; path: string; body: string | null; authorization: string | null };

export type Fake = {
  baseUrl: string;
  tokenFile: string;
  calls: FakeCall[];
  runs: Map<string, FakeRun>;
  jobs: Map<string, unknown>;
  /** Number of times a client opened /events. */
  sseConnects: () => number;
  /** Push a server-sent event to every open stream. */
  emit: (event: string, data: unknown) => void;
  /** Body of GET /api/config/status. */
  configStatus: Record<string, unknown>;
  /** When set, /api and /events answer 401 unless `Authorization: Bearer <this>` is sent. */
  requireToken: string | null;
  /** Milliseconds every /api/config/* answer is delayed by. */
  configDelayMs: number;
  /** Respond to POST /api/jobs/:name/run. Default: 200 with `{ run_id: <first run> }`. */
  startResponse: (name: string, body: Record<string, unknown>) => Response;
  stop: () => Promise<void>;
};

export const TERMINAL = new Set(["succeeded", "failed", "timed_out", "killed", "cancelled", "skipped", "lost"]);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A UUIDv7-shaped id whose last 8 hex digits are `tail` and whose first 8 are shared timestamp bits. */
export function fakeRunId(tail: string, first = "01a0eea2"): string {
  const h = (first + "0".repeat(16) + tail.padStart(8, "0")).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function startFakeApi(): Fake {
  const dir = mkdtempSync(join(tmpdir(), "cli-fake-api-"));
  const tokenFile = join(dir, ".token");
  writeFileSync(tokenFile, "fake-token\n", { mode: 0o600 });

  const calls: FakeCall[] = [];
  const runs = new Map<string, FakeRun>();
  const jobs = new Map<string, unknown>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let connects = 0;
  const enc = new TextEncoder();

  const findRun = (ref: string): FakeRun | null => {
    const hex = ref.replace(/-/g, "").toLowerCase();
    for (const run of runs.values()) {
      const id = run.run_id.replace(/-/g, "");
      if (run.run_id === ref || id.startsWith(hex) || id.endsWith(hex)) return run;
    }
    return null;
  };

  const detail = (r: FakeRun) => ({
    run_id: r.run_id,
    job_id: "job-1",
    job_name: r.job_name,
    trigger_kind: "manual",
    trigger_id: null,
    state: r.state,
    exit_code: r.exit_code ?? null,
    signal: null,
    enqueued_at: 1_790_000_000_000,
    started_at: 1_790_000_000_000,
    finished_at: TERMINAL.has(r.state) ? 1_790_000_003_000 : null,
    duration_ms: r.duration_ms ?? null,
    log_path: r.log === null ? null : "runs/x.log",
    definition_hash: null,
    trigger_meta: null,
  });

  const fake: Fake = {
    baseUrl: "",
    tokenFile,
    calls,
    runs,
    jobs,
    configStatus: {
      ok: true,
      loadedAt: 1_790_000_000_000,
      lastError: null,
      jobs: 1,
      triggers: 1,
      degraded: { active: false, reason: null },
      supervisor: { version: "0.3.0", commit: null },
    },
    requireToken: null,
    configDelayMs: 0,
    sseConnects: () => connects,
    emit: (event, data) => {
      const frame = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      for (const c of streams) {
        try {
          c.enqueue(frame);
        } catch {
          streams.delete(c);
        }
      }
    },
    startResponse: () => json(200, { run_id: [...runs.values()][0]?.run_id ?? "none" }),
    stop: async () => {
      for (const c of streams) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
      streams.clear();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        body,
        authorization: req.headers.get("authorization"),
      });
      const p = url.pathname;
      let m0: RegExpExecArray | null;

      if (p === "/healthz") return json(200, { ok: true, degraded: false });

      if (fake.requireToken !== null && req.headers.get("authorization") !== `Bearer ${fake.requireToken}`) {
        return json(401, { error: "unauthorized" });
      }

      if (p === "/api/config/status" && req.method === "GET") {
        if (fake.configDelayMs > 0) await Bun.sleep(fake.configDelayMs);
        return json(200, fake.configStatus);
      }
      if (p === "/api/config/reload" && req.method === "POST") {
        if (fake.configDelayMs > 0) await Bun.sleep(fake.configDelayMs);
        return json(200, { ok: true, jobs: 1, triggers: 1 });
      }

      m0 = /^\/api\/jobs\/([^/]+)\/pause$/.exec(p);
      if (m0 && req.method === "POST") return json(200, { ok: true, paused_until: 1_790_003_600_000 });

      if (p === "/events") {
        connects++;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            streams.add(c);
            c.enqueue(enc.encode(": connected\n\n"));
          },
          cancel() {
            streams.delete(controller);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }

      let m = /^\/api\/runs\/([^/]+)\/log$/.exec(p);
      if (m && req.method === "GET") {
        const run = findRun(decodeURIComponent(m[1]!));
        if (!run) return json(404, { error: "not_found" });
        const headers: Record<string, string> = run.stateHeader === false ? {} : { "x-run-state": run.state };
        if (run.log === null) return json(404, { error: "no_log" }, { ...headers, "x-log-size": "0" });
        const bytes = enc.encode(run.log);
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (offset > bytes.length) return json(416, { error: "offset_out_of_range", size: bytes.length }, headers);
        return new Response(bytes.slice(offset), {
          status: 200,
          headers: { "content-type": "text/plain", "x-log-size": String(bytes.length), ...headers },
        });
      }

      m = /^\/api\/runs\/([^/]+)\/cancel$/.exec(p);
      if (m && req.method === "POST") {
        const run = findRun(decodeURIComponent(m[1]!));
        if (!run) return json(404, { error: "not_found" });
        if (TERMINAL.has(run.state)) return json(409, { error: "already_finished", previous_state: run.state });
        const previous = run.state;
        run.state = "cancelled";
        return json(200, { ok: true, previous_state: previous });
      }

      m = /^\/api\/runs\/([^/]+)$/.exec(p);
      if (m && req.method === "GET") {
        const run = findRun(decodeURIComponent(m[1]!));
        return run ? json(200, detail(run)) : json(404, { error: "not_found" });
      }

      if (p === "/api/runs" && req.method === "GET") {
        return json(200, [...runs.values()].map(detail));
      }

      m = /^\/api\/jobs\/([^/]+)\/run$/.exec(p);
      if (m && req.method === "POST") {
        return fake.startResponse(decodeURIComponent(m[1]!), body ? (JSON.parse(body) as Record<string, unknown>) : {});
      }

      m = /^\/api\/jobs\/([^/]+)$/.exec(p);
      if (m && req.method === "GET") {
        const job = jobs.get(decodeURIComponent(m[1]!));
        return job ? json(200, job) : json(404, { error: "not_found" });
      }

      if (p === "/api/jobs" && req.method === "GET") return json(200, [...jobs.values()]);

      return json(404, { error: "not_found" });
    },
  });
  fake.baseUrl = `http://127.0.0.1:${server.port}`;
  return fake;
}
