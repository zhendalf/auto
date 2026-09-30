# Build log — Auto supervisor

Per-wave summary of work completed and any deviations from the design.
Format: one section per wave, written when the wave is committed.

## Pre-flight (no commit yet)

- `git tag pre-supervisor` created (rollback waypoint per Q-12).
- `data/` added to `.gitignore`.
- Phase 1 deps installed: `zod`, `croner`, `commander`, `prompts`,
  `picocolors`, `@types/prompts` (dev). No UI deps.
- Last `bun-autoupdate/upgrade.log` entry: `Apr 30 03:30:07 2026`
  (today — fresh fire).

## Wave 1 — foundations  (commit pending)

Four parallel agents, all independent:

- **DB layer** (`supervisor/db/`): `connection.ts`, `migrate.ts`,
  `ids.ts` (uuidv4 + uuidv7 helpers), `migrations/0001_init.sql`.
  Three tables (`jobs`, `triggers`, `runs`) per Q-06 plus
  `schema_migrations`. WAL + foreign_keys. Transactional migration
  runner; failure exits non-zero (78) and writes
  `data/state/last-error.txt` + `data/migration-error.log`.
- **Config loader** (`supervisor/config.ts`): Zod discriminated
  union (`cron` only in Phase 1; open for `webhook`/`watch` later),
  cross-row uniqueness checks (job id, job name, per-job trigger id),
  `loadConfigOnce` / `validateConfigFile`, `ConfigStore` extending
  EventEmitter with 200ms debounce, `node:fs.watch` rename re-arm
  (no chokidar), keep-last-known-good on reload error.
- **Lifecycle** (`supervisor/lifecycle.ts`): EX exit-code constants
  (only `EX.OK=0` suppresses launchd restart, per D-09 codex
  pushback), real `fs.openSync(..., 'wx')` singleton lock with
  stale-PID cleanup, ring-buffer start history (last 20),
  `DegradedMode` class with atomic flag-file writes, `0o600` on all
  state files, `0o700` on STATE_DIR.
- **LaunchAgent** (`supervisor/launchd/`): plist template (KeepAlive
  dict form per D-09; ThrottleInterval=300; ProcessType=Background),
  `install.ts` / `uninstall.ts` using modern `launchctl bootstrap` /
  `bootout`. Uninstall does NOT touch `data/`.

Also: migrated `automations.config.ts` to the new `Automation` shape
(`id`, `name`, `triggers: [{ kind: "cron", id: "daily", schedule: "30 3 * * *" }]`,
`timeoutMs: 30 min`); replaced `register-all.ts` with a deprecation
stub that points at `design/rollback.md`.

Integration smoke (all green):
- `rm -rf data && bun supervisor/db/migrate.ts` → `{"applied":["0001"]}`,
  three tables + indexes present.
- `validateConfigFile()` → `ok: true`, returns the bun-global-upgrade
  entry with all defaults filled in.
- `acquireSingletonLock()` + `recordStart()` round-trip on a fresh
  data dir.
- `bunx tsc --noEmit` exits 0.
- LaunchAgent install/uninstall dry-run completed; system left clean.

Notes / followups:
- Migration runner uses `sqlite_master` probe instead of literal
  `CREATE TABLE IF NOT EXISTS schema_migrations`. Functionally
  equivalent. Surfaced by Agent A.
- `register-all.ts` will be deleted in Wave 6 cutover.
- LaunchAgent install warns when `supervisor/main.ts` is missing
  (it doesn't exist until Wave 4); install proceeds.

## Wave 2 — runner core  (commit pending)

Single sequential agent. Per D-02, D-04, D-06, D-10.

- `supervisor/log-capture.ts`: bounded merged-stream sink. 5 MiB cap
  with `[truncated: <N> bytes elided]` marker written on `close()`.
  `redactBuffer()` for exact-string secret replacement (longest-first,
  skips values < 4 chars, no cross-chunk match in v1).
- `supervisor/runner.ts`: `Runner` class implementing the
  `runWorker(jobName, ctx)` primitive (`enqueue` API). Reentrancy gate
  per D-04 (drop / queue / parallel + manual conflict + force);
  `Bun.spawn` with PATH-allowlisted env + `RUN_ID`/`JOB_NAME`/`JOB_ID`/
  `TRIGGER_*` injection per Q-02; SIGTERM → SIGKILL timeout; per-run
  log file at `data/runs/YYYY/MM/DD/<run_id>.log`; full run-row
  lifecycle (queued/running/succeeded/failed/timed_out/skipped/killed/
  cancelled).
- `test/fixtures/{hello,sleep,leak}-worker.ts`, `test/runner.test.ts`,
  `test/log-capture.test.ts`: 16 tests covering all reentrancy modes,
  timeout (SIGTERM→SIGKILL), cancel queued + running, disabled job,
  manual conflict + force, cap+truncation marker, redaction
  (longest-first), spec-shaped log_path.

Orchestrator post-fixes:
- The agent stored `log_path` relative to `logsDir`, not relative to
  `data/`. Spec (Q-06) requires `data/`-relative — so consumers do
  `${DATA_DIR}/${log_path}`. Added a `dataDir` Runner option (defaults
  to `DATA_DIR`); `log_path` is now `path.relative(dataDir, logAbs)`,
  yielding `runs/YYYY/MM/DD/<id>.log`. Tests updated to thread
  `dataDir`.

Verification:
- `bun test` → 16 pass / 0 fail / 174 expects.
- `bunx tsc --noEmit` → 0.
- End-to-end smoke (hello-worker via Runner): row state=succeeded,
  exit_code=0, `log_path=runs/2026/04/30/<id>.log`, log file readable
  from `${DATA_DIR}/${log_path}`.

## Wave 3 — adapters  (commit pending)

Two parallel agents. Per D-03, D-04, D-12.

- `supervisor/adapters/cron.ts`: `CronAdapter` using **croner**
  (local-time, DST-correct). `reconcile(jobs)` is idempotent — adds
  new schedules, removes gone, replaces pattern changes.
  `validateCronExpression(pattern)` is exported for Wave 4 to call
  during config validation; rejects non-5-field expressions
  (croner accepts 6-field "with seconds" — we don't).
- `supervisor/adapters/manual.ts`: `triggerManual()` standalone
  function + `ManualAdapter` class wrapper. Maps `Runner.enqueue`
  results to `ManualTriggerResult` (started / queued / conflict /
  skipped / unknown_job) for CLI exit-code mapping (per Q-11) and
  future HTTP status-code mapping (per Q-07). Manual triggers do
  not write rows in the `triggers` table (`runs.trigger_id IS NULL`).

Convention worth noting: `Runner.enqueue` accepts the LOCAL trigger
id in `ctx.trigger_id` (e.g. `"daily"`); the runner internally
namespaces to `<jobName>:<id>` for the `runs.trigger_id` FK and for
`triggers.trigger_id` PK lookups. The cron adapter follows this and
names the croner instance with the namespaced id so `Cron.scheduledJobs`
inspection works.

Verification:
- `bun test` → 27 pass / 0 fail / 233 expects (16 from Wave 2 + 6
  cron + 5 manual).
- `bunx tsc --noEmit` → 0.
- Cron smoke driver: scheduled "30 3 * * *", manually triggered via
  `Cron.scheduledJobs`, runs row written with `trigger_kind="cron"`,
  `trigger_id="bun-global-upgrade:daily"`, exit 0.
- Manual smoke: `triggerManual(...)` started a hello-worker, runs
  row has `trigger_kind="manual"`, `trigger_meta={"reason":"smoke"}`.

## Wave 4 — supervisor entry  (commit pending)

Single sequential agent. Per D-05, D-07 (just `/healthz`), D-09.

- `supervisor/registry.ts`: `JobRegistry` mirrors config → DB
  (jobs + triggers tables), implements the runner's `Registry`
  interface. Reconciliation is transactional and idempotent: new
  rows inserted, existing rows updated (`last_seen_in_config_at`,
  un-archived if previously archived), missing rows archived
  (`archived_at = now`). DB-side `enabled` / `paused_until` are
  preserved across reloads. Validates every cron pattern via
  `validateCronExpression` BEFORE the DB transaction; aggregates
  failures into `ConfigValidationError`.
- `supervisor/main.ts`: entry sequence — args parse → lock acquire
  → migrations → config load → registry reconcile → CronAdapter
  reconcile → ConfigStore watcher → `Bun.serve` on 127.0.0.1:7777
  with `/healthz` only (200 with uptime/jobs OR 503 in degraded
  mode) → SIGTERM/SIGINT/SIGHUP graceful shutdown (10s grace).
  Migration failure → terminal-notifier ping + exit 0 (per Q-09:
  "exit 0 so launchd doesn't hammer"). LockHeld → silent exit 0.
  `--check` mode is side-effect-free (no lock, no port bind, no
  DB writes; opens DB read-only); reports pending migrations + job
  / trigger count; exits 0/78.
- `test/registry.test.ts`: 5 tests — initial reconcile, idempotent
  re-reconcile, removed → archived, re-added → un-archived (same
  job_id), invalid cron pattern aborts the transaction.

Known limitation (per Q-05): jobs are matched by `name`, so renaming
a job in config archives the old row and inserts a new one. To
support clean rename, the user must manually edit the DB. Acceptable
for v1; revisit in Phase 2 if it becomes painful.

Verification:
- `bun supervisor/main.ts --check` (fresh data dir) → exit 0,
  output `OK config=valid jobs=1 triggers=1 migrations_pending=1`.
- `bun supervisor/main.ts --check` with broken config (empty `name`)
  → exit 78, useful Zod error.
- Live smoke: `bun supervisor/main.ts &` → stdout
  `[supervisor] up port=7777 jobs=1 degraded=false`; `curl /healthz`
  returns 200 + JSON; `curl /unknown` returns 404; `kill -TERM`
  exits cleanly, lock file removed, `PRAGMA integrity_check` ok.
- `bun test` → 32 pass / 0 fail.
- `bunx tsc --noEmit` → 0.

Side fix: swept `db.exec(...)` → `db.run(...)` across 3 supervisor
files and 3 test files (8 occurrences). `bun:sqlite`'s `exec` is now
a deprecated alias for `run`.

## Wave 5 — CLI v0  (commit pending)

Single sequential agent. Per D-11.

- `cli/main.ts`: commander entry; global `--json | --no-color |
  --token-file | --base-url | --yes | --force` flags; exit-code
  mapping per Q-11 (0 ok, 1 error, 2 usage, 3 supervisor unreachable,
  4 conflict). Catch-all subcommand handler prints
  "command 'X' is not in the Phase 1 surface" instead of commander's
  default error so unknown verbs (e.g. `auto doctor`) get a friendlier
  message.
- `cli/runtime.ts`: shared helpers — TTY/colour gating, JSON-mode
  `print` helper, read-only DB opener, prompt wrapper, time/short-id
  formatters.
- `cli/install-shim.ts`: writes `~/.local/bin/auto` shell script
  (mode 0o755). Skips if identical content already present.
- `cli/commands/`:
  - `svc.ts`: `install` (delegates `installLaunchAgent` +
    `installShim`), `uninstall`, `start/stop/restart` via
    `launchctl kickstart` / `launchctl kill SIGTERM`, `tail` via
    `Bun.spawn` of `tail -F` with SIGINT cleanup.
  - `runs.ts`: PHASE-1-DIRECT-DB read; hand-rolled padded table or
    `--json` array.
  - `log.ts`: PHASE-1-DIRECT-DB read; exact-or-8-char-prefix
    resolution; `--follow` via `fs.watch` + 250ms poll fallback,
    stops when DB reports terminal state.
  - `last.ts`: combines `runs -n 1 --job` + inline log.
  - `run.ts`: PHASE-1 in-process Runner. DB-side conflict pre-check
    (refuses with exit 4 if non-TTY without `--force`/`--yes`).
    Documented limitation: cross-process overlap detection with the
    supervisor isn't possible from this path. Phase 2 routes through
    `/api/runs`.
  - `version.ts`: prints CLI 0.1.0 + supervisor commit (via
    `git rev-parse --short HEAD`) + Bun version. `--json` shape.
- `test/cli-smoke.test.ts`: 7 tests (version, JSON mode, empty-DB
  paths, unknown run-id error). `auto run` is excluded from tests
  because it actually fires a subprocess.

Verification:
- `bun test` → 39 pass / 0 fail / 316 expects.
- `bunx tsc --noEmit` → 0.
- `bun cli/main.ts version{,--json}`, `auto runs`, `auto svc install`
  (full path) all green.
- `bun cli/main.ts run bun-global-upgrade --force` actually invoked
  the worker, exit 0, runs row succeeded. **But** the per-run log
  file is empty because `bun-autoupdate/worker.ts` uses
  `Bun.$`.quiet()` (capturing into `r.stdout` for its own local log)
  and never writes to stdout — so the supervisor's runner has nothing
  to capture. Wave 6 prep will modify the worker to also tee its
  captured output to `process.stdout`.

End state: LaunchAgent NOT loaded; plist absent; `~/.local/bin/auto`
shim left in place per spec.

## Wave 6 — cutover  (commit pending; step 6 awaits real 03:30 fires)

Orchestrator-only, no subagents. Followed PROMPT §5 protocol exactly.

### Pre-step: bun-autoupdate worker stdout fix

Problem identified at the end of Wave 5: the existing
`bun-autoupdate/worker.ts` runs subprocesses with `Bun.$`.quiet()` and
appends `r.stdout.toString()` to its own local `upgrade.log`, but
nothing reaches the parent's stdout — so the supervisor's runner
captures an empty per-run log. This breaks PROMPT §5 step 4
("the `bun upgrade` and `bun update --latest` lines appear in the
captured log").

Fix: `section()` now both `append`s to the local log AND writes to
`process.stdout` (header + body + footer). The `========== ISO ==========`
banner in `run()` does the same. Local `upgrade.log` continues to
populate identically; supervisor's per-run log now mirrors it.

This is a deliberate small scope-widening relative to D-12 ("worker
code itself: no changes needed in Phase 1"). Rationale: the design
doc presumed workers already wrote to stdout. The cutover acceptance
criterion forces the change; without it, the cutover validation
fails. Documented here rather than opening Q-13.

### Cutover steps

1. `git tag | grep pre-supervisor` → `pre-supervisor` present.
2. `design/rollback.md` written with the `Bun.cron(...)` one-liner
   plus stop / uninstall / `git checkout pre-supervisor` steps.
3. `bun cli/main.ts svc install` → wrote plist + shim; LaunchAgent
   loaded (`launchctl list | grep automations` → `13645 0 dev.z.automations`).
   `curl 127.0.0.1:7777/healthz` → 200, `{"status":"ok","jobs":1}`.
4. `auto run bun-global-upgrade --force` →
   - row in `runs`: `state=succeeded`, `exit_code=0`, duration 568ms.
   - log file at `data/runs/2026/04/30/<run_id>.log`, 56-byte path.
   - captured log content: `bun upgrade` and `bun update --latest`
     output present (worker stdout fix verified end-to-end).
5. `bun -e 'await Bun.cron.remove("bun-global-upgrade")'` returned
   undefined (idempotent; second call also undefined). `Bun.cron.list?.()`
   is unsupported in 1.3.13 — could not list-verify removal directly.
   The next 03:30 boundary is the real test.
6. **Pending — requires two real scheduled 03:30 fires.** Validation
   plan for those days:
   - new `runs` row with `trigger_kind=cron`, `state=succeeded`.
   - timestamp inside the captured log within ~60s of 03:30 local.
   - `bun-autoupdate/upgrade.log` ALSO has a fresh entry (because the
     worker still maintains it); cross-check that the timestamps match.
   - **Negative check:** if Bun.cron is still firing in parallel,
     there will be ONE upgrade.log entry at 03:30 (from the worker
     run, regardless of who scheduled it), but TWO runs rows would
     indicate double-firing. We expect ONE runs row per day.

Until step 6 confirms, Phase 1 is "code-complete; cutover validated
through manual run; awaiting 2-day cron observation."

End state: LaunchAgent loaded, supervisor running on 127.0.0.1:7777,
healthz green, jobs=1, Bun.cron entry removed, rollback documented.

# Phase 2 — HTTP API + read-only SPA + CLI v1

## Wave 1 — server + API + SSE + token  (commit pending)

Single sequential agent. Per D-07, with codex caveats from Q-07
(Origin/Host enforcement, no permissive CORS, SSE over WebSocket
for v1, /healthz unauthenticated).

- `supervisor/server.ts`: `startServer({db,runner,registry,
  cronAdapter,configStore,port,repoRoot})` owns Bun.serve.
  Route-prefix split: `/api/*` (token + Origin/Host),
  `/events?token=` (SSE), `/healthz` (no auth), `/assets/*`
  (immutable cache, path-traversal guard via `resolve()` containment),
  `/` and SPA fallback (HTML with token bootstrap, `Cache-Control:
  no-store`). Phase-1's inline `Bun.serve` block in main.ts replaced
  by a single `startServer(...)` call.
- `supervisor/auth.ts`: `loadOrCreateToken()` (32-byte hex, atomic
  write, mode 0o600), `verifyToken` (constant-time), `checkOrigin`
  (allow absent, reject mismatched).
- `supervisor/sse.ts`: `SSEBroadcaster` — `subscribe(req)` returns
  Response with ReadableStream; `emit(name, data)` fan-outs
  `event: <name>\ndata: <json>\n\n`; 15 s heartbeat (`: ping`).
  Subscriber set is a `Set<ReadableStreamDefaultController>` with
  cancel-cleanup.
- `supervisor/api/router.ts`: hand-rolled router (`:param` + trailing
  `*`); `json()` / `errorJson()` helpers.
- `supervisor/api/{jobs,runs,triggers,config}.ts`: full endpoint set
  per Q-07. Manual run via `triggerManual` (Wave 3 manual adapter);
  cancel via `runner.cancel`. Trigger enable/disable also calls
  `cronAdapter.reconcile(registry.activeCronJobs())` so paused /
  disabled triggers leave the schedule immediately.
- `supervisor/registry.ts`: `activeCronJobs()` now also filters
  `paused_until > now` and `enabled = 0`. Spec'd in-scope.
- `supervisor/main.ts`: wires Runner events
  (`run.queued|started|finished|skipped`) and ConfigStore events
  (`reloaded` / `error`) to the broadcaster. Also re-wires after
  degraded-mode rebuild. `server.stop()` runs before
  `runner.shutdown()` in graceful shutdown.

SSE event types locked: `run.{queued,started,finished,skipped}`,
`config.{reloaded,error}`, `db.error`, `degraded.{entered,exited}`.

API contract locked (`/api/jobs`, `/api/jobs/:name[/run|enable|
disable|pause|unpause]`, `/api/triggers/:trigger_id/[enable|disable]`,
`/api/runs[?job=&state=&limit=&before=]`, `/api/runs/:run_id[/log|/cancel]`,
`/api/config/[status|reload]`, `/events`, `/healthz`, `/`,
`/assets/*`, SPA fallback). Waves 2 + 4 must not deviate.

Token in `data/.token`: 32 bytes hex, mode 0o600, generated on first
start. Auth via `Authorization: Bearer <token>` or
`X-Auto-Token: <token>` for `/api/*`; `?token=<...>` query param for
`/events`. Origin/Host check on both surfaces (allow absent for curl,
reject mismatched).

Tests: 25 new (`test/server.test.ts` + `test/sse.test.ts`). Suite
total **64 pass / 0 fail / 398 expects**. Verifies token shape +
mode, Bearer + X-Auto-Token, Origin/Host gate, all jobs endpoints,
runs ambiguous-prefix + log + cancel-already-finished, SPA shell +
asset traversal-guard, healthz pass-through, SSE (`: connected`,
heartbeat, event delivery, wrong/missing token, two-subscriber
fan-out).

Live verifications (post `auto svc restart`):
- `/healthz` → 200 with uptime + jobs=1.
- `data/.token`: 65 bytes (64 hex + newline), mode 0600.
- `/api/jobs` with Bearer token → full JSON including triggers +
  last_run.
- `/api/jobs` without token → 401 `{"error":"unauthorized"}`.
- SSE smoke: `: connected` then `event: run.started` + `event:
  run.finished` delivered for a manual run started via
  `POST /api/jobs/.../run`.
- `curl /` returns HTML containing `<script id="auto-bootstrap"`.

Note: agent's SSE smoke fired the real `bun-autoupdate` worker
(only configured job). Bun was already current; no-op result. No new
entry in `bun-autoupdate/upgrade.log` because the worker did write
to it but found nothing to log past the version banner. Fine.

## Waves 2 + 3 — CLI v1 + UI scaffold  (commit pending)

Two parallel agents, both consuming the Wave 1 API contract.

### Wave 2 — CLI v1 (per D-11)

- `cli/client.ts`: `ApiClient` with token loading, Bearer + Origin
  header injection, `AbortSignal.timeout`, typed errors
  (`SupervisorUnreachable`, `TokenMissing`, `ApiError`). Methods
  cover the entire Wave 1 endpoint surface.
- `cli/sse.ts`: auto-reconnecting SSE client (250ms→5s backoff).
- `cli/commands/{job,cancel,enable,disable,pause,trigger,config,
  ui,doctor,data}.ts`: 10 new commands.
- `cli/commands/{run,runs,log,last,version}.ts`: flipped from
  PHASE-1-DIRECT-DB to API. `auto log --follow` now uses SSE
  (`run.finished`) instead of `fs.watch`. `grep -r PHASE-1-DIRECT-DB
  cli/` is empty.
- `cli/main.ts` `safeRun()` wrapper maps `SupervisorUnreachable→3`,
  `ApiError(409)→4`, `TokenMissing→1`. Removed the catch-all
  unknown-command guard since all v1 verbs now exist.
- `cli/commands/svc.ts`: stays offline (uses launchctl + filesystem).

`auto data wipe` is gated: requires supervisor stopped, prompts for
literal `wipe`, refuses if cwd ≠ `~/.automations`.

`auto doctor` checks: LaunchAgent loaded, supervisor reachable,
token file (mode 600), config valid, DB integrity (the one
intentional direct-DB read post-Wave-2 — diagnostic, not feature),
Bun.cron entries (INFO-only since `Bun.cron.list?.()` is unsupported
in 1.3.13), last 03:30 fire observation.

Tests: 17 new (`test/cli-client.test.ts` 388 lines + rewritten
`test/cli-smoke.test.ts`). Suite total **81 pass / 0 fail / 452
expects**. Verified live: all 8 acceptance criteria pass with
supervisor up; `auto runs` exits 3 with supervisor stopped; `auto
doctor` exits 1 (not 3) reporting unreachable as a `[FAIL]`.

### Wave 3 — UI scaffold (per D-08)

- `ui/` is its own package (`@automations/ui`, private). Root
  `package.json` and `bun.lock` unchanged.
- Stack: Vite 7 + React 19 + Tailwind v4 (`@tailwindcss/vite`, no
  `tailwind.config.js` — `@theme` blocks in CSS) + React Router 7 +
  React Query 5.
- `ui/index.html`: serves a minimal shell. The supervisor and the
  Vite dev plugin both INJECT the bootstrap `<script id=
  "auto-bootstrap" type="application/json">{"token":"...","port":N}
  </script>` immediately before `</head>`. **Symmetric — neither
  uses string substitution.** This deviates from the brief I wrote
  (which suggested `__AUTO_TOKEN__` placeholders) but matches the
  actual Wave 1 implementation, which Q-08's codex caveat preferred
  ("JSON script blob, not raw replace"). Result: dev and prod boot
  via the same code path.
- `ui/vite-plugin-auto-token.ts`: dev-only Vite plugin that reads
  `<repo>/data/.token` at server start and uses
  `transformIndexHtml` to inject the bootstrap script. Warns (does
  not crash) if the token file is missing.
- `ui/vite.config.ts`: Vite dev on `:5173` proxies `/api/*`,
  `/events`, `/healthz` to `:7777`.
- `ui/src/api/{client,hooks,sse}.ts`: typed API + React Query hooks
  + `connectEvents` SSE wrapper (auto-reconnect with jittered
  backoff). Initial cache invalidation strategy: simple — invalidate
  on mutation + 30s poll for `useConfigStatus`. SSE-driven
  invalidation is Phase 5 polish.
- `ui/src/{components/Shell,components/ConfigStatusBanner,App,main,
  bootstrap}.tsx`: shell with nav + outlet, degraded-mode banner,
  React Query provider, BrowserRouter wiring.
- `ui/src/routes/{Jobs,JobDetail,Runs,RunDetail}Route.tsx`: stubs
  — Wave 4 populates them.
- `ui/README.md`: short note on `bun --cwd ui run dev` vs `build`.

Verifications:
- `bun --cwd ui install` → 88 packages; `bun --cwd ui run typecheck`
  → 0; `bun --cwd ui run build` → `dist/index.html` (0.40 kB) +
  `assets/index-<hash>.{css,js}` (6 + 267 kB).
- `bun --cwd ui run dev` + `curl http://localhost:5173/` returned
  HTML containing the bootstrap `<script>` with the REAL token
  from `data/.token`.
- `curl http://localhost:5173/healthz` returned the supervisor's
  healthz JSON (proxy works).
- `curl http://127.0.0.1:7777/` returned built HTML with the
  bootstrap script injected by the supervisor;
  `/assets/<hash>.{css,js}` returned 200 with `immutable` cache.

Wave 3 caveat: Vite 7 binds to IPv6 `[::1]:5173` — use `localhost`
not `127.0.0.1` when curling the dev server.

### Side fix from orchestrator

Root `tsconfig.json` previously type-checked `ui/` files using the
ESNext-only `lib`, producing DOM-related errors. Added
`"exclude": ["ui", "node_modules", "data"]` so the root tsc
exclusively covers backend/CLI code. UI has its own tsconfig with
DOM lib that `bun --cwd ui run typecheck` honors.

## Wave 4 — UI views  (commit pending)

Single sequential agent. Fills in the Wave 3 route stubs.

- `ui/src/util/format.ts` (78): pure helpers — `formatTime`,
  `formatRelative`, `formatDuration`, `shortId`, `formatPattern`,
  `formatTimeoutMs`. Built on `Intl.DateTimeFormat` (no `date-fns`).
- `ui/src/components/RunStateBadge.tsx`: colored chip per state
  palette (succeeded green, failed/killed red, timed_out orange,
  running yellow, queued blue, cancelled/skipped neutral).
- `ui/src/components/RunsTable.tsx`: reusable table with `showJob`
  toggle for use on both JobDetail and Runs.
- `ui/src/components/JobActions.tsx`: Run / Enable·Disable /
  Pause·Unpause panel with inline status messages.
- `ui/src/components/LogViewer.tsx`: `<pre>` viewer with 1s
  polling fallback while live; auto-scroll-to-bottom only when the
  user is within 100 px of the bottom (so manual scroll-up is
  honored). Uses `useLayoutEffect` to capture scroll distance
  before commit and `useEffect` to re-pin.
- `ui/src/api/sseHook.ts`: `useSSE()` mounted once at app start.
  Fan-outs SSE event names to React Query cache invalidations:
  `run.{queued,started,finished,skipped}` → invalidate `["runs"]`,
  `["run", id]`, `["job", name]`, plus `["run-log", id]` on
  `run.finished`. `config.{reloaded,error,degraded.{entered,exited}}`
  → invalidate `["config-status"]` + `["jobs"]`. Mounted via a
  `<SSEMount />` no-render component inside `<App />`.
- `ui/src/api/hooks.ts`: added mutations `useEnableJob`,
  `useDisableJob`, `usePauseJob`, `useUnpauseJob`,
  `useEnableTrigger`, `useDisableTrigger`. Each invalidates the
  affected job + jobs list on success.
- Routes:
  - `JobsRoute.tsx`: sorted job table with NAME / STATE / TRIGGERS
    / REENTRANCY / TIMEOUT / LAST RUN; row links to `/jobs/:name`.
  - `JobDetailRoute.tsx`: header + state card + `<JobActions>` +
    triggers list (with per-trigger enable/disable) + recent runs.
  - `RunsRoute.tsx`: URL-driven filters (`?job=&state=&limit=`)
    + "Load older" pagination via the `before` cursor.
  - `RunDetailRoute.tsx`: header + cancel button (only when
    state is running/queued) + metadata grid + ambiguous-prefix
    candidate list + `<LogViewer live=…>`.

Build size: `dist/index.html` 0.40 KB, `dist/assets/index-*.css`
13.58 KB (3.64 KB gzip), `dist/assets/index-*.js` 293.37 KB
(90.28 KB gzip). Within Q-08's expected baseline.

Verification:
- `bun --cwd ui run typecheck` → 0.
- `bun --cwd ui run build` → success in 450ms.
- `bun test` (root) → 81 pass / 0 fail.
- `bunx tsc --noEmit` (root) → 0.
- `curl http://127.0.0.1:7777/jobs` returns the SPA HTML with the
  bootstrap script (real token injected) — proves SPA fallback for
  client routes works.
- `curl -H "Authorization: Bearer $(cat data/.token)" /api/jobs`
  returns the live job array.

No new top-level deps. The user can now visit
`http://127.0.0.1:7777/` in a browser to see the live UI.

## Wave 5 — integration smoke + docs  (commit pending)

Orchestrator-only.

- README.md updated: architecture line for the HTTP/SPA, expanded
  "Quick start" to include `bun --cwd ui install/build`, full v1
  command cheat-sheet, dev-mode UI workflow, and the locked API
  surface. Replaced "What's not in v1" with "What's still ahead"
  (Phase 3+).
- AGENTS.md updated: split deps into supervisor/CLI vs UI sections;
  added "HTTP server (Phase 2)" with route split + Origin/Host rules
  + token shape; added "SSE event types (locked)" enumeration;
  updated CLI conventions to remove the Phase-1-DIRECT-DB note
  (single intentional exception: `auto doctor`'s
  `PRAGMA integrity_check`); added "UI" conventions section;
  updated tests + type-checking; added "How to add a new API
  endpoint" cookbook; updated "What NOT to do" entries (loopback-only
  bind, `/hooks/*` is Phase 3 and 404s today).
- CLAUDE.md updated: useful-commands cheat sheet now covers UI dev
  + build + Phase 2 verbs (job, pause, doctor, ui, config status);
  defaults extended (extend `api` in BOTH `cli/client.ts` and
  `ui/src/api/client.ts`; new SSE events update both consumers + the
  hook); guardrails for loopback-bind and the package separation.

Final integration smoke (orchestrator-run):
- `bun test` → 81 pass / 0 fail / 452 expects.
- `bunx tsc --noEmit` (root) → 0.
- `bun --cwd ui run typecheck` → 0.
- `launchctl list | grep automations` → loaded.
- `auto doctor`: 5 OK + 1 INFO + 1 WARN (the WARN is the still-open
  Phase-1 cutover step 6 — "no cron run since 2026-04-30 03:30:00",
  expected, awaits real time).

# Phase 2 — DONE (code-complete)

The supervisor exposes a token-protected loopback HTTP API + SSE +
React SPA. The CLI talks to the supervisor over the same API. The UI
boots via the same `<script id="auto-bootstrap">` shape in both dev
(Vite plugin) and prod (supervisor injection). 81 backend tests pass;
both root and UI typecheck clean.

What's queued for **Phase 3** (per build-plan.md):
- `data/secrets.json` (mode 0600), `auto secret list/set/remove` CLI;
  validation at startup (missing secret → degraded trigger);
  redaction in run-log capture (already wired — list goes from empty
  to populated).
- Webhook adapter at `/hooks/:trigger_name` with HMAC verification,
  body limits, content-type allowlist, opt-in payload persistence
  to `data/payloads/<run_id>.json`.
- README guidance on tunnels (cloudflared / Tailscale Funnel) with
  the `/hooks/*`-only path filter requirement.

Still open from Phase 1:
- Cutover validation step 6 — two real scheduled 03:30 fires must
  produce successful `runs` rows with `trigger_kind="cron"`. Awaits
  real time. The `auto doctor` "Last 03:30 fire" check will flip to
  OK once observed.


# Pre-launch polish

A coordinated pass over the whole engine after a critical review, on the
project owner's instruction to fix and polish everything before the first
prerelease. Eight engineers worked concurrently on disjoint file sets against
a shared contract (short run ids, browser auth, allowed hosts, shutdown and
recovery contracts, filesystem modes, additive API changes, job identity by
name, cron semantics). The decisions are recorded as D-17 to D-40; three
have Q files (Q-17 browser auth: cookie session rejected, Q-18 config
subprocess, Q-19 retention). A cookie session for the browser was built first
and then removed on the owner's instruction (D-41); the entries below describe
the final model.
User-visible changes, including the breaking ones, are in
[CHANGELOG.md](../CHANGELOG.md). No commits were made by the engineers; all
changes are working-tree edits.

## What changed

- **Lifecycle (foundations):** `main.ts` is the only owner of signals;
  graceful, capped shutdown (10 s grace, 15 s hard deadline); crash recovery
  of interrupted runs and orphaned workers (`recovery.ts`); JSON singleton
  lock with pid and command-line identity; startup failures exit 70 or 78 and
  the watchdog tick throws; safety net for unhandled errors; a database newer
  than the build is refused; `supervisor.log` tee, notifications, and
  `0700`/`0600` file modes. `auto install` and `svc` wait for `/healthz`.
  (D-17 to D-21)
- **Runner, cron and conditions:** workers in their own process groups;
  bounded pipe drain; queue promotion re-checks admission; DB-level
  disabled/paused enforced; byte-level redaction safe across chunks; own
  local-time cron parser and timer loop with defined DST and missed-fire
  behavior; in-flight guard for condition checkers. (D-22 to D-25)
- **Auth and HTTP:** the token stays in the served page and the SPA sends it
  as a bearer (no cookies, no sign-in; `auto ui` just opens the URL);
  `Host`/`Origin` policy with `AUTO_ALLOWED_HOSTS` and the built-in
  `auto.localhost`; proxied loopback requests refused; `?token=` and
  `X-Auto-Token` removed; `POST /api/token/rotate`; CSP and other headers; minimal
  `/healthz`; static serving with realpath containment; SSE hardening; secret
  store that reloads on change. (D-26 to D-29)
- **Webhooks and runs API:** streamed body cap, uniform 401, digest and
  delivery-id dedupe, receipt after admission, payload cleanup; run id
  resolution (exact, prefix, suffix), keyset paging headers, log offsets.
  (D-30, D-31)
- **Config:** loading in a subprocess (works around the Bun 1.4.2 stale module
  bug), one shared validation for hot reload, cold start and `--check`,
  commit-after-apply, serialized reloads, resilient watcher, scheduling state
  on the registry (pause timer, webhook reconcile), additive job/trigger API
  fields. (D-32, D-33)
- **Retention:** sweeper with 90 day horizon and per-job floor, additive
  migration `0003_retention_indexes.sql`. (D-34, D-35)
- **CLI:** last-8 short ids, `--force` only on `run`, exit codes, output flush,
  `jobs`, `create --add`, idempotent `init`, follow loop, locked secrets
  rewrite, `token rotate`, safer `data wipe`, richer `doctor`. (D-36, D-37)
- **Dashboard:** live log following, error and token-changed states, connection bar,
  dark mode, phone layout, inline confirmations, pure tested helpers.
  (D-38)
- **Docs and packaging:** README, SECURITY, AGENTS, CLAUDE, rollback, this log,
  CHANGELOG, CI on macOS, `test:package` = `bun test`. (D-39, D-40)

## How it was verified

Each engineer verified their own slice; the docs engineer's checks were:

- `bun run verify` (root typecheck, UI typecheck, full `bun test`): typechecks
  clean; 908 tests across 60 files, 907 pass, 1 fail. The failure is
  `test/webhook-ingress.test.ts` "a genuinely disabled job (real runner) is a
  503 and leaves nothing behind": a config-disabled job answers 503 (its `/hooks` route exists), not the 404
  this entry originally claimed; the code, README and SECURITY.md agree on 503, and the
  failing test was reconciled later. The failure was open at the time (test owner or product decision).
- `bun pm pack --dry-run --ignore-scripts`: 77 files, no source maps, no
  `test/` or `design/` files, `CHANGELOG.md` and `SECURITY.md` included. A
  plain `bun pm pack --dry-run` runs `prepack`, which now runs the full suite
  and therefore fails while the test above fails.
- Scratch supervisor on a private port (torn down afterwards): the first-run
  flow (`init`, `config check`), `/healthz` shape and headers, `Host`
  rejection, bearer 401, unknown `/hooks` (recorded then as 404; since D-42 it is a
  uniform 401), `auto doctor` output and exit
  code, webhook 401/405/202/duplicate/415, a disabled job's `/hooks` route
  answering 404 (a disabled job's route answers 503 after the signature verified),
  `/events?token=` 401, `auto token rotate` invalidating the old
  token, file modes, and SIGTERM shutdown.
- README commands and flags were compared against `bun cli/main.ts --help` and
  each command's `--help`.

Not verified: Linux and Windows anywhere; `auto install`, `auto svc *` and the
real OS watchdog (forbidden in review sessions); `auto ui` opening a browser;
Bun 1.3.0 (the declared minimum; development used 1.4.2, and the availability of
`Bun.cron` OS registration at 1.3.0 was not checked); a real GitHub Actions run
of the new workflow.
