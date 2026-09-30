import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { CronAdapter } from "./adapters/cron.ts";
import type { ConfigStore } from "./config.ts";
import type { JobRegistry } from "./registry.ts";
import type { Runner } from "./runner.ts";
import type { WebhookAdapter } from "./adapters/webhook.ts";
import { degradedMode } from "./lifecycle.ts";

import {
  AuthState,
  buildHostPolicy,
  crossSiteSubresource,
  hostAllowed,
  loadOrCreateToken,
  originAllowed,
  parseAllowedHosts,
  proxiedLoopbackRequest,
  rotateTokenFile,
  TOKEN_PATH,
  type HostPolicy,
} from "./auth.ts";
import { SSEBroadcaster } from "./sse.ts";
import { Router, errorJson, json, methodNotAllowed, type RouteHandler } from "./api/router.ts";
import { makeJobsHandlers } from "./api/jobs.ts";
import { makeRunsHandlers } from "./api/runs.ts";
import { makeTriggersHandlers } from "./api/triggers.ts";
import { makeConfigHandlers } from "./api/config.ts";
import { looksLikeFileRequest, resolveStaticFile } from "./static-files.ts";
import { UI_DIST_DIR } from "../paths.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StartServerOptions = {
  db: Database;
  /** Provider so the server picks up the live registry when it's swapped on degraded recovery. */
  registry: () => JobRegistry | null;
  cronAdapter: () => CronAdapter | null;
  runner: () => Runner | null;
  webhookAdapter?: () => WebhookAdapter | null;
  configStore: () => ConfigStore | null;
  port: number;
  /** Built UI directory. Defaults to the copy shipped with the package. */
  uiDistDir?: string;
  /** Override token path (tests). */
  tokenPath?: string;
  /** Override data dir (tests). */
  dataDir?: string;
  /** Override SSE heartbeat (tests). */
  heartbeatMs?: number;
  /** Extra exact `Host` values to accept; defaults to the AUTO_ALLOWED_HOSTS env var. */
  allowedHosts?: string[];
  /** Cap on concurrent SSE subscribers (tests). */
  maxSubscribers?: number;
  /** Accepted for compatibility; /healthz no longer reports uptime. */
  startedAtMs?: number;
};

export type ServerHandle = {
  port: number;
  /** The live API token; changes when it is rotated. */
  readonly token: string;
  emit: (event: string, data: unknown) => void;
  subscriberCount: () => number;
  stop: () => Promise<void>;
};

/** Largest webhook body (10 MiB, see config.ts) plus room for headers/framing. */
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024 + 64 * 1024;

/**
 * Seconds a connection may sit idle before Bun closes it. Bun's default (10 s)
 * is shorter than the 15 s SSE heartbeat and silently kills every event stream
 * between pings, so it is raised well above the heartbeat.
 */
const IDLE_TIMEOUT_S = 60;

const MAX_ASSET_DEPTH = 4;

// The built UI ships one external stylesheet and one module script, so
// nothing needs `'unsafe-inline'`.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Other sites may not embed or read anything served here (the page at / carries the token).
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Add the security headers (and a `no-store` default) to any response. */
function hardened(res: Response): Response {
  const apply = (headers: Headers): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    if (!headers.has("cache-control")) headers.set("Cache-Control", "no-store");
  };
  try {
    apply(res.headers);
    return res;
  } catch {
    // Immutable headers (e.g. Response.redirect): rebuild the response.
    const headers = new Headers(res.headers);
    apply(headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const distDir = opts.uiDistDir ?? UI_DIST_DIR;
  const assetsDir = resolve(distDir, "assets");
  const indexPath = resolve(distDir, "index.html");

  const tokenPath = opts.tokenPath ?? TOKEN_PATH;
  // Streams opened with a token that stops working (rotation, or the token
  // file replaced on disk) are closed so their clients reconnect and learn it.
  let broadcaster!: SSEBroadcaster;
  const auth = new AuthState(loadOrCreateToken({ tokenPath }), {
    tokenPath,
    onChange: () => broadcaster?.disconnectAll(),
  });
  const extraHosts = opts.allowedHosts ?? parseAllowedHosts(process.env.AUTO_ALLOWED_HOSTS);
  if (extraHosts.length > 0) {
    // The page at / carries the API token, so an extra host is a trust decision.
    process.stderr.write(
      `[server] AUTO_ALLOWED_HOSTS lists ${extraHosts.join(", ")}: anyone who can reach ${
        extraHosts.length === 1 ? "that name" : "those names"
      } gets the API token from /. Only use names behind an access-controlled proxy or VPN.\n`,
    );
  }
  broadcaster = new SSEBroadcaster({
    heartbeatMs: opts.heartbeatMs,
    maxSubscribers: opts.maxSubscribers,
  });

  // Helper that all API handlers can use to fan a config.reloaded event with
  // current job/trigger counts. Cheap; only fires after a state-mutating call.
  const emitConfigReloadedWithCounts = (): void => {
    const reg = opts.registry();
    const jobs = reg ? reg.activeJobs() : [];
    const triggers = jobs.reduce((acc, j) => acc + j.triggers.length, 0);
    broadcaster.emit("config.reloaded", {
      ts: Date.now(),
      jobs: jobs.length,
      triggers,
      loadedAt: Date.now(),
    });
  };
  const emitConfigError = (message: string): void => {
    broadcaster.emit("config.error", { ts: Date.now(), message, at: Date.now() });
  };

  const apiCtx = {
    db: opts.db,
    registry: opts.registry,
    cronAdapter: opts.cronAdapter,
    runner: opts.runner,
    emitConfigReloaded: emitConfigReloadedWithCounts,
  };

  const jobsHandlers = makeJobsHandlers(apiCtx);
  const runsHandlers = makeRunsHandlers({
    db: opts.db,
    runner: opts.runner,
    dataDir: opts.dataDir,
  });
  const triggersHandlers = makeTriggersHandlers(apiCtx);
  const configHandlers = makeConfigHandlers({
    configStore: opts.configStore,
    emitConfigReloaded: emitConfigReloadedWithCounts,
    emitConfigError,
  });

  // -------------------------------------------------------------------------
  // Auth endpoints
  // -------------------------------------------------------------------------

  /**
   * Replace the API token. The old bearer stops working and open event streams
   * end; a dashboard reload picks up the new token from `/`.
   */
  const rotateToken: RouteHandler = () => {
    let next: string;
    try {
      next = rotateTokenFile(tokenPath);
    } catch (err) {
      logError("token rotation failed", err);
      return errorJson(500, "rotate_failed");
    }
    auth.setToken(next);
    broadcaster.disconnectAll();
    return json({
      ok: true,
      message: "token rotated; reload open dashboards. The CLI reads the new token from data/.token by itself",
      token_file: "data/.token",
    });
  };

  const router = new Router([
    { method: "GET", pattern: "/api/jobs", handler: jobsHandlers.list },
    { method: "GET", pattern: "/api/jobs/:name", handler: jobsHandlers.detail },
    { method: "POST", pattern: "/api/jobs/:name/run", handler: jobsHandlers.run },
    { method: "POST", pattern: "/api/jobs/:name/enable", handler: jobsHandlers.enable },
    { method: "POST", pattern: "/api/jobs/:name/disable", handler: jobsHandlers.disable },
    { method: "POST", pattern: "/api/jobs/:name/pause", handler: jobsHandlers.pause },
    { method: "POST", pattern: "/api/jobs/:name/unpause", handler: jobsHandlers.unpause },
    { method: "POST", pattern: "/api/triggers/:trigger_id/enable", handler: triggersHandlers.enable },
    { method: "POST", pattern: "/api/triggers/:trigger_id/disable", handler: triggersHandlers.disable },
    { method: "GET", pattern: "/api/runs", handler: runsHandlers.list },
    { method: "GET", pattern: "/api/runs/:run_id", handler: runsHandlers.detail },
    { method: "GET", pattern: "/api/runs/:run_id/log", handler: runsHandlers.log },
    { method: "POST", pattern: "/api/runs/:run_id/cancel", handler: runsHandlers.cancel },
    { method: "GET", pattern: "/api/config/status", handler: configHandlers.status },
    { method: "POST", pattern: "/api/config/reload", handler: configHandlers.reload },
    { method: "POST", pattern: "/api/token/rotate", handler: rotateToken },
  ]);

  // -------------------------------------------------------------------------
  // Healthz handler: unauthenticated, so it answers with as little as possible.
  // -------------------------------------------------------------------------

  const healthz: RouteHandler = () => {
    const degraded = degradedMode.snapshot().active;
    return json({ ok: !degraded, degraded }, { status: degraded ? 503 : 200 });
  };

  // -------------------------------------------------------------------------
  // Bun.serve
  // -------------------------------------------------------------------------

  // The Host allowlist depends on the bound port (which may be OS-assigned
  // when opts.port is 0), so it is rebuilt once the server is listening.
  let policy: HostPolicy = buildHostPolicy(opts.port, extraHosts);
  let boundPort = opts.port;

  const handle = async (req: Request): Promise<Response> => {
    // `req.url` is only a path when the client sent no Host header (HTTP/1.0).
    const url = new URL(req.url, "http://127.0.0.1");
    const { pathname } = url;

    // /healthz — no auth and no Host check (tunnels and the watchdog hit it).
    if (pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return errorJson(405, "method_not_allowed");
      return healthz(req, {}, url);
    }

    // Public webhook ingress — trigger-specific HMAC, never the API token, and
    // reachable through a tunnel under whatever Host name the tunnel uses.
    if (pathname === "/hooks" || pathname.startsWith("/hooks/")) {
      const path = pathname.slice("/hooks/".length);
      if (!path || path.includes("/")) return errorJson(404, "not_found");
      if (!opts.webhookAdapter) return errorJson(404, "not_found");
      const adapter = opts.webhookAdapter();
      // No adapter yet: the supervisor is degraded (no valid config has ever
      // loaded) or still starting. That is temporary; a 404 would tell the
      // sender to give up on the delivery.
      if (!adapter) {
        return errorJson(503, "supervisor_degraded", undefined, { "retry-after": "60" });
      }
      try {
        return await adapter.handle(path, req);
      } catch (err) {
        logError("webhook dispatch failed", err);
        return errorJson(500, "internal_error");
      }
    }

    // Everything below requires an allowed Host. That blocks DNS-rebinding
    // pages (their Host is the attacker's name) and requests without a Host.
    if (!hostAllowed(req, policy)) return badHostResponse(req, boundPort);
    // A present Origin must be ours for every method; an absent one is the CLI or curl.
    if (!originAllowed(req, policy)) return errorJson(403, "bad_origin");
    // The page at / embeds the token: never hand it to something that arrived through a proxy.
    if (proxiedLoopbackRequest(req, policy)) return errorJson(403, "proxied_request");
    // A cross-site <script>/<img>/<link>/fetch is never the dashboard or the CLI.
    if (crossSiteSubresource(req)) return errorJson(403, "cross_site");

    // /events — SSE, bearer token only.
    if (pathname === "/events") {
      if (req.method !== "GET") return errorJson(405, "method_not_allowed");
      if (!auth.authenticate(req)) return errorJson(401, "unauthorized");
      return broadcaster.subscribe(req);
    }

    // /api/* — bearer token, then the router.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (!auth.authenticate(req)) return errorJson(401, "unauthorized");
      const m = router.match(req.method, pathname);
      if (m.kind === "match") {
        try {
          return await m.handler(req, m.params, url);
        } catch (err) {
          // Log the detail locally; never hand exception text or paths to the client.
          logError(`api ${req.method} ${pathname} failed`, err);
          return errorJson(500, "internal_error");
        }
      }
      if (m.kind === "method_not_allowed") return methodNotAllowed(m.allowed);
      return errorJson(404, "not_found");
    }

    // Everything else is a static file or the SPA shell: GET/HEAD only.
    if (req.method !== "GET" && req.method !== "HEAD") return errorJson(405, "method_not_allowed");

    // /assets/* — hashed build output: immutable cache, no SPA fallback.
    if (pathname.startsWith("/assets/")) {
      const real = resolveStaticFile(assetsDir, pathname.slice("/assets/".length), MAX_ASSET_DEPTH);
      if (!real) return errorJson(404, "not_found");
      return fileResponse(real, req.method, "public, max-age=31536000, immutable");
    }

    // Never SPA-fallback this prefix.
    if (pathname.startsWith("/.well-known/")) {
      return errorJson(404, "not_found");
    }

    // Root-level files shipped in ui/dist (favicon.svg, ...).
    if (looksLikeFileRequest(pathname)) {
      const rel = pathname.slice(1);
      if (rel !== "index.html") {
        const real = resolveStaticFile(distDir, rel, 1);
        if (real) return fileResponse(real, req.method, "public, max-age=3600");
        // A missing file is a 404, not a page: browsers probing /favicon.ico
        // must not be handed HTML.
        return errorJson(404, "not_found");
      }
    }

    // SPA shell + fallback. It embeds the current API token, which is what the
    // dashboard sends as its bearer credential. Only requests with an allowed
    // Host and Origin get here, and the page cannot be framed or read
    // cross-origin (see the response headers).
    const html = renderSpaShell(indexPath, auth.token, boundPort);
    return new Response(req.method === "HEAD" ? null : html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    // Without `reusePort: false` Bun on macOS lets a second supervisor bind the
    // same port and the kernel then splits traffic between the two.
    reusePort: false,
    development: false,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: async (req: Request): Promise<Response> => {
      try {
        return hardened(await handle(req));
      } catch (err) {
        logError("request failed", err);
        return hardened(errorJson(500, "internal_error"));
      }
    },
    error(err) {
      logError("server error", err);
      return hardened(errorJson(500, "internal_error"));
    },
  });

  boundPort = server.port ?? opts.port;
  policy = buildHostPolicy(boundPort, extraHosts);

  return {
    port: boundPort,
    get token() {
      return auth.token;
    },
    emit: (event, data) => broadcaster.emit(event, data),
    subscriberCount: () => broadcaster.subscriberCount(),
    stop: async () => {
      await broadcaster.stop();
      try {
        server.stop(true);
      } catch {
        // ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Diagnostic line on stderr with the error's message only (no stack, no request data). */
function logError(what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[server] ${what}: ${message}\n`);
}

/**
 * 403 `bad_host`. A browser navigation (someone opening the dashboard under a
 * name that is not allowed) gets a short page that says what to do; everything
 * else gets the JSON error. Nothing from the request is echoed and no token is
 * included.
 */
function badHostResponse(req: Request, port: number): Response {
  const navigation =
    (req.method === "GET" || req.method === "HEAD") && (req.headers.get("accept") ?? "").includes("text/html");
  if (!navigation) return errorJson(403, "bad_host");
  const html = [
    `<!doctype html>`,
    `<html lang="en"><head><meta charset="utf-8"><title>Host not allowed</title></head><body>`,
    `<h1>Host not allowed</h1>`,
    `<p>The Auto dashboard answers only to its own loopback names. Open <a href="http://127.0.0.1:${port}/">http://127.0.0.1:${port}/</a> or <a href="http://localhost:${port}/">http://localhost:${port}/</a>.</p>`,
    `<p>To use another name, list it in <code>AUTO_ALLOWED_HOSTS</code> (comma separated, exact host:port) and restart the supervisor. Anyone who can reach a listed name gets the API token, so only list names behind access control.</p>`,
    `</body></html>`,
  ].join("\n");
  return new Response(req.method === "HEAD" ? null : html, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fileResponse(path: string, method: string, cacheControl: string): Response {
  const file = Bun.file(path);
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "Cache-Control": cacheControl,
  };
  if (method === "HEAD") {
    try {
      headers["Content-Length"] = String(statSync(path).size);
    } catch {
      // omit
    }
    return new Response(null, { status: 200, headers });
  }
  return new Response(file, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

function renderSpaShell(indexPath: string, token: string, port: number): string {
  // The dashboard reads this JSON block for its bearer token. It is a data
  // block (type=application/json), so the CSP's script-src neither blocks nor
  // executes it. `</` is escaped so the JSON can never close its own tag.
  const bootstrap = JSON.stringify({ token, port }).replace(/<\//g, "<\\/");
  const scriptTag = `<script id="auto-bootstrap" type="application/json">${bootstrap}</script>`;

  if (existsSync(indexPath)) {
    try {
      return injectBootstrap(readFileSync(indexPath, "utf8"), scriptTag);
    } catch {
      // fall through to placeholder
    }
  }

  // Placeholder: the UI has not been built. No inline styles (the CSP forbids them).
  return [
    `<!doctype html>`,
    `<html lang="en"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>automations supervisor</title>`,
    scriptTag,
    `</head><body>`,
    `<main>`,
    `<h1>UI not built yet</h1>`,
    `<p>Run <code>bun run --cwd ui build</code> to populate <code>ui/dist/</code>.</p>`,
    `<p>The supervisor's API is live at <code>/api/*</code> and the SSE stream at <code>/events</code>.</p>`,
    `</main>`,
    `</body></html>`,
  ].join("\n");
}

function injectBootstrap(html: string, scriptTag: string): string {
  // Insert just before `</head>`. If the build doesn't have a `</head>` (it
  // really should), prepend at the start so the page still bootstraps.
  const idx = html.indexOf("</head>");
  if (idx >= 0) {
    return html.slice(0, idx) + scriptTag + html.slice(idx);
  }
  return scriptTag + html;
}
