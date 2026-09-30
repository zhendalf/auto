# Q-07 — HTTP server: which surfaces, how organized, how authed?

## Context

The supervisor needs an HTTP server. It has to host **at minimum**:

1. **Webhook ingress** — `POST /hooks/<trigger-name>` (external systems
   like GitHub).
2. **Internal API** — used by both the SPA and the CLI to list jobs,
   read run history, fetch logs, trigger manual runs, cancel runs,
   enable/disable jobs+triggers.
3. **SPA static assets** — the React+Tailwind bundle served from
   `/` (or `/ui/`).
4. **Live updates** — UI wants to see runs change state in
   near-real-time. WebSocket or Server-Sent Events.

Separate questions later cover SPA build, webhook security, file
watch — this question is just about the HTTP surface itself: how
many ports, how routes are organized, how requests are authed,
how the CLI talks to it.

## Options for "how many servers"

### a) One Bun.serve, all surfaces, route-prefix split

Single process, single port, one server. Routes:
- `/api/*` — internal API (UI + CLI)
- `/hooks/*` — webhook ingress
- `/ws` — live updates
- `/*` — SPA assets (catch-all serves React bundle, with `/index.html`
  for client-side routes)

### b) Two servers, two ports

- Internal port (default `127.0.0.1:7777`) — API + UI + WebSocket.
- Public-ish port (`0.0.0.0:7778` or tunneled) — webhooks only.

### c) Unix socket for CLI/UI, TCP for webhooks

- CLI/UI talk over `~/.automations/data/supervisor.sock`. Strong
  auth-by-default (only processes with FS access can connect).
- Webhooks on TCP for external reach.

## Network exposure

For each surface:
- **API + UI:** local-only, `127.0.0.1` bind. Never exposed.
- **Webhooks:** more options (covered in Q-08, but bind matters here):
  - `127.0.0.1` only, exposed via Tailscale Funnel / cloudflared
    tunnel for inbound from GitHub.
  - Bind to all interfaces (`0.0.0.0`) — only acceptable on a
    trusted network with firewall.

## Authentication

- **CLI ↔ API:** loopback-only + a token in `~/.automations/data/.token`
  (mode 0600). CLI reads the token; HTTP requests must include it.
  This is belt + braces (loopback already restricts access; token
  prevents same-machine other-user attacks).
- **UI ↔ API:** same token, baked into the page on first render.
  (Browser fetches `/api/_init` over loopback to grab the token,
  then uses it for subsequent requests.) Or: skip the token for
  loopback and rely on `Origin`/CSRF protection.
- **Webhooks:** per-trigger HMAC verification (GitHub uses
  `X-Hub-Signature-256`). Different concern, settled in Q-08.

## Live updates

- **WebSocket.** Bun has first-class WebSocket support
  (`Bun.serve({ websocket })`). One channel per UI session. Server
  pushes events: `run.queued`, `run.started`, `run.finished`,
  `config.reloaded`, `config.error`.
- **Alternative: SSE.** Simpler, one-way, no message framing
  decisions. Bun supports it via `Response` body streams.
- WebSocket is the obvious choice given Bun's first-class support
  and the bidirectional possibility (cancel-run from UI without
  a separate REST hop). SSE would also work.

## Recommendation

**(a) One Bun.serve, route-prefix split, single internal port.**

- Single process is consistent with "supervisor owns everything"
  (Q-01).
- Single port is simpler to firewall, document, and reverse-tunnel.
- Routes:
  - `GET  /api/jobs` — list jobs with current state
  - `GET  /api/jobs/:name` — job detail
  - `POST /api/jobs/:name/run` — manual trigger (returns 409 if
    overlap; Q-04 conflict semantics)
  - `POST /api/jobs/:name/enable | /disable | /pause`
  - `POST /api/triggers/:id/enable | /disable`
  - `GET  /api/runs?job=...&state=...&limit=...`
  - `GET  /api/runs/:run_id`
  - `GET  /api/runs/:run_id/log` — streams the log file
  - `POST /api/runs/:run_id/cancel`
  - `GET  /api/config/status` — current config version, errors,
    last-known-good info
  - `POST /api/config/reload` — force reload (debug)
  - `WS   /ws` — events
  - `POST /hooks/:trigger_name` — webhook ingress
  - `GET  /*` — SPA (with HTML fallback for client routes)
- **Bind:** `127.0.0.1:7777`. Webhooks expose externally only via
  reverse tunnel (Q-08), never by binding to `0.0.0.0`.
- **Auth:** token-in-header for `/api/*`. SPA reads the token from
  a same-origin `/api/_init` GET. CLI reads from
  `~/.automations/data/.token`. Webhooks have their own per-trigger
  HMAC auth.
- **Live updates:** WebSocket on `/ws`. JSON event envelopes.

## Tradeoffs to flag

- **Webhooks share a process with the API.** A flood of webhook
  requests can in principle starve the API/UI. Mitigation: webhook
  handler does minimal work (verify signature, enqueue trigger,
  return 202). Heavy lifting happens in the worker subprocess.
  This is fine at personal scale.
- **Token in a same-origin file is "good enough" auth, not real
  auth.** A malicious user on the same Mac with FS read access can
  call `/api/*`. This is fine for a personal laptop.
- **Tunneling the webhook port** means the API/UI port is *also*
  exposed unless we use route-level filtering at the tunnel.
  Mitigation: use `cloudflared` access policy `--allowed-paths
  /hooks/*` or equivalent. Or run two ports after all (option b).
  Worth revisiting in Q-08.

## Question for reviewer

Single Bun.serve with route-prefix split — right? Token-in-file +
loopback the right auth posture for `/api/*`? WebSocket or SSE for
live updates? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- One `Bun.serve` on `127.0.0.1:7777` is the right default for a personal supervisor. It keeps API, UI, events, and webhook routing in one observable control plane.
- Do not let "single port" quietly become "single externally exposed app." The tunnel must be path-filtered to `/hooks/*` only, fail closed, and be treated as part of the security boundary.
- Token-in-file for CLI/API is reasonable, but `/api/_init` returning the token is weak framing. Prefer bootstrapping the UI token only from the served HTML/app shell, require token headers for mutating API calls, and enforce `Origin`/`Host` checks.
- Use SSE for v1 live updates. The UI can cancel via REST. WebSocket adds bidirectional state, reconnect/auth handling, and message semantics before the system needs them.

**Anything missed:**
- Add request limits for `/hooks/*`: max body size, content type expectations, timeout, and cheap rejection before reading/storing payloads.
- Define CORS/CSRF posture explicitly: no permissive CORS, reject unexpected `Origin`, require non-simple auth headers for mutations.
- Add a `/healthz` or `/api/health` route for LaunchAgent/debug/tunnel checks that does not leak config or token state.

**Recommended choice:** Option A, modified: one loopback-only `Bun.serve`, route-prefix split, `/api/*` token-protected, `/hooks/*` HMAC-protected, SPA served same-origin, SSE at `/events`, and external webhook access only through strict `/hooks/*` tunnel filtering.
