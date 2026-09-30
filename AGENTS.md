# Agent guide for ~/.automations

Personal automation supervisor ("Auto"). Bun runtime with a portable Bun cron
watchdog. Designed through reviewed decisions (see [design/](design/)) and
hardened in a pre-launch polish pass that is recorded as D-17 onward and in
[design/build-log.md](design/build-log.md). This file is the entry point for
any agent (Claude Code, codex CLI, Cursor, etc.) picking up work here.

## What this repo is

- A long-running supervisor process (`supervisor/main.ts`) kept alive by a
  once-a-minute Bun cron watchdog (`.auto-runtime/supervisor.ts` in the
  workspace).
- A small SQLite database (`<data>/automations.db`) for jobs, triggers, runs,
  condition state and webhook receipts.
- Per-run log files at `<data>/runs/YYYY/MM/DD/<run_id>.log` (local date).
- A CLI binary (`auto`, published by the package; a source checkout gets a
  shim to `bun cli/main.ts`).
- Workers in the user workspace (conventionally `jobs/<job-name>.ts`; a
  condition checker may live in `jobs/<job-name>/check.ts`) that the supervisor
  spawns as `bun <worker>` subprocesses on each trigger fire.
- The default workspace is `~/.auto` and the default data directory is
  `~/.auto/data`. `AUTO_HOME`, `AUTO_CONFIG`, `AUTO_DATA_DIR` and `AUTO_PORT`
  (default 7777) override them; see [paths.ts](paths.ts). This repository is the
  engine only.
- Platform status: macOS is the verified host. Linux and Windows run through
  Bun's OS scheduler but are untested; do not claim otherwise in docs.

For the architecture diagram and phased plan see
[design/build-plan.md](design/build-plan.md) (a historical plan; parts are
superseded, see the notes in it). For resolved decisions see
[design/decisions.md](design/decisions.md). For the per-Q rationale see
[design/questions/](design/questions/). User-facing behavior is documented in
[README.md](README.md) and [SECURITY.md](SECURITY.md).

## Authority order

When intent is unclear, the higher source wins:

1. [design/decisions.md](design/decisions.md): a later D-NN supersedes an
   earlier one where they conflict (superseded entries carry a note).
2. [design/build-plan.md](design/build-plan.md)
3. [design/questions/Q-NN-*.md](design/questions/) (rationale per decision)
4. This file (AGENTS.md)

The code is the final check: if a document and the code disagree, verify by
reading or running the code and fix the document.

## Conventions

### Workers

- One file per job under the workspace's `jobs/`: `jobs/<job-name>.ts`. The
  config's `worker` path is workspace-relative, begins with `./`, contains no
  `..`, and must exist (validated at load).
- The runner always executes `bun <worker>`. There is no shebang or
  executable-bit handling; a worker must be a file Bun can run. The working
  directory is the workspace root and stdin is closed.
- **Print to `stdout`.** The supervisor's per-run log captures stdout and
  stderr (capped at 5 MiB per run).
- Workers do NOT have DB access and do NOT inherit the supervisor's
  environment. The child environment is an allowlist
  (`PATH HOME USER LANG LC_ALL TZ SHELL TMPDIR`, plus a few on Windows; see
  [supervisor/child-process.ts](supervisor/child-process.ts)) plus `RUN_ID`,
  `JOB_NAME`, `JOB_ID`, `TRIGGER_KIND`, `TRIGGER_ID`, `TRIGGER_META` (JSON) and,
  for authenticated webhooks, `TRIGGER_PAYLOAD_PATH`. Stored secrets are not
  injected into workers.
- Workers run detached, each in its own process group. Timeout, cancel and
  shutdown signal the whole group (`SIGTERM`, then `SIGKILL` after
  `killGraceMs`).
- Run logs redact the exact value of every stored secret (byte-level, safe
  across chunk boundaries, minimum 4 characters). Substrings and transformed
  forms are not caught.

### Supervisor code

- Single Bun process. No worker threads. No IPC.
- DB writes via `bun:sqlite` prepared statements, never string concatenation.
- Use `db.run`, NOT `db.exec` (deprecated alias).
- Migrations are numbered SQL files in `supervisor/db/migrations/` and are
  additive and forward-only. A database that has applied migrations this build
  does not ship makes the supervisor refuse to start (exit 78) instead of
  writing to it.
- Paths stored in DB are RELATIVE to the data directory (per Q-06). Reconstruct
  with `${DATA_DIR}/${path}` at read time, and never read or delete a stored
  path that resolves outside it.
- File modes: the data directory and every directory under it are `0700`;
  state files, the token, `secrets.json`, run logs and payloads are `0600`
  (`hardenTree` tightens looser modes at startup). It only touches Auto's own
  entries (`isAutoDataEntry` in [paths.ts](paths.ts): `automations.db*`,
  `.token*`, `secrets.json*`, `supervisor.lock*`, `runs/`, `payloads/`,
  `state/`), and not at all when `DATA_DIR` holds content that is not Auto's
  and none of these (a mistaken `AUTO_DATA_DIR`): the supervisor warns and
  leaves the directory and its files alone (`dataDirIsForeignAtStart`).
- Job identity is the job NAME. `id` is a validated, unique label. Job names
  are 1 to 64 characters (letters, digits, space, `.`, `_`, `-`); `:` and `/`
  are rejected because trigger ids are `<name>:<trigger id>` and names appear
  in URLs.
- No third-party deps beyond the locked stack:
  - **Supervisor + CLI** (root `package.json`): `zod`, `commander`, `prompts`,
    `picocolors`, `@types/prompts`.
  - **UI** (`ui/package.json` only, never the root): `react`, `react-dom`,
    `react-router-dom`, `@tanstack/react-query`, `vite`, `@vitejs/plugin-react`,
    `tailwindcss`, `@tailwindcss/vite`.
  Don't add a UI dep to the root package or vice versa.
- `node:fs.watch` over chokidar. `Bun.spawn` over `node:child_process`.
- Comments describe the code as it is now; don't reference build phases or
  waves.

### Supervisor modules worth knowing

| Module | Role |
| --- | --- |
| `main.ts` | Startup order, `--check`, signal handling (the only owner of SIGINT/SIGTERM/SIGHUP), teardown |
| `lifecycle.ts` | Singleton lock, state files, degraded mode, exit codes, shutdown budget |
| `recovery.ts` | Finalizes runs left over from a dead supervisor and stops orphaned workers |
| `retention.ts` | Prunes old runs, logs, receipts, payloads, empty directories |
| `config.ts`, `config-loader.ts` | Schemas and validation; `ConfigStore` (watch, reload, last-known-good); the loader subprocess |
| `registry.ts` | Job/trigger state in the DB, `activeCronJobs()`/`activeWebhookJobs()`, pause timer, state-change subscribers |
| `runner.ts`, `child-process.ts` | Admission, process-group spawn and signalling, log capture, `Runner.shutdown` |
| `adapters/` | `cron.ts` (own local-time parser and timer loop), `webhook.ts`, `manual.ts` |
| `condition-evaluator.ts` | Conditional cron checkers |
| `auth.ts`, `server.ts`, `static-files.ts`, `sse.ts`, `api/` | HTTP surface (see below) |
| `secrets.ts`, `log-capture.ts` | Secret store (reloads on change; a file that fails validation is remembered by its identity and not re-read until it changes) and run-log redaction |
| `bun-cron-service.ts`, `log-file.ts`, `notify.ts`, `safety-net.ts`, `process-identity.ts` | Watchdog entry and start/stop helpers, supervisor log tee, desktop notifications, unhandled-error policy, pid identity checks |

### Lifecycle contracts

- **Singleton lock.** `<data>/supervisor.lock` is a JSON file
  `{pid, startedAt, entry}`, published with `link()` (with an `O_EXCL`
  fallback) so a reader never sees a half-written lock. A holder counts as live
  only if its pid is alive AND its command line matches the supervisor entry
  (`supervisor/main.ts`, `.auto-runtime/supervisor.ts` or the recorded entry),
  so a reused pid does not block a start. Stale takeover is serialized by a
  `<lock>.takeover` guard. Without `ps`, it falls back to a plain liveness
  check. There is no `flock`. See [supervisor/lifecycle.ts](supervisor/lifecycle.ts).
- **Signals.** Only `main.ts` handles SIGINT/SIGTERM/SIGHUP. `lifecycle.ts`
  installs no signal handlers that exit.
- **Shutdown.** `Runner.shutdown(graceMs)` (default 10 s) signals every active
  worker's process group (`SIGTERM`, then `SIGKILL` after the job's
  `killGraceMs` capped by `graceMs`), finalizes DB rows, refuses new admissions
  and queue promotion, and always resolves within `graceMs + 2000` ms.
  `main.ts` has a hard deadline of `graceMs + 5000` ms. Runs still active are
  recorded `killed` with `skip_reason = supervisor_shutdown`. A post-shutdown
  sweep finalizes anything left. After a deliberate stop (cancel, timeout,
  shutdown) the runner still SIGKILLs the worker's process group once the
  leader has exited (`reapGroupAfterStop`), because a member that ignored
  SIGTERM holds none of the worker's pipes and nothing else would signal it.
  `teardown` also stops in-flight condition checkers
  (`ConditionEvaluator.stop`) and aborts a config load in flight
  (`ConfigStore.stop`), so neither outlives the supervisor.
- **Crash recovery.** After migrations and before the runner exists, any run
  still `queued`/`running` from a previous supervisor becomes `failed` with
  `skip_reason = supervisor_interrupted`, gets a note appended to its log, and
  a recorded worker pid that is still alive AND whose command line matches the
  worker path is terminated (its whole process group when it leads one, waiting
  for the group, not just the leader, to be gone). Stale condition pending markers are cleared.
- **Cron start-up.** The first `CronAdapter.reconcile` after a start also arms
  a fire at most one minute in the past (`alreadyRan` in `main.ts` looks for a
  run whose `trigger_meta.fire_at` is that fire, so a graceful restart right
  after it ran does not repeat it). Later reconciles (a config edit) never
  catch up.
- **Exit codes.** `70` (software: unreadable DB, migration failure, bind
  failure), `78` (config: `--check` failure, or a DB migrated by a newer
  build). Anything but `0` makes the watchdog restart on the next tick, and the
  watchdog tick itself throws on a non-zero start code.
- **State files** under `<data>/state/`: `degraded.json`, `last-error.txt`,
  `notified.json`, `supervisor.log` (rotated at 5 MB). `main.ts` tees stdout and
  stderr into `supervisor.log` unless `AUTO_LOG_REDIRECTED=1` says the launcher
  already redirected them.
- **Retention.** `retention.ts` sweeps 60 s after start and every 6 h.
  `AUTO_RETENTION_DAYS` (default 90, `0` disables) and
  `AUTO_RETENTION_MIN_RUNS` (default 25 real runs per job kept). See D-34.

### Environment variables

`AUTO_HOME`, `AUTO_CONFIG`, `AUTO_DATA_DIR`, `AUTO_PORT` (paths.ts);
`AUTO_ALLOWED_HOSTS`, `AUTO_RETENTION_DAYS`, `AUTO_RETENTION_MIN_RUNS`;
`AUTO_BASE_URL` (CLI target only); `AUTO_NOTIFY=0` (no desktop notifications);
`AUTO_LOG_REDIRECTED=1` (internal, set by `startSupervisorNow`).

The generated watchdog entry (`.auto-runtime/supervisor.ts`) and the
source-install shim bake in `AUTO_HOME`, `AUTO_DATA_DIR`, `AUTO_PORT`,
`AUTO_CONFIG` (only when set explicitly) and, only when set at install time,
`AUTO_ALLOWED_HOSTS`, `AUTO_RETENTION_DAYS`, `AUTO_RETENTION_MIN_RUNS`. If you
add a variable the supervisor needs after a reboot, add it to
`OPTIONAL_ENV_VARS` in
[supervisor/bun-cron-service.ts](supervisor/bun-cron-service.ts). Every
`Bun.serve` port used by tests must differ from 7777.

### HTTP server

- Single `Bun.serve` on `127.0.0.1:<AUTO_PORT>`. Loopback only, never
  `0.0.0.0`.
- Authentication ([supervisor/auth.ts](supervisor/auth.ts)). One credential, no
  sessions:
  - The API token (`<data>/.token`, 64 hex chars, `0600`) is sent as
    `Authorization: Bearer <t>` (constant-time compare) by the CLI and by the
    SPA. Nothing else authenticates: no cookie, no `X-Auto-Token`, no
    `?token=` (`/events?token=` gets 401). There is no `/api/ui-session`
    and no `/auth/exchange`; do not add cookies or sign-in flows (owner
    decision, see [Q-17](design/questions/Q-17-cookie-session-instead-of-embedded-token.md)).
  - The dashboard needs no sign-in. `GET /` (and every SPA fallback path)
    serves the shell with the live token and bound port in
    `<script id="auto-bootstrap" type="application/json">{"token","port"}</script>`,
    `Cache-Control: no-store`. It does so only for a request that passed the
    gates below. Anyone who can reach the loopback port can read the token;
    that is the accepted single-user tradeoff ([SECURITY.md](SECURITY.md)). What
    must hold: no web page, DNS-rebinding page, cross-origin request, iframe or
    tunnel may obtain or use it.
  - Gate order, on every route except `/hooks/*` and `/healthz`
    ([supervisor/server.ts](supervisor/server.ts) `handle`): `Host` present and
    allowed (403 `bad_host`); a present `Origin` allowed, for every method
    (403 `bad_origin`); a built-in loopback `Host` carrying a proxy header
    (`Forwarded`, `X-Forwarded-*`, `X-Real-*`, `Cf-*`, `Tailscale-*`, `Ngrok-*`,
    `X-Envoy-*`, `Cdn-Loop`, `Client-Ip`, `X-Client-Ip`, `True-Client-Ip`,
    `Fastly-Client-Ip`, `Via`; see `looksForwarded` in `auth.ts`) is refused
    (403 `proxied_request`); a request the browser marks cross-site or
    same-site (`Sec-Fetch-Site`) that is not a top-level navigation
    (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`) is refused
    (403 `cross_site`, `crossSiteSubresource` in `auth.ts`); then
    `/api/*` and `/events` need the bearer (401 `unauthorized`). A browser
    navigation (GET/HEAD with `Accept: text/html`) to a disallowed `Host` gets
    a short static HTML page instead of the JSON `bad_host`, with nothing from
    the request echoed.
  - Allowed hosts (`buildHostPolicy`): `127.0.0.1:<port>`, `localhost:<port>`,
    `auto.localhost:<port>` (no `[::1]`: the server listens on IPv4 only) plus
    exact entries from
    `AUTO_ALLOWED_HOSTS` (comma separated, default empty). The policy is
    rebuilt after Bun binds, so port 0 works. Listing a host serves the token
    to whoever can reach it; the server logs a warning at start.
  - `POST /api/token/rotate` writes a new `0600` token atomically, swaps it in
    memory (the old bearer gets 401, `/` embeds the new one), and disconnects
    all SSE streams. The response never contains the token. Dashboards reload
    to recover; the CLI re-reads the file. `AuthState` also follows the token
    file itself (stat per use): a hand-replaced file takes effect at once, a
    deleted one is replaced by a fresh token, an invalid one is ignored.
- Routes, split by prefix in [supervisor/server.ts](supervisor/server.ts):
  - `/api/*`: bearer protected; the route table lives in `server.ts`.
  - `/events`: SSE (GET only); at most 64 subscribers; slow readers are dropped.
  - `/healthz`: unauthenticated, exempt from the Host check, returns only
    `{ok, degraded}` (200 or 503).
  - `/hooks/:path`: trigger-specific HMAC-authenticated webhook ingress
    ([supervisor/adapters/webhook.ts](supervisor/adapters/webhook.ts)).
  - `/assets/*`, `/` and root-level `ui/dist` files: static, served through
    realpath containment ([supervisor/static-files.ts](supervisor/static-files.ts)).
    Misses on paths with a file extension are 404 JSON, never the SPA shell,
    except under `/jobs/` and `/runs/`: job names may contain `.` (a job named
    `export.json` is valid), so those client-side routes always get the shell.
    `/api` never falls back to the shell; every other extensionless path does.
- `Bun.serve` is started with `reusePort: false`: without it Bun on macOS lets a
  second supervisor bind the same port and splits traffic. A taken port must
  fail the bind (exit 70).
- Every response carries the CSP (no `unsafe-inline`), `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin` and
  `Cross-Origin-Opener-Policy: same-origin`. `Cache-Control:
  no-store` is the default. API handler exceptions return
  `500 {"error":"internal_error"}` with no detail (detail goes to stderr).
- API routes are hand-rolled (no Express/Hono). Pattern in
  [supervisor/api/router.ts](supervisor/api/router.ts): `readBodyCapped`,
  `errorJson`, `methodNotAllowed` (405 with `Allow`) and HEAD-via-GET live
  there.
- **Run ids.** The display id is the LAST 8 hex characters of the run UUID with
  hyphens removed (the first 8 of a UUIDv7 are timestamp bits and collide).
  The API resolves a reference as: exact full id, else a unique prefix, else a
  unique suffix; 6 to 32 hex characters (hyphens ignored); anything else is
  `400 invalid_run_id`, an ambiguous one `409 ambiguous_prefix` with
  candidates. No `LIKE` is ever used.
- API changes are additive: new fields, new optional params, new endpoints.
  The runs list stays a bare array and pages through the `X-Next-Before` and
  `X-Next-Before-Id` response headers.
- All mutating job/trigger endpoints go through `applyScheduling`
  ([supervisor/api/support.ts](supervisor/api/support.ts)), which reconciles the
  cron AND webhook adapters (via registry state-change subscribers), re-arms the
  pause timer and emits `config.reloaded`. Disabled, paused and
  trigger-disabled jobs keep their `/hooks` route and answer 503 with
  `Retry-After: 60` and a `reason`, only after the signature verified; before
  that every caller sees the same bare 401 (unknown path, wrong method, bad
  signature and an unusable secret are indistinguishable). While no config has
  ever loaded (`webhookAdapter()` is null) `/hooks/*` is 503 too.

### SSE event types (locked)

- `run.queued`, `run.started`, `run.finished`, `run.skipped`
- `config.reloaded`, `config.error`
- `degraded.exited` (a degraded supervisor recovered)

Adding a new event type is a contract change: update the `supervisor/sse.ts`
callers, both consumers (UI: `ui/src/api/sseHook.ts` and `ui/src/api/sse.ts`;
CLI: `cli/sse.ts`), and the docs. `run.finished` may carry an optional
`reason`; `run.skipped` reasons include `overlap`, `queue_full`, `disabled`,
`paused`, `shutdown`, `cancelled`, `supervisor_shutdown`. `db.error` and
`degraded.entered` were dropped from the contract because nothing sent them.

### Config loading

`ConfigStore` evaluates the config in a short-lived subprocess
([supervisor/config-loader.ts](supervisor/config-loader.ts)) because Bun 1.4
returns a stale module for a re-imported `file://` URL with a cache-busting
query. One shared validation covers hot reload, cold start and
`supervisor/main.ts --check`: names, cron syntax, limits, and that every
worker and checker file exists. A new config is committed only after the
runtime has applied it; on failure the last-known-good config keeps running.
Reloads are serialized and coalesced. Keep the loader's output contract
(a marker line plus one JSON document) intact.

### CLI

- One binary: `auto`, published by the root package. The source-only
  `bun scripts/auto-install.ts` bootstrap also writes a small
  `~/.local/bin/auto` shim that preserves the selected workspace and shells out
  to `cli/main.ts`.
- Groups: Setup (`init create install secret config`), Jobs (`jobs job run
  enable disable pause trigger`), Runs (`runs log last cancel`), Service (`svc
  token ui data`), Diagnostics (`doctor version`).
- **All data commands talk to the supervisor** over `/api/*`. The direct-DB
  reads are read-only diagnostics: `PRAGMA integrity_check` in
  `cli/commands/doctor.ts` and the run count in `auto data wipe`.
- stdout = data, stderr = status. Interactive prompts (`ask` in `runtime.ts`)
  are drawn on stderr too, so `--json | jq` is never corrupted. Everything printed goes through the tracked
  writers in `cli/runtime.ts` (`println`, `printJson`, `status`, ...);
  `main.ts` awaits `flushOutput()` before exiting so a piped `| head` or `| wc`
  is complete. Don't call `process.exit` in command code; return the code.
- `--force` exists only on `auto run`, where it bypasses disabled, paused and
  overlap checks. `-y/--yes` is the only confirmation flag.
- Exit codes: 0 ok, 1 error or the run did not succeed, 2 usage, 3 supervisor
  unreachable (`SupervisorUnreachable`), 4 conflict on `auto run`, 130 Ctrl-C
  while following a run. A supervisor that accepts the connection but does not
  answer in time is `SupervisorTimeout` (exit 1, not 3); `auto config reload`
  waits 30 s. `auto config status` exits 1 for a rejected config or a degraded
  supervisor. `ApiClient` retries a 401 once when the token file changed on
  disk (rotation while following).
- Run ids are printed as the short (last-8) id and sent to the API as typed
  ([cli/run-ref.ts](cli/run-ref.ts)). `auto log --follow` and `auto run` share
  [cli/follow.ts](cli/follow.ts): it polls the log endpoint by byte offset and
  uses SSE only as a wake-up.
- `auto create` needs an existing workspace config (`auto init` first).
  `auto create --add` validates a candidate copy of the config before renaming
  it into place, so a running supervisor never sees a broken file
  ([cli/config-file.ts](cli/config-file.ts)).

### UI

- React 19 + Tailwind v4 + Vite 7 + React Query 5. Tailwind v4 uses `@theme`
  blocks in CSS; there is NO `tailwind.config.js`. Colors are semantic CSS
  variables with a light and a dark set; `test/ui-contrast.test.ts` asserts
  the contrast ratios.
- All UI fetches go through `ui/src/api/client.ts`: the token comes from the
  bootstrap tag (`ui/src/bootstrap.ts`), goes out as `Authorization: Bearer`,
  and `credentials` is `"omit"`. A 401 means the token changed (rotation) and
  the UI asks for a reload. Errors are `ApiError` with `status: 0` for network
  failures; use the helpers in `ui/src/util/errors.ts`. Downloading a log is
  a fetch plus blob because a plain link cannot send the header.
- Live events use a fetch-streaming client (`ui/src/api/sse.ts`), not
  `EventSource`, because it must distinguish a 401 from a network error.
  `SSEMount`/`sseHook.ts` maps events to React Query invalidations through
  the pure `api/invalidate.ts`. API shapes live in the DOM-free
  `ui/src/api/types.ts` so root tests can import `ui/src/util/*`.
- Routes are composition + data fetching only; logic lives in components and
  in `ui/src/util/` (pure, unit-tested from the root suite).
- No icon libraries, no `clsx`, no `date-fns`. Tailwind classes inline; dates
  via `Intl.DateTimeFormat`.
- Dev: `bun run --cwd ui dev` (Vite on `:5173`). It proxies `/api`, `/events`
  and `/healthz` to the supervisor on `AUTO_PORT` (rewriting `Host` and
  `Origin` so the supervisor's allowlist needs no dev port).
  `ui/vite-plugin-auto-token.ts` injects `{token, port}` into the dev page,
  re-reading the workspace token file on every page load. Vite must stay on
  localhost: a middleware answers 403 to any non-loopback `Host`, and with
  `server.host` beyond loopback (`--host`) the token is not injected at all
  (`ui/dev-host.ts`). `server.cors` is off so another local origin cannot read
  that page.
- The built bundle must have no inline scripts or styles (the CSP forbids
  them) and no source maps.

### Tests

- `bun test` from the repo root runs everything under `test/` (backend, CLI,
  and the pure UI helpers). Don't hard-code test counts in docs.
- Use temp dirs and temp DBs (`mkdtempSync(join(tmpdir(), "..."))`). Never the
  real data directory, never `Bun.cron` registration, never port 7777.
- Some suites start a real supervisor on a fixed local port
  (`SUPERVISOR_TEST_PORT` 17910, `CONFIG_TEST_PORT` 17950, `CLI_TEST_PORT`
  17960, `CLI_LIVE_MORE_TEST_PORT` 17987, `SUPERVISOR_LIVE_TEST_PORT` 17988 by
  default). Don't run two copies of the suite at once; `startSupervisor` in
  `test/cli-harness.ts` refuses to start when something already answers
  `/healthz` on its port. Test child processes get `cleanEnv()` (no `AUTO_*`
  from the caller's shell).
- Shared helpers (not tests): `test/runner-harness.ts`, `test/cli-harness.ts`,
  `test/cli-fake-api.ts`, and fixtures in `test/fixtures/` (`hello`, `sleep`,
  `leak`, `hang` workers; `hang-worker.ts` ignores SIGTERM).
- The UI has no component test framework. Keep components small; put logic in
  `ui/src/util/` where it can be tested.
- Every defect fix gets a regression test.

### Type-checking

- `bunx tsc --noEmit` after any backend/CLI change (the root project excludes
  `ui/`, but tests are included, so tests may only import DOM-free UI files).
- `bun run --cwd ui typecheck` after any UI change. (`bun --cwd ui run ...` no
  longer works on Bun 1.4.) The UI has its own tsconfig with
  `lib: ["DOM", "DOM.Iterable", "ESNext"]` and `react-jsx`.
- `bun run verify` runs both plus the full test suite.

## How to add a new job

1. Create `~/.auto/jobs/<job-name>.ts` printing to stdout, or run
   `auto create <job-name> --add --cron "<expr>"`.
2. Add an entry to `~/.auto/auto.config.ts` (`id`, `name`, `worker`,
   `triggers: [{ kind: "cron", id, schedule }]`, plus optional `reentrancy /
   queueDepth / timeoutMs / killGraceMs / enabled`). See
   [README.md](README.md) for the full shape and limits.
3. The supervisor watches the config file and reloads; no restart is required.
   `auto config check` validates offline, and `auto config status` shows what
   the running supervisor loaded.
4. `auto run <job-name>` to verify spawn, log and DB (`--force` starts regardless
   of disabled/paused state and of a run in progress: use it deliberately).

## How to add a new trigger kind

Cron and webhook are implemented. When adding another kind such as `watch`:

1. Extend the discriminated union in [supervisor/config.ts](supervisor/config.ts)
   (`TriggerSchema`).
2. Add validation in `supervisor/config.ts` if pre-DB checks are needed (glob
   syntax for `watch`, and so on). It runs for hot reload, cold start and
   `--check` alike.
3. Create `supervisor/adapters/<kind>.ts`. Mirror the shape of `cron.ts`: it is
   constructed with the `Runner`, `reconcile(jobs)` is idempotent, `stop()` is
   graceful.
4. Wire it in [supervisor/main.ts](supervisor/main.ts) (`buildRuntime` and the
   registry state-change subscriber) so `applyScheduling` reconciles it.
5. Update [supervisor/registry.ts](supervisor/registry.ts) so `activeXxxJobs()`
   filters appropriately for the new kind.
6. Add tests under `test/`.

The webhook adapter additionally needs HMAC verification (per Q-07) and
degrades when its declared `secretRef` is missing (per Q-10).

## How to add a new API endpoint

1. Pick the right module under `supervisor/api/` (`jobs.ts`, `runs.ts`,
   `triggers.ts`, `config.ts`) or create a new one.
2. Register the route in [supervisor/server.ts](supervisor/server.ts)'s
   `Router` table: `{ method, pattern, handler }`, with `:param` placeholders.
3. Handlers are `(req, params, url) => Response`. Modules that need shared
   state get an `ApiCtx` from `makeXxxHandlers(ctx)` (see `api/support.ts`);
   use it, don't close over module-level singletons. Read request bodies with
   `readBodyCapped` or `parseJsonBody` and answer with `errorJson`.
4. For mutating job/trigger endpoints call `applyScheduling(ctx)` after the DB
   write so adapters reconcile and SSE listeners refresh.
5. Keep API changes additive. Add a typed method on `cli/client.ts`
   `ApiClient` AND on `ui/src/api/client.ts` (with types in
   `ui/src/api/types.ts`) so both consumers see the contract.
6. Add a route to `ui/src/App.tsx` if there is a corresponding view.
7. Add a test (`test/server.test.ts` or a focused file).

## What NOT to do

- Don't run the supervisor twice. The singleton lock in
  [supervisor/lifecycle.ts](supervisor/lifecycle.ts) refuses a second one, but
  you will waste cycles diagnosing.
- Don't write to `data/automations.db` from outside the supervisor process
  unless the supervisor is stopped. The direct-DB reads in the CLI are
  read-only diagnostics.
- Don't run `auto install`, `auto svc install|start|stop|restart|uninstall`, or
  anything that registers a Bun cron/launchd entry from a review or fix
  session; it changes the owner's live installation. Use a temp workspace with
  `AUTO_HOME`, `AUTO_DATA_DIR` and `AUTO_PORT` set explicitly and start the
  supervisor with `bun supervisor/main.ts`.
- Don't add `console.log` calls that include secrets, env vars, or paths outside
  the engine or `~/.auto`. The runner redacts secrets in captured per-run logs,
  NOT in the supervisor's own log.
- Don't bind the HTTP server to anything but `127.0.0.1`. Webhook ingress
  reaches the outside world only via a tunnel that path-filters to `/hooks/*`
  and fails closed.
- Don't put the API token in URLs, query strings, logs or any response other
  than the page served at `/` (the bootstrap block, behind the Host, Origin
  and proxy gates). Don't add cookies, sessions or other credentials.
- Don't widen the HTTP surface beyond what is listed above.
- Worker-domain log files (a worker writing its own log in addition to the
  supervisor's per-run capture) are allowed but secondary; see D-06.
- Don't reach for chokidar (`node:fs.watch` is enough) or ORMs and query
  builders (plain prepared statements).

## Disagreeing with the design

If you find the design wrong while implementing:

1. **Stop.** Do not silently route around the decision.
2. Open `design/questions/Q-NN-<topic>.md` (next free number) using the format
   of the existing Q files: Context / Options / Recommendation / Tradeoffs /
   Question for reviewer / Codex verdict.
3. Surface the conflict to the user with a one-paragraph summary of what the
   decision said vs what reality requires, plus the options.
4. Wait for direction.

This is the standard the design phase used. Codex pushed back on several
decisions during design; you should too if implementation reveals a real flaw.
(The pre-launch polish departed from several early decisions on the owner's
instruction; those are recorded as D-17 onward, with Q-17 to Q-19 for the
largest ones.)

## Recovery

If the supervisor is broken, see [design/rollback.md](design/rollback.md).
Engine rollback and workspace data recovery are separate operations.
