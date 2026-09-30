# Design decisions — Auto supervisor

Running log of design decisions for the supervisor-based rebuild of
`~/.automations`. Each decision is sourced from a numbered question in
[questions/](questions/) and adjudicated by Codex CLI acting as design
reviewer.

Entries 17 onward record the pre-launch hardening pass. Where they conflict
with an earlier entry they supersede it; the affected earlier entries carry an
"Amended by" note and are otherwise kept as written, as history.

## Goals (set by user, not under debate)

- Long-running supervisor process that owns scheduling, HTTP, watchers.
- React + Tailwind SPA UI, served by Bun.
- Webhooks for external triggers (PR updates etc.).
- File-change triggers.
- Built on top of the existing Bun-based config foundation in this repo.

## Resolved decisions

### 01 — Supervisor lifecycle: macOS LaunchAgent

**Superseded by D-15 on 2026-09-21.** Bun now owns cross-platform OS-level
registration; the dedicated LaunchAgent implementation is retained only as
historical context.

**Decision:** Run the supervisor as a `~/Library/LaunchAgents/` LaunchAgent with `RunAtLoad=true` and `KeepAlive=true`. Provide a foreground/manual mode (`bun supervisor.ts`) for development and recovery.

**Rationale:** Native to macOS, no extra deps, user-scoped (no root), survives reboots, restarted by launchd on crash. LaunchDaemon is disproportionate risk for a single-user laptop. Manual-only would defer the install/restart/log story instead of solving it.

**Plist must specify:** `WorkingDirectory`, absolute Bun path, explicit `PATH`, `StandardOutPath`, `StandardErrorPath`, `ThrottleInterval`.

**Source:** [Q-01](questions/Q-01-supervisor-lifecycle.md)

### 02 — Process model: subprocess per invocation

**Decision:** Supervisor spawns a fresh `bun <job>/worker.ts` subprocess for every trigger fire. It captures stdout/stderr/exit code, applies a timeout, and writes one row per run to the run-history DB.

**Rationale:** Fault isolation is genuinely valuable (a 60s `bun upgrade` shouldn't block PR webhooks). Spawn overhead (~30–80ms) is irrelevant at personal scale. Existing worker contract already runnable directly — zero migration cost. Workers don't get DB or supervisor state access; they fetch via supervisor's HTTP API if needed.

**Subprocess contract (must be defined when implementing the runner):** `cwd`, env inheritance rules, absolute Bun path, stdin behavior, stdout/stderr capture size limit, per-job timeout, signal escalation (SIGTERM → grace period → SIGKILL), and how signal-exits are recorded distinct from non-zero exit codes.

**Source:** [Q-02](questions/Q-02-process-model.md)

### 03 — Trigger model: unified `Trigger` union, per-kind adapters

**Decision:** A job declares one or more triggers. `Trigger` is a discriminated union: `cron | webhook | watch | manual`. The supervisor exposes a single `runWorker(jobName, triggerCtx)` primitive. Per-kind concerns (cron parsing, HTTP routing + auth + body parsing, file-watch debounce) live in separate adapter modules that converge on that primitive. As amended by D-15, the supervisor uses Bun's in-process cron API while retaining trigger admission, history, conditions, and worker execution.

**Schema implications:**
- Each trigger gets an explicit `trigger_id` (or stable name) so a job with two webhooks or two watches is distinguishable in history/UI/disabling.
- `manual` is treated as a system-provided trigger, always available; runs initiated from CLI/UI record as `trigger_kind=manual` in history.
- Per-kind `trigger_meta` has a **typed summary contract** (bounded, query-useful fields), not an arbitrary JSON blob. Raw payloads (e.g., full GitHub webhook body) are stored by reference if at all.
- Reentrancy/concurrency policy lives on the job by default, but the schema leaves room for per-trigger override (watch in particular wants debounce/coalesce that cron/manual shouldn't inherit).

**Source:** [Q-03](questions/Q-03-trigger-model.md)

### 04 — Reentrancy and timeouts

**Run-layer overlap policy** (`reentrancy`): `drop | queue | parallel`. Default `drop` for cron/webhook/watch.

**Manual is special:** manual triggers from CLI/UI do **not** silently `drop` on overlap. They return an explicit "already running" conflict; user must choose "cancel" or "run anyway."

**Queue:** bounded by `queueDepth` (default 1). A queued run preserves its original trigger payload; queued entries can be cancelled independently of the running entry (no `killed` row when removing from queue — distinct state).

**Parallel:** requires per-run stdout/stderr capture owned by the supervisor. Worker-local shared log files cannot be the primary trace when parallel runs exist. (Implication for Q on storage / log layout.)

**Trigger-layer admission control** (separate from reentrancy): `watch` triggers debounce with `debounceMs` (default 500) **and** `maxWaitMs` (must be set in v1, not deferred — protects against starvation under continuous writes).

**Timeouts:** every run gets `timeoutMs` (default 600_000). On timeout: SIGTERM, then SIGKILL after `killGraceMs` (default 10_000). Recorded as `timed_out`. Per-job override (e.g., `bun-autoupdate` → 30 min).

**Run state machine:** `queued | running | succeeded | failed | timed_out | skipped | killed | cancelled`.
- `skipped` carries `reason`: `overlap`, `queue_full`, `disabled`.
- `killed` = explicit kill of *running* worker.
- `cancelled` = removed from queue before it ever started.

**Punted to later:** `coalesce` (merge payloads from multiple watch fires). Add only if a real workload demands it.

**Source:** [Q-04](questions/Q-04-reentrancy-and-timeouts.md)

### 05 — Config source of truth: hybrid (TS for definitions, DB for runtime state)

**Decision:** `~/.auto/auto.config.ts` is canonical for *definitions* (job + triggers + timeouts + reentrancy). SQLite is canonical for *runtime state* (enable/pause flags, run history). UI is read-only over definitions and full-control over runtime state. No CRUD-the-config-via-UI in v1.

**Stable identity:** every job gets a `job_id` (UUID or slug) that survives rename. Run history and runtime-state rows reference `job_id`, not `name`. Same for trigger IDs from Q-03.

**Trigger-level enable/disable:** runtime-state overrides exist at the trigger level (not just per-job). UI can mute one noisy webhook while keeping cron/manual active.

**UI must surface override state:** "configured in TS, currently disabled/paused by DB" — always show both layers when they disagree.

**Config reload:**
- Supervisor watches `~/.auto/auto.config.ts` and reloads on change.
- **On reload error (syntax / type / import failure): keep last-known-good config active, surface error to UI, do NOT tear down working triggers.**
- Reload is non-disruptive: in-flight runs use the *old* config until they finish; new triggers use the new config.

**`enabled` semantics:** DB-side disable is a *local/runtime override*. To retire a job permanently, remove it from TS config. Supervisor reconciles on reload: jobs missing from config get `archived` (kept for history queries, not active).

**Punted:** secrets storage (env vars vs `.env` vs Keychain) — separate question.

**Source:** [Q-05](questions/Q-05-config-source-of-truth.md)

### 06 — Storage: SQLite + per-run log files in `data/`

**DB location:** `~/.auto/data/automations.db` (gitignored, WAL mode). Self-contained wipe/rebuild via `auto data wipe`.

**Tables:**
- `jobs` — `job_id` (UUID PK), `name` UNIQUE, `enabled`, `paused_until`, `archived_at`, `last_seen_in_config_at`, `created_at`.
- `triggers` — `trigger_id` (PK, **required user-assigned name**, not a hash), `job_id` FK, `kind`, `config_json`, `enabled`, `last_seen_in_config_at`, `archived_at`, `updated_at`, `created_at`. Same archival/reconciliation lifecycle as `jobs`.
- `runs` — `run_id` (UUIDv7 PK), `job_id` FK, `trigger_id` FK (null for manual), `trigger_kind`, `state`, `skip_reason`, `enqueued_at`, `started_at`, `finished_at`, `exit_code`, `signal`, `trigger_meta` JSON, `log_path` (relative), `payload_path` (relative, optional), `pid`, `cwd`, `worker_path`, `definition_hash`.

**Trigger identity:** **user-assigned stable name is required**, not optional with hash fallback. Hashes are for drift detection only, never for identity.

**Per-run logs:** supervisor pipes worker stdout+stderr (merged) to `data/runs/<YYYY>/<MM>/<DD>/<run_id>.log`. Capped at 5MB with truncation marker. Default 90-day retention (file deleted, DB row stays). Paths stored **relative** to `data/`, not absolute — keeps moves/restores robust.

**Worker-domain logs (e.g., the existing `bun-autoupdate/upgrade.log`) are explicitly secondary.** The supervisor's per-run capture is the canonical trace shown in UI/history.

**Webhook payloads:** digest goes in `trigger_meta`. Full body stored at `data/payloads/<run_id>.json` only if the trigger opts in via `keep_payload: true`. Default off.

**Run-explainability over time:** runs persist `worker_path`, `cwd`, `pid`, and `definition_hash` so an old run remains debuggable even after the config file has changed.

**Migrations:** SQL files in `supervisor/migrations/NNNN_name.sql`, run transactionally on startup. Migration failure → supervisor refuses to start, surfaces error to UI; distinct from crash-loop.

**Source:** [Q-06](questions/Q-06-storage-and-logs.md)

### 07 — HTTP service: one Bun.serve on 127.0.0.1, route-prefix split, SSE for live updates

**One process, one port (default `127.0.0.1:7777`), one `Bun.serve`** owning all surfaces. Routes:
- `/api/*` — internal API (UI + CLI). Token-protected, `Origin`/`Host` checked.
- `/hooks/:trigger_name` — webhook ingress. Per-trigger HMAC verification; max body size, content-type checks, timeout, cheap pre-read rejection.
- `/events` — Server-Sent Events stream for live UI updates (run.queued/started/finished, config.reloaded/error). **SSE in v1, not WebSocket** (one-way is enough; UI cancels via REST).
- `/healthz` — minimal liveness check, leaks no config or token state.
- `/*` — SPA (HTML fallback for client routes), served same-origin.

**Network exposure:** loopback by default. **Webhooks reach the outside world only via a tunnel that path-filters to `/hooks/*` only and fails closed.** Never bind `0.0.0.0` directly.

**Auth posture:**
- API token at `~/.auto/data/.token` (mode 0600). CLI reads it; UI gets it only via the served HTML/app shell (not via a separate `/api/_init` JSON endpoint — too easy to fetch from anywhere same-origin).
- All mutating API calls require token + non-simple auth header (e.g., `Authorization: Bearer …` or `X-Auto-Token: …`) + matching `Origin`/`Host`.
- No permissive CORS. Reject unexpected `Origin`.
- `/hooks/*` does not use the token; HMAC only.

**Webhook hardening (must-haves at `/hooks/*`):** max body size cap, expected content-type allowlist, request timeout, cheap rejection before any storage. Webhook handler does the minimum (verify, enqueue, 202) — heavy work happens in the worker subprocess.

**Amended by D-26, D-27, D-30 and D-41:** the SPA still receives the API token in the served HTML (cookie sessions were tried and rejected, D-41). `Authorization: Bearer` is the only accepted credential (`X-Auto-Token` and `/events?token=` are gone), `Host` is checked on every route except `/hooks/*` and a minimal `/healthz`, a present `Origin` must be allowed for every method, and the hard-coded proxy host is replaced by `AUTO_ALLOWED_HOSTS` plus the built-in `auto.localhost`. `/healthz` now returns only `{ok, degraded}`.

**Source:** [Q-07](questions/Q-07-http-surfaces.md)

### 08 — SPA: Vite + React 19 + Tailwind v4 + React Query

**Stack:** Vite (dev server with HMR + prod build), React 19, Tailwind v4 with `@tailwindcss/vite`, React Query as the API cache boundary (not as global state). React Router for client-side routing. Native `EventSource` for SSE.

**Layout:** SPA source under `ui/` with its own `package.json`, separate from the supervisor's deps. Built output to `ui/dist/` (gitignored).

**Dev workflow:**
- Terminal A: `bun supervisor.ts` on `127.0.0.1:7777`.
- Terminal B: `bun --cwd ui run dev` → Vite on `:5173` proxying `/api/*`, `/hooks/*`, `/events` to `:7777`.
- **Dev token bootstrap (must be solved explicitly, not at impl time):** Vite is the one serving `index.html` in dev, so supervisor injection doesn't apply. Concrete plan: dev mode reads `data/.token` directly via a tiny Vite plugin and writes it into the dev `index.html`. Same-machine, same-user, fine.

**Prod serving:**
- Supervisor serves `ui/dist/` at `/`.
- `Cache-Control: public, max-age=31536000, immutable` for hashed `assets/*`.
- `Cache-Control: no-store` for `index.html` (it carries the token; not just `no-cache`).
- **Token injection:** as an escaped JSON `<script>` blob or `data-` attribute on a known element — **not** raw string replacement. Treat the HTML response as secret-bearing.
- **Static serving rules:** explicit allowlist of paths under `ui/dist/`. The catch-all must not be able to reach `data/.token`, run logs, the SQLite file, or arbitrary repo paths. Resolve paths and verify they stay under `ui/dist/` before serving.
- **SPA fallback excludes `/assets/*`:** a missing hashed asset returns 404, never `index.html`. Returning the shell on a missing JS/CSS hides cache/build mismatch bugs.

**Tailwind v4:** keep the setup boring and explicit; avoid leaning on "no config" as a feature. Document any plugins / theme tokens directly.

**Amended by D-28 and D-41:** the bootstrap tag carries `{token, port}` (the token embedding stands; see D-41). The Vite dev plugin injects the same tag from the workspace token file on every page load. The SPA uses a fetch-streaming events client instead of native `EventSource`. The dev command is `bun run --cwd ui dev`.

**Source:** [Q-08](questions/Q-08-spa-build-and-serve.md)

### 09 — Supervisor failure handling

**launchd contract (simpler than original sketch):**
- `KeepAlive` dict with `SuccessfulExit=false`, `Crashed=true`. **launchd restarts on any non-zero exit; "no restart wanted" must be exit 0**, not a different non-zero code. (Codex pushback: per-exit-code semantics in the original sketch overclaimed launchd behavior.)
- `ThrottleInterval=300` (5 min). Single value. For a personal supervisor, fast retry on persistent faults is just noise.

**Per-mode behavior:**

| Failure | Behavior |
|---|---|
| **Bad config on cold start** | Start in *degraded mode*: HTTP up, no triggers wired, `/api/config/status` shows error, `/healthz` returns 503, banner in UI, `terminal-notifier` fires once on first transition into degraded mode. |
| **Bad config on hot reload** | Keep last-known-good; SSE `config.error`; UI banner; in-flight runs continue under old config. (Already locked in by Q-05.) |
| **DB migration failure** | After notify-before-give-up, **exit 0** so launchd doesn't hammer. Write `data/migration-error.log` and `data/state/last-error.txt`. User must intervene. |
| **Port in use by another instance** | Acquire a real **filesystem lock** (`flock(2)` / `fs.openSync(path, 'wx')`) at `data/supervisor.lock` *before* binding the port. PID files are diagnostic only, not synchronization. If lock not acquirable, exit 0. |
| **Worker spawn failure** | Per-run failure, not supervisor failure. Run row: `state=failed`, `skip_reason=spawn_failed`. After N consecutive same-trigger spawn failures, auto-disable the trigger with notification. |
| **DB write failure mid-flight** | Best-effort SSE `db.error`, write `data/db-error.flag`, attempt graceful continue. If unrecoverable: notify, exit 0 (don't crash-loop). |
| **Hard crash (SIGSEGV/OOM)** | launchd restarts after `ThrottleInterval`. `StandardErrorPath` captures crash. |

**Persisted failure counting:** in-process counters reset on every launchd restart. "After N retries" semantics require a persisted counter in `data/state/start-history.json` (last 20 starts with timestamps + exit codes). Crash-loop detection compares against that file, not in-memory state.

**Config validation at startup:** type errors don't exist at runtime unless explicitly checked. Startup runs an explicit validation pass over the imported config (Zod schema or equivalent) — TS type-checking happens at edit time in the IDE; runtime safety is on the supervisor.

**`bun supervisor.ts --check`:** non-running mode that validates config + dry-runs migrations + reports status. CLI uses this for "is my config OK?" without touching the running supervisor.

**Amended by D-19, D-20 and D-21:** the singleton is a JSON lock with a pid plus command-line identity check (not `flock`), startup failures exit non-zero (70 or 78) instead of 0 and the watchdog tick fails loudly, `start-history.json` and crash-loop counting were removed, and a database migrated by a newer build is refused. Spawn failures are recorded as `spawn_error` (not `spawn_failed`) and there is no auto-disable after repeated failures.

**Source:** [Q-09](questions/Q-09-supervisor-failure-handling.md)

### 10 — Secrets: `data/secrets.json` (mode 0600), config references by name

**Storage:** plain JSON at `~/.auto/data/secrets.json`, gitignored, **`chmod 600`**. Supervisor is the only reader from disk.

**Config indirection:** `auto.config.ts` references secrets by name (`secretRef: "github_webhook"`), never by value. Workers declare which secrets they need (`secrets: ["anthropic_api_key", "github_pat"]`); supervisor injects only those into that worker's env at spawn time as `SECRET_<UPPER>`.

**Validation at startup:** **every `secretRef` and every job-declared secret must exist before wiring the trigger/job.** Missing secrets cause that trigger/job to register in degraded state (visible in UI, no fires) — they don't take down the supervisor.

**Run-log redaction (v1, not deferred):** before writing captured stdout/stderr to disk, supervisor scans for exact-value matches of loaded secrets and replaces with `[redacted:NAME]`. Exact-string match is cheap and prevents the most obvious footgun.

**CLI for managing secrets:** `set`, `list`, `remove`. **No `get` subcommand** — it encourages scrollback leaks. Use `show --confirm` if a viewing affordance is ever needed.

**Reload:** supervisor watches `secrets.json` (same `fs.watch` mechanism as config). New triggers get the new value. In-flight worker subprocesses keep the old value (env was set at spawn).

**Caveats to document:**
- `chmod 600` only protects against same-machine other-user reads. Full-disk exfiltration is out of scope of this protection.
- Env is still observable inside the worker process (debug output, crash dumps, subprocess inheritance).
- Time Machine will back up `secrets.json` unencrypted. Either exclude it from Time Machine, or accept that encrypted disk backups are part of the threat model. **Never enable iCloud Drive sync on `~/.automations/`.**

**Punted:**
- Keychain-backed master key (option c). Add per-secret if a future need warrants it.
- First-class rotation. Edit file → reload semantics is fine for v1.

**Status note (D-23, D-29, D-36):** secrets are used to verify webhook signatures and are redacted from run logs; workers do not declare or receive them (no `SECRET_<UPPER>` injection was built). The secret store reloads on file change. `auto secret set` locks and atomically rewrites the file. Redaction is byte-level, safe across chunk boundaries, and has a 4-character minimum.

**Source:** [Q-10](questions/Q-10-secrets-storage.md)

### 11 — CLI: single `auto` binary, grouped subcommands, smaller v1

**Single binary `auto`** at `~/.local/bin/auto`, shells out to `bun ~/.automations/cli/main.ts "$@"`. Verb-first style with subcommand groups: `auto svc`, `auto job` (and shorthands), `auto secret`, `auto config`, `auto data`, plus diagnostic commands.

**v1 surface (deliberately smaller than initial sketch):**

- **Service lifecycle (offline-capable):** `svc install`, `svc uninstall`, `svc start | stop | restart`, `svc tail`. (Removed: `svc status`, `svc check` — folded into `doctor` and `config check`.)
- **Jobs (online, talks to supervisor /api/*):** `jobs`, `job <name>`, `run <name>`, `cancel <run_id|name>`, `enable <name>`, `disable <name>`, `pause <name> [duration]`, `trigger enable|disable <trigger_name>`.
- **Runs and logs:** `runs`, `log <run_id> [--follow]`, `last <name>`.
- **Secrets (offline):** `secret list`, `secret set`, `secret remove`. **No `get`** (Q-10).
- **Config:** `config check` (validates without touching supervisor), `config status` (online; current version + errors), `config edit` (opens `$EDITOR`, validates after).
- **Misc:** `ui` (opens browser), `doctor` (the canonical diagnostic), `version`.
- **Destructive — separate, explicit:** `data wipe` (deletes `data/`, prompts, blast-radius distinct from `svc uninstall`). **`svc uninstall` does NOT touch `data/`.**

**Diagnostic consolidation:** `doctor` is the one place that checks LaunchAgent loaded, port responsive, DB reachable, config valid, token file present + 0600. `config check` is offline; `config status` is online. Don't proliferate overlapping health commands.

**Online vs offline behavior:**
- API-dependent commands: exit `3` if supervisor unreachable. Never silently fall back to direct SQLite inspection; only explicitly-offline commands touch the DB directly.
- **If stdin is not a TTY, prompts fail unless `--force` / `--yes` supplied.** Required global behavior, not per-command.

**Stable exit codes:** 0 success, 1 error, 2 usage, 3 supervisor unreachable, 4 conflict.

**Global flags:** `--json`, `--no-color`, `--token-file`, `--base-url`, `--yes`, `--force`. Naming chosen so `auto completion` can be added later without renames.

**Output:** stdout for data, stderr for status/errors, so `auto runs --json | jq …` works cleanly.

**Lib choices:** `commander` for arg parsing; `prompts` for hidden input; native ANSI / `picocolors` for color; hand-rolled tables (no `cli-table3`).

**Source:** [Q-11](questions/Q-11-cli-surface.md)

### 12 — Migration: strangler-fig, cron-first cutover (no parallel Bun.cron)

**Historical migration decision.** D-15 intentionally restores Bun cron as the
portable scheduler/lifecycle substrate without restoring the old per-job
unmanaged registration model.

**Approach: strangler fig over 5 phases.** Bun.cron is **explicitly removed and verified** at the end of Phase 1; **no parallel running** with the new supervisor (double-firing creates ambiguous evidence about which scheduler is keeping the promise).

**Phases:**
1. **Supervisor skeleton + cron + run history.** LaunchAgent installed, supervisor running, cron adapter only, SQLite + per-run logs working, `automations.config.ts` migrated to new union schema. CLI: `svc install/start/stop`, `runs`, `log`, `last`, **`run <name>`** (manual trigger required for proving the spawn → log → DB insert path on day one — don't wait overnight).
2. **HTTP API + read-only SPA.** `Bun.serve` + Vite + React + Tailwind. CLI gains job control commands.
3. **Webhooks.** Webhook adapter + `data/secrets.json` + `auto secret` CLI + HMAC verification.
4. **Condition guards + file watch.** Cron condition-checker subprocesses
   with durable state and success-coupled commit; file-watch adapter with
   debounce/maxWait.
5. **Polish.** Per-trigger UI, SSE invalidation in React Query, `auto doctor`, completion scripts, doc updates.

**Phase 1 cutover checklist (must complete before declaring success):**
- LaunchAgent loaded (`launchctl list | grep automations`).
- Supervisor `/healthz` returns 200.
- **Bun.cron entry actively removed** via `bun -e 'await Bun.cron.remove("bun-global-upgrade")'` and verified absent — removing source code does NOT remove persisted Bun cron state.
- Manual run via `auto run bun-global-upgrade` succeeds; row in `runs`, log file in `data/runs/...`, exit 0.
- **Two real scheduled runs at 03:30 succeed** before merging Phase 2.

**Rollback artifact:** keep a `design/rollback.md` (or top-level note) with the exact recovery one-liner: `bun -e 'await Bun.cron("<engine checkout>/bun-autoupdate/worker.ts", "30 3 * * *", "bun-global-upgrade")'`. A git tag alone is too slow during a missed daily.

**Timezone semantics:** the current schedule fires at 03:30 *local time* (matches Pacific). **Supervisor cron parser must honor local time and handle DST correctly.** Capture this in the cron-engine choice (later question / impl note); validate Phase 1 covers the next DST boundary if one is near.

**No backfill:** historical `upgrade.log` text is not parsed into the new `runs` table. Old log file retained as historical record.

**Pre-Phase-1 tasks:** git tag `pre-supervisor`, confirm last `upgrade.log` entry, lock layout (`supervisor/`, `cli/`, `ui/`, `data/`, existing job folders unchanged) before any code lands.

**Source:** [Q-12](questions/Q-12-migration-plan.md)

### 13 — Scheduled condition guards: subprocess checker, success-coupled state

**Decision:** A `cron` trigger may declare an optional `condition` whose
repo-relative checker is executed as a bounded Bun subprocess when the
schedule is due. The checker receives the previous JSON state and returns
`{ fire, state?, meta? }`. It never runs inline in the supervisor. This is a
guard on `cron`, not a fifth trigger kind; local filesystem `watch` retains
its existing meaning.

**Quiet evaluation:** `fire=false` persists returned state and condition
health without creating a normal run row. Checker failure preserves the
previous state and does not enqueue the worker.

**Fired evaluation:** `fire=true` enqueues the normal job worker with bounded
condition metadata. The proposed state remains pending and is committed only
in the same DB transaction that records the action as `succeeded`. Failed,
timed-out, killed, skipped, or cancelled actions do not advance state.

**Single-flight and retry:** while the fired action is queued or running,
further evaluations for that condition are suppressed. Retried actions are
at-least-once and must use a stable transition ID for idempotency; delayed
state commit is not an exactly-once guarantee.

**Isolation and authority:** checker stdin/stdout/state/meta are bounded;
default timeout is 30 seconds with normal signal escalation. Checkers are
read-only trusted local code and receive no action-worker secrets by default.

**Observability:** supervisor-owned state per trigger records committed and
pending state, evaluation count, last evaluation/fire, consecutive failures,
and bounded last error. `auto run` bypasses the condition without modifying
its state; a future `auto trigger check` provides explicit evaluation.

**Source:** [Q-13](questions/Q-13-scheduled-condition-guards.md)

### 14 — Webhooks: generic signed ingress with durable deduplication

**Decision:** V1 exposes globally unique `/hooks/:path` triggers using an
`hmac-sha256` verifier profile. Signatures cover exact raw body bytes. Accepted
deliveries receive a durable receipt and dedupe key before the normal worker is
enqueued; duplicate provider deliveries return 202 without a second action.

Workers receive bounded receipt metadata in `TRIGGER_META` and the authenticated
body through a private `TRIGGER_PAYLOAD_PATH`. Payloads are ephemeral by
default and retained only when `keepPayload` is explicit. HTTP 202 means
authenticated and admitted, not action success.

**Amended by D-30:** the receipt is written after a run exists (not before admission), deduplication also covers the body digest within 5 minutes, and unauthenticated callers get uniform answers.

**Source:** [Q-14](questions/Q-14-webhook-trigger-contract.md)

### 15 — Portable lifecycle and definition transfer through Bun + Git

**Decision:** Bun's OS-level cron API owns cross-platform service registration.
A once-per-minute `automations-supervisor` watchdog invokes the long-running
supervisor; its singleton lock prevents duplicate instances and the next tick
recovers from crashes or reboot. Configured job schedules use Bun's in-process
cron API, replacing `croner`.

Git distributes application code, job definitions, and non-secret assets.
Every machine bootstraps independent `data/`, tokens, secrets, history, and
runtime overrides. `bun scripts/auto-install.ts` performs frozen install/build/check,
registers the watchdog, installs the CLI shim, starts the server, and verifies
health. Plaintext secret export and implicit continuous Git pull are excluded.

**Amended by D-24:** configured schedules no longer use Bun's in-process cron API; Auto has its own local-time parser and timer loop. The OS-level watchdog still uses `Bun.cron`.

**Source:** [Q-15](questions/Q-15-portable-install-and-config-sync.md)

### 16 — Published engine and user-owned workspace

**Decision:** Distribute the supervisor, CLI, migrations, and built UI as the
`auto-supervisor` package. Keep configuration, workers, generated lifecycle
entry, secrets, history, and other runtime data in a separate user workspace,
defaulting to `~/.auto`. The engine repository never doubles as a live
workspace.

Custom `AUTO_HOME`, `AUTO_CONFIG`, and `AUTO_DATA_DIR` paths, plus `AUTO_PORT`, are resolved at
install time and written into the generated watchdog entry. Each workspace has
a stable, path-derived scheduler title so independently installed workspaces do
not overwrite one another; concurrent workspaces must use distinct ports.

**Source:** [Q-16](questions/Q-16-package-and-workspace-separation.md)

### 17 — Shutdown: `main.ts` owns signals, teardown is parallel and capped

**Context:** Signal handling was split between `lifecycle.ts` and `main.ts`, workers could outlive the supervisor, and `auto svc stop` waited a fixed, unrelated time.

**Decision:**
- **`main.ts` owns signals; teardown is parallel and capped.** `lifecycle.ts` installs no signal handlers, only a process `exit` hook that releases the lock. `main.ts` handles SIGINT, SIGTERM and SIGHUP once. Teardown stops cron, then runs `server.stop`, `configStore.stop`, `retention.stop` and `runner.shutdown(10 s)` concurrently, each capped, so the total stays under the runner cap (grace + 2.5 s) and the hard deadline (grace + 5 s = 15 s). `SHUTDOWN_GRACE_MS` and `SHUTDOWN_HARD_DEADLINE_MS` live in `lifecycle.ts` so `auto svc stop` waits for the same budget.
- **Post-shutdown safety sweep.** After the runner drains, `main.ts` calls `recoverInterruptedRuns(db, {phase: "shutdown", termGraceMs: 500})`. It finalizes any row still queued or running as `failed` with `skip_reason = supervisor_shutdown`, terminates any recorded worker pid that matches the worker path, and clears condition markers. This guarantees "no run left queued/running" even if the runner is late or wedged.
- **`svc stop` and `svc restart` wait semantics.** `auto svc stop` sends SIGTERM and polls until the pid is no longer a supervisor, up to `SHUTDOWN_GRACE_MS + 6 s` (16 s). On timeout it reports failure with a `kill -9` hint and does not SIGKILL by itself. `auto svc restart` returns without starting when the old supervisor is still running.
- **Test fixture: `hang-worker.ts` instead of `sleep-worker.ts` for shutdown tests.** The runner does not pass the supervisor's environment to workers, so `SLEEP_MS` never reached `sleep-worker.ts` and it exited by itself after 5 s. `test/fixtures/hang-worker.ts` ignores SIGTERM and runs until killed; the shutdown test waits for its ready line so SIGTERM cannot arrive before the handler exists, and asserts that stopping took at least 900 ms, so the SIGKILL escalation is really exercised.

**Consequences:** The shutdown budget is one number, shared by the supervisor and the CLI. `Runner.shutdown` (D-22) does the per-run work; this entry only orders and caps it. The default runner grace changed from 5 s to 10 s.

**Source:** pre-launch polish (foundations engineer).

### 18 — Interrupted-run recovery uses existing states and columns

**Context:** A supervisor that dies (crash, `kill -9`, power loss) leaves runs `queued`/`running` in the database and possibly live workers.

**Decision:**
- **Recovery reuses existing states and columns.** There is no "lost" state in the schema. On startup, after migrations and before the runner exists, interrupted rows become `state = failed`, `finished_at = now`, `skip_reason = supervisor_interrupted`, plus a note appended to the run log. A recorded pid is signalled only if it is alive, is not our own pid, and `ps -o command=` contains the row's worker path. A process-group leader gets the whole group signalled (SIGTERM, then SIGKILL after 3 s); otherwise only the pid. Without `ps` (win32 or failure) rows are only marked. Stored log paths that escape `data/` are ignored. Stale pending condition markers are discarded, or committed if the pending run had already succeeded, mirroring the evaluator. The startup line reports `recovered=N`.
- **`runs.skip_reason` doubles as the "why" for runs the supervisor ended itself** (no migration). Values: `spawn_error`, `finalize_error`, `supervisor_shutdown` (killed or cancelled rows), `supervisor_interrupted`, `cancelled` (queued cancel), `disabled`/`paused` (queued run dropped at promotion), plus the existing overlap/queue_full/disabled/paused/shutdown skips. `RunFinishedEvent` gets an optional `reason`. The `markFinished` UPDATE is guarded with `state IN ('queued','running')` so a late writer cannot clobber a row that recovery already finalized.

**Consequences:** History honestly shows interrupted runs as failed with a reason instead of leaving them "running" forever. The API did not initially expose `skip_reason` for non-skipped runs (follow-up for the API owner).

**Source:** pre-launch polish (foundations and runner engineers).

### 19 — Singleton lock: JSON, published atomically, identity-checked

**Context:** The lock was described as `flock`; the code used a bare pid file, so a reused pid could block a start and a half-written file could be misread. Amends D-09.

**Decision:** The lock is JSON `{pid, startedAt, entry}` written to a private temp file and published with `link()` (with an `O_EXCL` fallback), so a reader never sees a half-written lock. The holder is live only if the pid is alive AND its command line contains `supervisor/main.ts`, `.auto-runtime/supervisor.ts`, or the recorded entry; where `ps` is unavailable it falls back to `kill(0)`. Stale takeover is serialized by a `<lock>.takeover` guard file, and the stale file is renamed aside to a unique name before the exclusive create. A lock naming our own pid that we did not create counts as stale. `runningSupervisorPid()` and `auto svc` use the same check.

**Consequences:** Slightly stronger than the bare rename-then-`O_EXCL` recipe first considered. Older pid-only lock files are still read and identity-checked. Transient files `<lock>.takeover` and `<lock>.stale-*` may appear next to the lock. The claim "flock-based" in earlier documents is wrong; there is no `flock`.

**Source:** pre-launch polish (foundations engineer); amends [Q-09](questions/Q-09-supervisor-failure-handling.md).

### 20 — Startup failures exit non-zero; safety net; newer-database refusal; file modes

**Context:** D-09 exited 0 on startup failures and planned crash-loop counting. In practice a silent exit 0 hid failures from the watchdog, and the crash-loop plumbing was never wired.

**Decision:**
- **Safety net, fatal exit code and newer-DB refusal.** An `unhandledRejection` is logged with a timestamp and recorded in `last-error.txt`; the supervisor keeps running. An `uncaughtException` is logged, recorded, then a graceful teardown runs, then exit 70 (`EX.SOFTWARE`) so the watchdog restarts it. `busy_timeout` is 5000 ms. A database with applied migrations this build does not ship throws `SchemaTooNewError`; the supervisor refuses to start with exit 78 without writing to the DB and notifies once. `--check` reports the same condition.
- **Filesystem modes.** `DATA_DIR`, `state/` and every directory under it are made `0700` and files `0600` at startup via `hardenTree` (a looser existing `DATA_DIR` is tightened). `openDb` creates its directory `0700` and chmods the db, `-wal` and `-shm` files `0600`.
- **Startup failures exit non-zero and the watchdog tick fails loudly.** Startup failures return `EX.SOFTWARE` (70) or `EX.CONFIG` (78) instead of 0. The default export `scheduled()` (the watchdog tick) passes `{watchdog: true}`, so "already running" is silent, and throws on a non-zero start code so the host scheduler records the failure.
- **Dead crash-loop plumbing removed.** `isCrashLooping`, `readStartHistory`, `recordExit`, `start-history.json` and the never-entered degraded kinds `db_error`/`secrets_missing` were deleted rather than wired, because the watchdog already restarts the supervisor every minute and no behavior depended on them.

**Consequences:** Non-zero exits are visible in the scheduler's own log. `hardenTree` walks Auto's own entries at each start, which is O(files); retention (D-34) keeps that bounded (D-43: it no longer touches anything else). Scripts that relied on exit 0 after a migration failure must change.

**Source:** pre-launch polish (foundations engineer); amends [Q-09](questions/Q-09-supervisor-failure-handling.md).

### 21 — Supervisor log tee and desktop notifications

**Context:** A supervisor started by the watchdog has no terminal, and startup failures were easy to miss.

**Decision:**
- **`supervisor.log` tee in addition to the fd redirect.** `startSupervisorNow` points the child's stdout and stderr at `data/state/supervisor.log` (`0600`, rotated to `supervisor.log.1` at start when over 5 MB) and spawns it detached, so closing the terminal does not SIGHUP it. A supervisor started by the watchdog has no such redirect, so `main.ts` tees stdout/stderr into the same file with in-process rotation, unless `AUTO_LOG_REDIRECTED=1` says the launcher already redirected. `auto svc tail` therefore follows a complete log on every platform; `tail` is a small JS follower, not the `tail` binary.
- **Notifications.** `notifyOnce` is keyed by a hash of the error and persisted in `data/state/notified.json` (`0600`) with a 6 h window, so the message text is never stored. `notify()` tries `terminal-notifier`, then `osascript` on macOS with text passed as argv (never interpolated into the script), else a no-op; it never throws, has a 5 s timeout, and `AUTO_NOTIFY=0` disables it.
- **Fixed a bug in the tee restore during testing.** The tee originally restored a bound copy of `stream.write`, not the original function; caught by a test and fixed.

**Consequences:** One place (`supervisor.log`) holds supervisor output however it was started. Notifications are best-effort and macOS-centric.

**Source:** pre-launch polish (foundations engineer).

### 22 — Worker execution: process groups, bounded drain, admission, shutdown

**Context:** Timeouts and cancellation only signalled the direct child, output pipes held open by grandchildren could hang a run, and admission ignored database-level state.

**Decision:**
- **Workers run detached in their own session and process group; signals go to `-pid`.** `Bun.spawn({detached: true})` (verified on Bun 1.4.2, pgid == pid). All timeout, cancel and shutdown signals use `process.kill(-pid)`, falling back to `child.kill` on win32, missing pid or `ESRCH`, so a spawn wrapper that ignores `detached` is still signalled. The recorded `runs.pid` is the group leader, so crash recovery can kill the group. Workers no longer share the supervisor's process group or controlling terminal.
- **Post-exit pipe drain is bounded** (default 3 s, option `drainTimeoutMs`). After the deadline the readers are cancelled and the log gets a line saying later output was not captured. If the run was being terminated on purpose (timeout, cancel, shutdown) the leftover group is SIGKILLed first. A normal exit does not kill background children the worker left behind; the runner only stops waiting for their output.
- **Shutdown: a run finishing on SIGTERM during shutdown is recorded as `killed`, even with exit code 0.** Consistent with the cancel precedent. A run already timed out stays `timed_out`. Anything unsettled after `graceMs + 1500 ms` is force-finalized (SIGKILL, readers cancelled, row `killed`/`supervisor_shutdown`), so `shutdown()` always resolves within `graceMs + 2000 ms`. Exported constants: `DEFAULT_SHUTDOWN_GRACE_MS = 10000`, `SHUTDOWN_SETTLE_SLACK_MS = 2000`, `SHUTDOWN_HARD_DEADLINE_SLACK_MS = 5000`, `shutdownHardDeadlineMs()`.
- **Queue promotion only when nothing else is running, and it re-checks admission.** A queued run whose job was disabled or paused while it waited is cancelled (`skip_reason` `disabled`/`paused`) instead of started. Previously promotion fired on every exit, even with a manual `--force` run still active. Admission also enforces the database-level enabled and paused flags.
- **`enqueue` during or after shutdown records `skipped(shutdown)`.** A skipped row is inserted so callers (the webhook adapter stores `run_id` with a foreign key) always get a valid `run_id`. If the DB is already closed it throws "supervisor is shutting down".
- **Shared helper module `supervisor/child-process.ts`.** The runner and the condition evaluator both need process-group spawning and signalling and the env allowlist (with the win32 additions `SystemRoot`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `PATHEXT`, `COMSPEC`). The condition checker environment also gained `SHELL`, which it previously omitted.

**Consequences:** A timeout or cancel stops a worker's whole process tree. Windows has no process groups and different signal semantics; the fallback exists but was not run there. `EnqueueResult.skipped.reason` widened to `overlap | queue_full | disabled | paused | shutdown`.

**Source:** pre-launch polish (runner engineer).

### 23 — Run-log redaction and capture

**Context:** Redaction worked on decoded strings per chunk, so a secret split across two writes leaked, and a full disk could stall the child.

**Decision:** **Log redaction refinements.** Redaction works on bytes, in a single left-to-right pass (earliest match, longest wins at a position). Carry-over holds only the longest suffix that is a proper prefix of some secret (at most `maxLen - 1` bytes), not a fixed tail, so ordinary lines are not delayed. A match is only committed if no longer secret could still complete at that position. Carry-over is per stream and flushed and redacted at `close()`. Redaction runs before the size cap; after the cap is hit, remaining bytes are counted, not scanned. The 4-character minimum (counted in characters) is unchanged and documented in a comment. `LogCapture` disk-write errors no longer reject: output is dropped and `error()` reports the first one, so the reader keeps draining and the child never blocks on a full pipe. Run-log directories are `0700`, files `0600`.

**Consequences:** Split-across-write secrets are now caught. Substrings and encoded forms still are not.

**Source:** pre-launch polish (runner engineer).

### 24 — Own cron implementation, DST rules, and missed-fire skipping

**Context:** `Bun.cron.parse` documents UTC in Bun 1.3 and returns local time in 1.4.2, and `package.json` allows both. D-15 had adopted the in-process Bun cron API.

**Decision:**
- **Own cron implementation instead of `Bun.cron.parse` / in-process `Bun.cron`.** A local-time parser and a chunked timer loop in `supervisor/adapters/cron.ts` make semantics independent of the Bun version. Semantics (documented in the file header): machine local time; day-of-month OR day-of-week when both are restricted (a field starting with `*` counts as unrestricted); names, lists, ranges, steps and `@` macros accepted; `@reboot` and other `@` forms rejected.
- **DST rule.** A wall time in the spring-forward gap fires once, shifted by the gap. A repeated wall time fires once at its first occurrence, except that schedules with a wildcard hour field also fire in the repeated hour. This matches Bun's own result for gap times, keeps "every hour" and `*/15` rhythmic, and never double-fires fixed daily times.
- **Missed fires are skipped, with a one-minute tolerance and a 30 s wall-clock re-check.** The timer loop never waits longer than 30 s, so the wall clock is compared often and no delay approaches `setTimeout`'s 2^31-1 ms limit (a yearly schedule would otherwise fire after 1 ms). On a tick, a fire more than 60 s late is dropped and an additive `missed` event is emitted (`main.ts` logs it). At most one late fire (within 60 s) runs. The next fire is computed strictly after `max(now, due)`, so there is no double fire and no catch-up burst. `fire_at` passed to the runner is the scheduled minute rather than `Date.now()`.

**Consequences:** Behavior was compared against `Bun.cron.parse` on 45 expressions at four start instants in four time zones with no mismatches. Windows and a real sleep/wake were not verified (sleep is simulated with a fake clock). The OS watchdog still uses `Bun.cron` (D-15).

**Source:** pre-launch polish (runner engineer); amends [Q-15](questions/Q-15-portable-install-and-config-sync.md).

### 25 — Condition evaluator: in-flight guard and process-group checkers

**Context:** A checker slower than the schedule period (default timeout 30 s versus a `* * * * *` schedule) let overlapping evaluations both fire before either recorded `pending_run_id`.

**Decision:** A second evaluation of the same trigger during an in-flight one returns `{kind: "suppressed", pending_run_id: null}` (a small additive type change: `pending_run_id` is `string | null`). Checkers are spawned in their own process group and the whole group is stopped (SIGTERM then SIGKILL, `killGraceMs` default 1000) on timeout, oversized output or any early exit. Pending markers are validated against `runs.state` and against `runner.active()` at evaluation time, so a DB row the runner does not hold is treated as dead.

**Consequences:** Consistent with D-13's single-flight rule; the in-flight guard closes the window between evaluation and recording.

**Source:** pre-launch polish (runner engineer).

### 26 — Host and Origin policy, token rotation (browser sessions tried and rejected)

**Context:** The token was embedded in the served HTML (D-07, D-08) and `/events?token=` put it in URLs. The first pre-launch answer was a deterministic HMAC session cookie; the owner rejected it for ergonomics and it was removed (D-41, [Q-17](questions/Q-17-cookie-session-instead-of-embedded-token.md)). What remains of this decision is the access policy around the token.

**Decision:**
- **Host policy.** `Host` is required and exactly matched (case-insensitive) on every route except `/hooks/*` and `/healthz`, so a DNS-rebinding page or a request without a `Host` header gets 403 `bad_host`. Allowed hosts: `127.0.0.1:PORT`, `localhost:PORT`, `auto.localhost:PORT` (`[::1]` was dropped in D-43: the server listens on IPv4 only), plus exact entries from `AUTO_ALLOWED_HOSTS` (default empty). The policy is rebuilt after Bun binds, so port 0 works. `automations.localhost` is no longer in the code. `auto.localhost` is a built-in because browsers resolve `*.localhost` to loopback themselves, so it cannot be rebound to another address. Anyone who set `AUTO_BASE_URL` to a custom hostname must also list it in `AUTO_ALLOWED_HOSTS`, and the server warns at start that every listed name is served the token.
- **Origin policy.** A present `Origin` must match an allowed origin (http for the built-in names, http and https for `AUTO_ALLOWED_HOSTS` entries), for every method and every route behind the Host check, including `/` and static files (403 `bad_origin`). An absent `Origin` is allowed (CLI, curl, plain navigation). No response carries CORS headers, and a foreign preflight gets 403.
- **Rotation responds without the new token and with a repo-relative path.** `POST /api/token/rotate` writes the new token atomically at `0600`, swaps it in memory, disconnects all SSE subscribers, and returns `{ok, message, token_file}`. The old bearer gets 401 at once and a reload of the page embeds the new token. It never returns the token or an absolute path.

**Consequences:** Rotation is the only revocation. Anyone who used `?token=` or `X-Auto-Token` must move to the `Authorization` header.

**Source:** [Q-17](questions/Q-17-cookie-session-instead-of-embedded-token.md); amends D-07 and D-08.

### 27 — HTTP hardening: idle timeout, CSP, minimal `/healthz`, static serving

**Context:** Review found timeouts that killed SSE, a token-bearing shell, a chatty `/healthz`, and a static handler open to symlink escapes.

**Decision:**
- **`idleTimeout` is 60 s instead of shortening the heartbeat.** Bun's default of 10 s kills SSE streams between the 15 s pings (verified: the heartbeat test failed with ECONNRESET at about 12 s with 10, passes with 60). 60 s leaves a 4x margin and keeps the client stall limit (3 x 15 s) meaningful.
- **CSP without `unsafe-inline`.** The built bundle has one external stylesheet, one module script and no inline styles or font/image URLs, so `style-src 'self'` suffices. The "UI not built" placeholder no longer uses inline styles. The JSON bootstrap tag is a data block, so `script-src` does not affect it. Other headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **`/healthz` is minimal and exempt from the Host check.** It returns only `{ok, degraded}` with 200 or 503, so the watchdog, `auto svc`, doctor and tunnel probes keep working. Uptime, job count and the reason text are gone. `startedAtMs` stays in `StartServerOptions` as an ignored field.
- **Static serving via realpath containment.** `static-files.ts` validates decoded path segments, so a legitimate `logo..v2.svg` is served while `..` segments are refused, and requires the resolved real path to stay inside the real root, blocking symlink escapes. Root-level `dist` files are served with a 1 h cache; `/assets` stays immutable. Misses on any path with a file extension return 404 JSON instead of the SPA shell. `/api` never falls back to the shell.
- **Errors.** API handler exceptions return `500 {"error":"internal_error"}` with no message; detail goes to stderr. `Bun.serve` runs with `development: false`, an `error()` handler, `maxRequestBodySize` = 10 MiB + 64 KiB, and the SSE server caps subscribers at 64 and drops readers whose queue passes 100 chunks.

**Consequences:** A separate `/healthz` Host exemption is the one unauthenticated probe surface. Tests found and fixed two real bugs: `new URL(req.url)` threw without a `Host` header (500 instead of a rejection), and `/api` fell through to the shell.

**Source:** pre-launch polish (auth/server engineer); amends D-07 and D-08.

### 28 — Event clients: fetch-streaming UI client, auth-aware CLI client, Vite proxy

**Context:** `EventSource` cannot expose an HTTP status or send headers, so a 401 looks like a network error and retries forever, and the token had to ride in a URL.

**Decision:**
- **UI events client uses fetch streaming rather than `EventSource`.** It stops on 401 and reports `unauthorized`, supports exponential backoff capped near 30 s with jitter, stall detection at 3 heartbeats, and a `reconnect()` method. Event names are unchanged.
- **CLI `SSEClient` keeps backward compatibility and is auth-aware.** It still accepts a URL containing `?token=` (older callers), moves the token into the `Authorization` header and strips it from the URL. New optional `token` (string or function) and `heartbeatMs` options exist. `start()` returns a boolean, waits for the first attempt to settle (5 s cap), fires `onOpen` on every (re)connect and resets backoff. A 401/403 stops the client when the token is a fixed string; with a token function it retries, so a rotated token is picked up.
- **Vite dev server: proxy plus token plugin.** The proxy carries `/api`, `/events` and `/healthz`; `changeOrigin: true` rewrites `Host`, and the `Origin` header is rewritten to the supervisor origin so the dev port never enters the production allowlist. The dev page embeds `{token, port}` through `ui/vite-plugin-auto-token.ts`, which re-reads the workspace token file (`AUTO_DATA_DIR`, else `AUTO_HOME/data/.token`, else `~/.auto/data/.token`) on every page load, so a restart or rotation needs only a reload. `server.cors` is `false`: Vite's default answers any localhost origin with `Access-Control-Allow-Origin`, which would let another local web page read the token from `127.0.0.1:5173`. Vite's default host check already refuses a foreign `Host`. The dev page hands the token to anything that can reach the Vite port, so keep Vite on localhost. Source maps are off.

**Consequences:** Two clients to keep in step (D-36 removes the last `?token=` URL callers). The client was exercised by hand in a browser but has no automated UI tests.

**Source:** pre-launch polish (auth/server engineer).

### 29 — Secret store reloads on change and never drops redaction

**Context:** The store cached secrets at start, so a secret added by the CLI was not redacted until a restart, and a half-written file could clear the list.

**Decision:** `load()` caches by inode, size and mtime, so calling it per webhook is a `stat`. `get()` and `redactionValues()` re-check the file on each call. A half-written or mode-loosened file keeps the last good values, so redaction is never dropped. Parsing retries up to 4 times at 15 ms intervals to tolerate a concurrent writer. `redactionValues()` never throws. `load()` still throws on a bad mode or malformed file, because the webhook adapter relies on that to degrade.

**Consequences:** No restart is needed after `auto secret set`. In-flight workers are unaffected.

**Source:** pre-launch polish (auth/server engineer).

### 30 — Webhook ingress: receipt after admission, digest dedupe, uniform failures

**Context:** D-14 wrote the receipt before admission, so a sender's retry after a non-admission (overlap, queue full, disabled) was swallowed as a duplicate. Replays with a new delivery id also bypassed dedupe. Amends D-14.

**Decision:**
- **Receipt is written only after a run exists.** Started or queued writes the receipt. Runner absent, an enqueue exception or a payload write failure returns 503 with `Retry-After`. Disabled or paused returns 503 with `Retry-After`. Overlap or a full queue returns `202 {status: "skipped", reason}`. In every non-admitted case the payload file is removed. A per-key in-flight set keeps identical concurrent deliveries from both being admitted before the receipt exists.
- **Dedupe key semantics and the 5-minute window.** A delivery is a duplicate if its delivery id matches (when configured) or its body digest matches within 5 minutes. When an identical body arrives after the window, the old receipt keeps its history under a retired key (`<key>@<receipt_id>`) and the new run gets a fresh receipt, which works around `UNIQUE(trigger_id, dedupe_key)` without a migration. Legacy receipts with disposition `accepted` or `skipped` from the old build are deleted when the same key is retried. Replays after the window need a signed timestamp and are documented as unpreventable. Cost: a sender that legitimately posts the same body twice inside 5 minutes with different delivery ids has the second dropped.
- **401 for any bad or missing signature; bare 503 only after a well-formed signature.** Shape checks on the signature header come first and never touch the secret store. A caller with a well-formed signature for a trigger with a missing secret or a corrupt store gets the bare 503 (empty body); the `reason` text is gone. The residual signal (503 versus 401) is accepted.
- **Payload cleanup is path-based.** The in-memory map was removed. A finished or skipped run's payload path is derived from the run's `trigger_meta.receipt_id` (validated as a UUID, always under `payloads/ephemeral`). A rate-limited sweep removes stale unreferenced payloads, skipping files under 5 minutes old and those of active runs. Ephemeral payloads live in `payloads/ephemeral/`; kept payloads stay in `payloads/`.
- **Body reader `readBodyCapped` in `router.ts`.** Used by the webhook adapter and cancel, and adoptable by other POST handlers. It streams, aborts the moment the cap is exceeded, and treats a malformed `Content-Length`, `Content-Length` with `Transfer-Encoding`, or a length that disagrees with the bytes received as `bad_length` (400). Webhook oversize is 413 with `Connection: close`.

**Consequences:** Retries after non-admission work. The digest window trades a rare false duplicate for replay resistance inside 5 minutes.

**Source:** pre-launch polish (webhook/API engineer); amends [Q-14](questions/Q-14-webhook-trigger-contract.md).

### 31 — Runs API: stable paging, run references, log offsets

**Context:** Short run ids collided, `LIKE` matching allowed wildcards, paging on `enqueued_at` alone skipped or repeated rows, and log reads had no offset.

**Decision:**
- **The runs list stays a bare array; the cursor travels in headers.** Wrapping the array would break the CLI and UI, so `X-Next-Before` and `X-Next-Before-Id` are present only when another page exists, and clients send them back as `?before=&before_id=`. Ordering is `enqueued_at DESC, run_id DESC` with the tuple as the cursor.
- **Run refs are hyphen-insensitive.** Stored ids are hyphenated, but users copy the 8-hex short id or an unhyphenated string. Input is stripped of hyphens, rebuilt into the canonical 8-4-4-4-12 form, and queried by range on the primary-key index, so a prefix longer than 8 digits works. Suffix matching (the short display id, the last 8 hex digits) uses `substr(replace(...))`, a scan bounded by retention. `LIKE` is never used; `%` or `_` gives 400.
- **Log endpoint: 416 for offsets past the end.** `offset == size` returns an empty 200 so a follower can poll; `offset > size` returns 416 `offset_out_of_range` with the size, so a follower notices a truncated or rotated log. The response slice is pinned to the size read once, so the body and `X-Log-Size` agree. Log paths are contained by `realpath` under the data directory.

**Consequences:** All additive. The suffix scan may need a generated column and index if retention grows large (would be a migration).

**Source:** pre-launch polish (webhook/API engineer).

### 32 — Config loads in a subprocess with one shared validation

**Context:** Bun 1.4.2 returns the stale module for a `?ts=` cache-buster on `file://` URLs (reproduced), so hot reload silently ignored edits. Details and options in [Q-18](questions/Q-18-config-loading-in-a-subprocess.md).

**Decision:**
- **Config loads in a subprocess.** `supervisor/config-loader.ts` runs with `process.execPath`, cwd = the workspace root, the supervisor's env plus `AUTO_HOME`/`AUTO_CONFIG`, stdin ignored, a 10 s SIGKILL timeout, stdout capped at 8 MiB and stderr at 16 KiB. It prints the default export after a marker on a single line, so anything the config prints does not corrupt the result. Functions, symbols, bigints, non-finite numbers and cycles are rejected with a named error. `--no-install` is deliberately not passed so behavior matches the old in-process import. `loadConfigOnce`, `validateConfigFile` and `ConfigSchema` keep their exports and gain optional options; failures are `ConfigValidationError` or its subclass `ConfigLoadError`.
- **Validation moved into config loading.** `ConfigSchema` validates cron via `validateCronExpression`, job names (1-64 characters: Unicode letters/digits, space, `.`, `_`, `-`; no `:`, `/`, control characters, leading or trailing space, or all-dots names, because `.` and `..` collapse in URLs), `timeoutMs`/`killGraceMs` up to 2147483647 and `queueDepth` up to 1000. `loadConfigOnce` also checks that every worker and `condition.checker` exists and is a file. Errors read `job "x", trigger "t", schedule: ...`; missing files use the heading `workspace files missing:`. `--check` has no separate loops. `Registry.reconcile` keeps its cron pre-check as defence. Unicode letters are allowed in names (a departure from an ASCII-only reading).
- **Commit after reconcile.** `ConfigStore` takes an applier. `current`, `lastLoadedAt` and `lastError` change only after the applier returns; on a throw the store keeps last-known-good, sets `lastError` and emits `error`. It emits `loaded` for the first success and `reloaded` after that, never `reloaded` on failure. `main.ts` builds the runtime once in `buildRuntime()` and only publishes it once every part exists; a failed hot-reload apply best-effort re-reconciles the previous config. `config.reloaded`/`config.error` SSE events come only from store events, so an API-triggered reload announces once (it used to announce twice).
- **Reloads are serialized and coalesced.** `store.reload()` is the single entry for the watcher, the poll and `POST /api/config/reload`. Callers that arrive while a reload is queued share it; an edit made during a running reload triggers exactly one more.
- **Watcher watches the parent directory plus a poll backstop.** `fs.watch` on the parent directory, filtered by file name, survives rename-over saves and a missing file. A 5 s poll compares an (inode, size, mtime) signature, re-opens a dead watcher and covers a missing parent directory at start. The signature is recorded when a reload starts, so a bad file is not re-parsed every tick. The poll timer is unref'd and cleared on `stop()`.

**Consequences:** The config file is executed as code on every reload (documented). Each reload costs a process spawn (about 50-100 ms, not benchmarked). A config that imports npm packages was not exercised. Checks for worker and checker files apply to `enabled: false` jobs too.

**Source:** [Q-18](questions/Q-18-config-loading-in-a-subprocess.md).

### 33 — Scheduling state on the registry; API contracts for jobs, pause and status

**Context:** `server.ts` builds the API context without a webhook adapter, so job and trigger changes reconciled cron only, and a pause never ended by itself.

**Decision:**
- **Scheduling state lives on the registry.** `JobRegistry` gained `onStateChange`/`notifyStateChanged`; `main.ts` subscribes one function that reconciles cron and webhook, and the API calls `notifyStateChanged()` after every write via `applyScheduling()`. If nobody subscribes (tests), the handlers reconcile the cron adapter, and the webhook adapter when the context has one. The registry also owns the pause timer: earliest `paused_until`, clamped to 2^31-1 ms, unref'd, re-armed after every reconcile and notify, cleared by `close()`.
- **Disabled and paused jobs keep their webhook route.** `activeJobsFor*` skip `enabled: false` jobs for cron, but the webhook adapter is reconciled from `registry.webhookJobs()`, which lists every job that declares a webhook trigger. A disabled (config or DB), paused or trigger-disabled job therefore answers `/hooks/<path>` with 503 and `Retry-After` (the runner refuses admission; the adapter checks `webhookTriggerEnabled` for a disabled trigger), so a sender that retries on 5xx redelivers once the job is enabled. Toggles apply on the next request without a config reload.
- **Job identity stays the NAME; rename caveat.** `id` is a validated, unique, config-level label shown by the API. The database keys jobs by name and triggers by `<name>:<trigger id>`. Renaming a job archives the old row and creates a new one with fresh history and state. Because `:` and `/` are rejected in names, the trigger-id split on the first `:` is unambiguous.
- **Error codes unified on `not_found`.** Every CLI and UI consumer checks only the HTTP status, so unknown-job responses from run, enable, disable, pause, unpause and trigger enable/disable return 404 `not_found` (with `jobName` or `triggerId`). The old `unknown_job` code is gone from the API. Pause and run bodies are validated with zod through `parseJsonBody`: 64 KiB streamed cap (413), `invalid_json`, and `invalid_body` with `details`.
- **Pause request rules.** `duration_ms` is 1000..31536000000. `until_iso` must parse, be in the future and within one year, else `invalid_until_iso`. Sending both fields is `invalid_body` (it used to silently prefer `duration_ms`). Neither gives `missing_duration_or_until`.
- **`next_run_at` semantics.** Computed per request with `nextCronFire`, and null unless the trigger, the DB flag, the config flag and the pause state all allow scheduling and a cron adapter exists. It does not read the adapter's own `next`, so it is deterministic and testable.
- **Extra additive fields beyond the brief.** Jobs get `config_enabled` (the config flag; `enabled` stays the DB flag). `recent_runs` also carry `job_id`, `log_path` and `definition_hash`. The reload response adds `warnings`, `changes {added, removed, changed}` and, on failure, `stage`.

**Consequences:** A single path puts every state change into effect. The 404-versus-503 webhook behavior is an open product question (above). Wording in code no longer calls `id` a stable identity.

**Source:** pre-launch polish (config engineer).

### 34 — Retention: 90 days, per-job floor, on by default

**Context:** Nothing pruned run history, logs or webhook receipts, so `data/` grew without bound. Details and options in [Q-19](questions/Q-19-retention-defaults.md).

**Decision:**
- **The per-job floor counts real runs only, not skipped rows.** The newest N terminal runs per job are kept; skipped rows would otherwise fill the floor of a cron job that drops most fires. Skipped rows have no floor and expire at `min(days, 14)`. The floor is the run at rank N by `(enqueued_at, run_id)` descending, and only strictly older runs may go, so ties are handled exactly.
- **Age is measured from `enqueued_at`, and the terminal check is `state NOT IN ('queued','running')`.** Cutoffs are strict: a run exactly at the cutoff stays.
- **Receipt horizon is `max(days, 7)` days, never inside the 5-minute dedupe window, and receipts of active runs are kept.** `DEDUPE_WINDOW_MS` is imported from the webhook adapter so there is one source of truth. A kept payload file is deleted with its receipt.
- **Retention is off entirely when `AUTO_RETENTION_DAYS=0`.** No timer, and one startup line `[retention] disabled ...: nothing removed`; `pruneOnce` returns `enabled: false` and touches nothing, including orphans and empty directories.
- **Bad env values fall back to the defaults with a stderr warning.** Both must be integers: days 0 to 36500, min runs 0 to 100000; otherwise 90 or 25. There is no fractional-day mode, so a typo cannot become sub-day retention.
- **Teardown stop runs in parallel with the other capped steps.** `retention.stop()` sits in the existing `Promise.all` (capped at 2 s), adding nothing to the shutdown budget and completing before the DB closes.
- **Batching: keyset cursor, small batches, yield between batches.** 200 rows at a time in `(enqueued_at, run_id)` order with a cursor, so the loop terminates even in dry-run mode or when some rows cannot be deleted. It yields with `setTimeout(0)` between batches, and `shouldStop` is polled so shutdown does not wait for a long sweep. First sweep 60 s after start, then every 6 h.
- **Sweeps never overlap and never throw.** Each phase (receipts, runs, orphan logs, orphan payloads, empty directories) is wrapped separately; errors are logged to stderr, counted, and the sweep continues. A real sweep requested while another runs joins it; a dry run runs on its own. A closed DB yields errors, not an exception.

**Consequences:** History is pruned permanently (no trash); `AUTO_RETENTION_DAYS` and `AUTO_RETENTION_MIN_RUNS` are baked into the watchdog entry and shim when set at install time. A pruned run returns 404 from the API.

**Source:** [Q-19](questions/Q-19-retention-defaults.md).

### 35 — Retention safety: indexes, foreign keys, confined file deletion

**Context:** Deleting runs touches child tables, files and directories that other components may still be writing.

**Decision:**
- **Additive migration `0003_retention_indexes.sql`.** Three indexes: `runs(job_id, enqueued_at, run_id)` for the floor and oldest-first scans, and partial indexes on `webhook_deliveries(run_id)` and `condition_states(pending_run_id)` (non-null only). Without the child indexes each deleted run scans the whole `webhook_deliveries` table. `EXPLAIN QUERY PLAN` confirms they are used. Nothing existing is altered or dropped; a test proves an upgrade from a DB with only migrations 0001 and 0002.
- **Foreign keys: receipts are unlinked, not cascaded; pending condition runs are protected.** Before a run is deleted, `UPDATE webhook_deliveries SET run_id = NULL WHERE run_id = ?` runs in the same transaction, so a receipt keeps its history but stops naming the run. A run a condition trigger still lists as its pending run is never deleted.
- **Log file is deleted before its row; a failed unlink keeps the row.** Per batch, files are removed first, then rows in one transaction. If an unlink fails (for example `EACCES`) the row stays and counts as an error. A batch-wide failure leaves rows whose logs are gone; the next sweep sees the missing file as already removed and deletes the rows.
- **File deletion is confined and does not follow symlinks.** A `log_path` or `payload_path` that resolves outside `runs/` or `payloads/` (by `..`, an absolute path, a symlinked file or a symlinked parent directory) is never touched, although the row itself is still removed. Only regular files are unlinked.
- **Empty date directories are removed only when their whole date range is at least two local days old.** The runner creates a date directory from a run's start date and then opens the log; removing one it just made would fail that run. `runs/` itself is never removed; only `YYYY/MM/DD` names are walked.
- **Orphan files are removed only past the retention horizon, and only files with recognisable names.** A run-log orphan is `<hex-uuid>.log` under `runs/YYYY/MM/DD` with no runs row and mtime older than the horizon. A payload orphan is `<receipt>.payload` in `payloads/` or `payloads/ephemeral/` with no receipt row and no queued or running run naming it.

**Consequences:** Retention cannot damage a run the runner is starting, a receipt the dedupe window still needs, or files outside the data directory.

**Source:** pre-launch polish (retention engineer).

### 36 — CLI contract: ids, flags, exit codes, output, follow

**Context:** Short ids collided, `--force` was global and silently confirmed prompts, output was truncated when piped, and Ctrl-C on `auto run` looked like success.

**Decision:**
- **Short run id is the last 8 hex digits.** Every command that prints an id uses it. The CLI sends the id as typed and the API resolves exact id, unique prefix or unique suffix (D-31). 400, 404 and 409 get plain messages; ambiguous lists the full candidate ids.
- **`--force` is `auto run` only; `-y` is the only confirmation flag.** The global `-f/--force` is removed. The one prompt in `auto run` (start another run anyway after a 409) counts as a confirmation, so `-y` answers it. Other commands reject `--force` as an unknown option (exit 2). A latent bug was fixed: commander stores `--no-color` as `color: false`, so the old `opts.noColor` was always false.
- **Exit override throws, `main()` returns the code.** commander's `exitOverride` throws to `main()`, which maps help and version to 0, a group typed without its subcommand to 2, and every other commander error to 2. Actions set the exit code and return; only the entry point calls `process.exit` after flushing. `main()` is callable in-process for tests. A bare `auto` prints help and exits 0.
- **Removed the `require()` cycle.** `client.ts` imports `DATA_DIR` from `paths.ts` and `runtime.ts` imports `ApiClient` statically. `requireSupervisor` throws `SupervisorUnreachable` (exit 3) instead of calling `process.exit`.
- **Output flush.** Found by hand: `auto log <id> | wc -l` returned 1861 of 20000 lines because Bun's pipe writes are asynchronous. All CLI output goes through `writeOut`, `writeErr`, `println`, `printJson` and `status` in `runtime.ts`, which track write callbacks; `main.ts` awaits `flushOutput()` (capped at 5 s) before exit. A regression test pipes a 2.8 MB log.
- **`auto jobs` moved to `commands/jobs.ts`.** Columns NAME, STATE, TRIGGERS, LAST RUN, NEXT RUN. State comes from `enabled`, `config_enabled`, `paused_until` and `active_run`; a running or queued job that is also disabled or paused reads like `running (disabled)`. `auto job` shows per-trigger schedule and next run, the checker with its timeout, and for webhooks the POST path, `secretRef` with set or NOT SET, and the header names. Timeouts use an exact formatter (90 minutes reads 1h30m).
- **Follow polls the log endpoint; SSE is only a wake-up.** One shared follower (`cli/follow.ts`) serves `auto run` and `auto log --follow`. It reads `/api/runs/:id/log?offset=N` in bytes and the `X-Run-State` header says when the run is over. A multi-byte character split across reads decodes correctly. After every SSE (re)open, and on a `run.finished` or `run.skipped` event for the run, it re-fetches the run at once, so a finish that happened before the stream was live is caught by the next poll. It stops with `unreachable` (exit 3) after 8 s of no answer; a missing token file during a supervisor restart is treated as transient. The SSE client authenticates by header with a re-read token; nothing is put in a URL.
- **Exit codes for `run` and `log --follow`.** 0 only when the run succeeded; 1 for failed, timed out, killed, cancelled, skipped or lost; 3 unreachable; 4 conflict, with a `--force` hint; 130 for Ctrl-C (the run keeps going). A 503 (degraded) on start is now 1, not 3. `auto cancel` asks first only when the target is running; queued targets need no prompt, and with nobody to ask and no `-y` it refuses (exit 1). Cancelling a finished run stays 0.
- **The supervisor's unauthenticated `/healthz` is the reachability probe.** `reachable()` and doctor rely on it answering 200 or 503 without auth; if that route ever requires auth, every command would report "unreachable".

**Consequences:** Scripts that used a global `--force` or relied on exit 0 after Ctrl-C must change. `auto run` on a `queue`-policy job that is already running answers 409 (exit 4) instead of queueing; the owner should confirm that is the intended manual-run semantics (D-04 says manual triggers return a conflict).

**Source:** pre-launch polish (CLI engineer); amends [Q-11](questions/Q-11-cli-surface.md).

### 37 — CLI: create/init, secrets, token rotation, data wipe, doctor

**Context:** These commands wrote files or gave advice and could corrupt the workspace or mislead.

**Decision:**
- **`create --add` validates a candidate file and renames it, instead of writing then rolling back.** The candidate config is written next to the real one (`.auto.config.candidate-<pid>.ts`, so relative imports resolve the same), validated with the supervisor's own `validateConfigFile`, and only then renamed over the config with its mode kept. A failed check leaves the real file byte-for-byte unchanged, and the running supervisor's watcher never sees a bad version. A worker created by this run is deleted on failure. `--add` refuses a name already in the config. A config that is not the standard `export default [ ... ];` shape gets the snippet and the reason on stderr and is left untouched (exit 0); a failed validation exits 1.
- **`init` is idempotent and appends to an existing `.gitignore`.** It creates only the missing pieces (workspace, `jobs`, `data/state` `0700`, the commented starter config, the starter worker only together with a newly created config, `.gitignore`). An existing config and worker are never touched. An existing `.gitignore` gains only the missing `data/` and `.auto-runtime/` lines. It refuses Bun older than 1.3.0 and prints the next steps.
- **Secrets rewrite.** Every set and remove runs under an exclusive lock file (`O_EXCL`, waits up to 10 s, takes over a lock left by a dead pid or older than 30 s). The new file is written to a private temp file with fsync, renamed into place, and the directory is fsynced. A damaged or unexpected secrets file is reported and never overwritten. A file readable by others is tightened when rewritten and only warned about by `list`. `set --stdin` reads stdin even on a terminal. Values shorter than 4 characters get a warning because they are not redacted. `list` prints names only.
- **`auto token rotate` under Service.** Calls `POST /api/token/rotate`, prints that open dashboards must be reloaded, that the CLI reads the new token itself, and that scripts holding the old token must re-read the file. It never prints the token.
- **`data wipe` uses a summary instead of the cwd check.** It prints the path, run count (read-only DB query), file count and size on disk, and what else goes. It needs the typed word `wipe`; `--yes` skips; non-interactive use without `--yes` refuses. It refuses while the supervisor answers `/healthz` or the lock shows a live one. Extra guards: it refuses if `AUTO_DATA_DIR` is a filesystem root, the home directory, the workspace or one of their parents, and `--json` without `--yes` is a usage error.
- **Doctor.** Ten checks: Bun version, Workspace, Watchdog registered (per-OS detection kept), Watchdog entry (`verifyServiceEntry`), Supervisor reachable, Token file with mode, Config valid (API when a supervisor is up, otherwise the offline check), Database integrity (read-only), `auto` on PATH (INFO), Disk usage (INFO, WARN above 1 GB). Each WARN or FAIL prints one `fix:` line, `--json` has an additive `remedy` field and a top-level `ok`, and exit is 1 on any FAIL. The OS watchdog check only reads and never registers.

**Consequences:** The workspace cannot be left with a broken config by `create --add`, and concurrent secret writers cannot lose updates. The doctor's OK path (no FAIL, exit 0) was not exercised end to end.

**Source:** pre-launch polish (CLI engineer).

### 38 — Dashboard: bearer fetch, semantic tokens, bounded log view, inline confirmation

**Context:** The UI relied on the embedded token, polled poorly, re-rendered whole logs, and had no dark mode, phone layout or error states.

**Decision:**
- **Every fetch sends the bootstrap token as a bearer, with `credentials: "omit"`.** A failed fetch becomes `ApiError(0)`, so every caller handles one error type; a 401 means the token changed and shows one "reload this page" message everywhere (connection bar, error panel, toasts). The API error type lives in `util/errors.ts` (re-exported by `client.ts`) so the mapping is testable. Log download is a fetch plus blob (`api.downloadRunLog`) because a plain link cannot send the header. (Amended by D-41: this entry first described a cookie-only flow.)
- **Semantic color tokens instead of `dark:` variants.** `styles.css` defines CSS variables once for light and once for dark (`prefers-color-scheme`) and maps them with `@theme inline` to utilities. `test/ui-contrast.test.ts` reads the tokens and asserts at least 4.5:1 for all pairs in both schemes, including the 16 ANSI colors on the log background. The log viewer stays dark in both schemes.
- **Log follower is a pure class (`util/logFollower.ts`).** Polling, offset, tail and error logic is free of React so it can be unit tested with a fake endpoint. Large logs start from a HEAD request: over 1 MiB the view opens at the last 256 KiB (on a whole line); "Load full log" is offered up to 8 MiB and download beyond that. While following, memory is capped at about 1M characters.
- **Bounded log view and no `dangerouslySetInnerHTML`.** ANSI is parsed to segments rendered as React text nodes and CSS classes. Only the 16 basic colors, bold, dim, italic and underline are shown; 256-color and true color are consumed and ignored; other escapes and control characters are dropped; `\r` redraws keep the last visible part of the line.
- **Queued and skipped runs never request a log.** The follower shows a calm "no log" notice without asking the server (which would answer 404 and fill the console). When the run starts, polling begins.
- **Run now sends `force:false`, and "Run anyway" is a confirmed second step.** 409 conflict and 422 skipped show inline with a link to the run; the button is disabled in flight with a ref guard against a same-tick double click. A supervisor shutdown cannot be forced.
- **Event invalidation by prefix, in a pure module.** Events carry `job_id` and `run_id` only, so `run.*` and `config.*` invalidate `['jobs']`, `['job']`, `['runs']` (and `['run']` for run events); health events refresh config status. The mapping lives in `api/invalidate.ts` and is tested. On an SSE reconnect everything is invalidated. The run record refetches every 2 s while not terminal; jobs poll every 60 s while SSE is open and every 10 s while it is down.
- **Runs page uses an infinite query with the composite cursor.** `X-Next-Before` and `X-Next-Before-Id` become `before`/`before_id`. `keepPreviousData` avoids a loading flash; the text filter keeps its own state and pushes to the URL after 250 ms. It filters only loaded rows and says so.
- **Jobs and runs render as cards below 640 px.** A card layout under `sm` and a table above it duplicates a little markup but keeps every field visible. The Reentrancy and Timeout columns left the Jobs list (still on the job page).
- **Confirmation is inline, not `window.confirm`.** `ConfirmButton` swaps into a small question group with focus on the safe choice, Escape to cancel, and an `aria-label` for ambiguous names. It does not close on blur because Safari does not focus buttons on click. Confirmation covers Cancel run, Disable job, Disable trigger and Run anyway.
- **Toasts are library-free with two live regions.** Success and info go to a polite `role=status` region, errors to a `role=alert` region. Optimistic updates were not implemented.
- **Time: `hourCycle: h23`, zone stated once, shared clock.** `formatTime` no longer prints 24:xx. The zone abbreviation is in the footer and tooltips. `useNow` shares one timer per interval and refreshes when the tab becomes visible. `formatTimeoutMs` prints every unit. `shortId` is the last 8 hex digits; `shortHash` the first 8 characters.
- **Types moved to a DOM-free file.** `ui/src/api/types.ts` holds the API shapes so the root test run can import util files without DOM types.
- **Small departures worth noting.** A Status panel was added to the header, the header title is "Auto" and the browser title "<route> · Auto". `ui/package.json` was left unchanged (its `preview` script still exists although the UI README says not to use it).

**Consequences:** The UI has no automated component tests (only pure helpers and the log follower); the rest was checked in a browser. Firefox, Safari and real screen-reader use were not verified.

**Source:** pre-launch polish (UI engineer).

### 39 — Packaging and CI: the whole suite is the package check; macOS CI

**Context:** `test:package` was a hand-maintained list of test files that silently drifted from the suite, and nothing ran the checks automatically.

**Decision:** `test:package` is just `bun test`, so `verify:package` and `prepack` exercise the full suite. `CHANGELOG.md` ships in the package. A GitHub Actions workflow on `macos-latest` (the verified platform) installs both packages with frozen lockfiles, typechecks root and UI, runs `bun test`, builds the UI, and runs `bun pm pack --dry-run`. The tarball was checked to contain no source maps, tests or design files. No `repository`, `homepage`, `bugs` or `author` values were invented, and the version was not bumped.

**Consequences:** `bun pm pack` runs the full test suite through `prepack`, which is slow but honest. The suite uses fixed local ports, so CI runs it once, not in parallel. Repository metadata is left for the owner.

**Source:** pre-launch polish (docs engineer).

### 40 — Documentation states the shipped worker model and platform status

**Context:** Documents claimed that workers could be "executable scripts", that macOS was the only supported OS, and that a design-time list of behaviors was current.

**Decision:** The README and AGENTS describe the runner as always executing `bun <worker>` (no shebang or executable-bit handling), the child environment as an allowlist, workers as receiving no stored secrets, and the platform status as "macOS verified; Linux and Windows implemented through Bun's scheduler but untested". Hard-coded test counts and phase/wave references are removed from living documents; the design history keeps its original wording.

**Consequences:** The docs are the contract for the next reviewer; any behavior change must update them in the same change.

**Source:** pre-launch polish (docs engineer).

### 41 — Browser auth: token in the served page, no cookie sessions

**Context:** D-26 first answered the token-in-HTML problem with an `HttpOnly` HMAC cookie obtained through `auto ui` and a one-time code (`POST /api/ui-session`, `/auth/exchange`). The project owner rejected that for ergonomics: the dashboard must be trivially reachable, so opening `http://127.0.0.1:PORT/` or `http://auto.localhost:PORT/` must work with no sign-in step. Options and the full comparison are in [Q-17](questions/Q-17-cookie-session-instead-of-embedded-token.md).

**Decision:**
- **Cookie sessions are removed.** No `auto_session`, no `Set-Cookie` anywhere, no `POST /api/ui-session`, no `/auth/exchange` (it is an ordinary SPA path), no code store, no cookie-only Origin rule. `/events?token=` stays removed and `X-Auto-Token` is gone: `Authorization: Bearer` is the only credential.
- **The token is embedded in the page** at `/` and every SPA fallback path (`<script id="auto-bootstrap" type="application/json">{"token","port"}</script>`, `no-store`), for a request that passed the Host, Origin and proxy gates. The SPA sends it as a bearer with `credentials: "omit"`. The JSON block is a data block, so the CSP's `script-src` (no `unsafe-inline`) neither runs nor blocks it.
- **Proxied requests under a loopback name are refused.** A built-in loopback `Host` with `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-Ip`, `True-Client-Ip`, `Cf-Connecting-Ip` or `Via` gets 403 `proxied_request`; hosts listed in `AUTO_ALLOWED_HOSTS` are exempt because they are expected to sit behind a proxy. Best effort only: a proxy that rewrites `Host` and sends none of these headers is not detected.
- **`auto ui` prints `<base URL>/` and opens it.** Exit `3` with a hint when `/healthz` is unreachable (no browser opened); exit `0` with a note when only the opener fails. It does not read the token file. `auto install` and `auto svc start` print a `Dashboard: <url>` line.
- **Rotation is the recovery path.** After `auto token rotate` the old bearer gets 401, event streams are closed, and a page reload embeds the new token; the UI shows a reload prompt on 401.

**Consequences:** Anything that can open a TCP connection to the loopback port can read the token from `/`. That is the accepted single-user tradeoff; Auto must not run on a shared multi-user machine and the port must never be forwarded or tunnelled, and [SECURITY.md](../SECURITY.md) says so. Web pages, DNS rebinding, framing and cross-origin reads remain blocked by the Host allowlist, the Origin check, the CSP and frame headers, and the absence of CORS. The residual paths (an allowed proxy host, a proxy that hides itself, other local users, extensions and DevTools) are listed in SECURITY.md rather than hidden.

**Source:** owner decision during the pre-launch polish; supersedes the cookie part of D-26 and the "SPA never holds the token" consequence.

### 42 — Final polish round: stops that reach the whole group, uniform webhook answers, token file authority

**Context:** A last review found processes that outlived a stop, webhook answers that let an unauthenticated caller probe paths and secrets, and a token the supervisor kept in memory only.

**Decision:**
- **A deliberate stop always ends with SIGKILL for the group.** After cancel, timeout or shutdown the runner sends SIGKILL to the worker's process group once the leader has exited (at the kill deadline; at once during shutdown), because a member that ignored SIGTERM holds none of the worker's pipes. Crash recovery waits for the whole group, not the leader pid. In-flight condition checkers are stopped at shutdown (`ConditionEvaluator.stop`), and the config loader is killed when the store stops. A worker that exits normally and leaves a daemon behind is still not the runner's business.
- **Queue promotion asks the registry.** A queued run is checked against the job's current definition (and existence) when it is promoted, not against the copy captured at enqueue.
- **Only enabled jobs need their files.** A missing worker or checker of an `enabled: false` job is a `missing_file` warning, not a config error, so a restart is not degraded by it.
- **Webhook answers before the signature are uniform.** Unknown path, wrong method, missing or malformed signature, wrong signature and an unusable secret are all the same 401 (the supervisor logs the secret problem). This departs from Q-10's bare 503 for a missing secret, on the audit finding that it revealed the path and the missing secret. 503 answers (disabled, paused, shutdown) come only after the HMAC verified; a degraded cold start (no adapter yet) is 503 + `Retry-After: 60` for every `/hooks/*` request. A delivery id alone never dedupes; it needs the same body digest.
- **The token file is the authority.** `AuthState` stat()s the file per use and adopts a valid replacement; a deleted file yields a fresh token; an invalid one is ignored. Streams opened with the old token are closed.
- **Proxy detection matches families** (`X-Forwarded-*`, `Cf-*`, ...), as listed in SECURITY.md.
- **Event contract trimmed to what is sent.** `db.error` and `degraded.entered` are removed; `degraded.exited` is emitted on recovery.
- **CLI honesty.** `auto enable` cannot override `enabled: false` in the config and says so; `auto run --force` is documented as bypassing disabled and paused too; `--json` commands print JSON only; `auto version` reports what the running supervisor reports (`supervisor` in `/api/config/status`); `skip_reason` is part of run summaries; `last_run` ignores skipped and cancelled rows; `auto data wipe` removes only what Auto created; a bad environment is one clean line (`ENV_PROBLEM`); the watchdog entry bakes the install-time `PATH`.

**Consequences:** All API changes are additive (`skip_reason` on runs and recent runs, `supervisor` on config status, `messages`/`jobs`/`triggers` on `config check --json`), except that `last_run` now skips skipped/cancelled rows and unauthenticated webhook answers changed as above.

**Source:** pre-launch polish, final fix round.

### 43 — Last review round: a taken port fails, foreign data dirs are left alone, restarts keep their minute

- **Cookie sessions stay removed** (owner decision, D-41). The dashboard needs no sign-in; the token in the page at `/` is the accepted single-user tradeoff, so the work here is about who can reach that page.
- **`Bun.serve` gets `reusePort: false`.** With `development: false` on Bun 1.4.2 / macOS a second supervisor could bind an already served port and the kernel split traffic between the two (the first one's token got `401`). A taken port must fail the bind (exit 70).
- **Cross-site subresource requests are refused** (`403 cross_site`, `Sec-Fetch-Site` cross-site or same-site with anything but a top-level navigation), and every response carries `Cross-Origin-Resource-Policy` and `Cross-Origin-Opener-Policy: same-origin`. No exploit was found without them; they keep the token page out of foreign renderer processes. A browser opening the dashboard under a disallowed `Host` gets a static explanation page (nothing echoed) instead of bare JSON.
- **`[::1]` is no longer an allowed dashboard `Host`.** The server binds `127.0.0.1` only, so the name could never connect.
- **Permission hardening only touches Auto's own entries** (`isAutoDataEntry`): the top-level `runs/`, `payloads/`, `state/`, the database, token, secrets, lock and log files. A `DATA_DIR` that has content and none of those is left entirely alone (warning at start, no chmod of the directory itself), so a mistaken `AUTO_DATA_DIR` cannot strip execute bits from a workspace. This supersedes the "walks all of `DATA_DIR`" consequence under D-20.
- **Job pages survive a reload for names that look like files.** Under `/jobs/` and `/runs/` a last segment with an extension is a name, not a file; everything else with an extension is still a JSON 404.
- **A malformed `secrets.json` is parsed once per change.** The retry-with-sleep loop is gone (the CLI writes by atomic rename); the failing file's identity is remembered, so redaction and webhook lookups no longer block the event loop.
- **A run that exited in time is not timed out by the pipe wait**: the timeout timer is cleared as soon as the worker has exited. A user cancel is recorded as `killed` with reason `cancelled`.
- **Restarts keep the minute they land in.** The first cron reconcile after a start arms a fire at most one minute in the past, unless a run with that `trigger_meta.fire_at` already exists (`alreadyRan`). Later reconciles never catch up, and fires older than a minute are still skipped (D-24).
- **`ps` that rejects its flags is "unknown", not "dead"** (BusyBox): only exit 1 with an empty stderr means no such process.
- **CLI:** prompts on stderr; 401 retried once after a token rotation; `SupervisorTimeout` (exit 1) is distinct from unreachable (exit 3) and reload waits 30 s; `config status` exits 1 for a rejected config or a degraded supervisor and `version` says `config error` for the former; `auto run | head` keeps the run's exit code (other commands still exit 0 on EPIPE); `create` needs a workspace; `--base-url` without a scheme and an option value that is a command name are usage errors.
- **Dashboard:** run-now notes clear when stale; a job that left the config shows that and no controls; the text filter no longer clobbers other filters; skipped runs show their reason in the table; focus is kept across Disable/Enable and navigation.
- **Tests:** child processes get a clean environment (`cleanEnv`), `startSupervisor` refuses a port that already answers, review-round test files were renamed by topic, and CI pins Bun 1.4.2.

**Consequences:** All API changes are additive (`secret` on `missing_secret` config warnings, `skip_reason: "cancelled"` on cancelled running runs). `auto config status` exit codes and `auto version` status values changed as above. Anyone who relied on `http://[::1]:<port>/` never had a working address.

**Source:** pre-launch polish, last review round.

## Open questions

Implementation-time choices (no design-level disagreement; pick when writing the code):

- **`node:fs.watch` recursive sanity-check** — start without chokidar; only revisit if native `fs.watch` falls over on rename/delete/deep-nesting cases. Bun ships `node:fs` natively with FSEvents on macOS.
- **Token-injection placeholder shape** in `index.html` (`__AUTO_TOKEN__` slot vs `<meta>` vs `<script id="...">`). Cosmetic.
- **Webhook tunnel choice** (cloudflared vs Tailscale Funnel) — left to user; supervisor is loopback-only either way.
- **DST-correctness validation** — confirm next DST boundary date falls inside or outside Phase 1 cutover window; explicit verify-on-boundary if inside.
- **Trigger-level reentrancy override schema** — placeholder reserved (Q-04); shape decided when watch adapter lands.

Explicitly out of scope for v1 (revisit if a real need arrives):

- Multi-user / multi-machine.
- Web push / browser notifications (terminal-notifier covers v1).
- Coalesce-mode for watch (debounce + maxWaitMs is enough).
- Keychain-backed master key for secrets (Q-10 punt).
- Rotation primitives for secrets. (API token rotation shipped as `auto token rotate`, D-26.)
- FTS over run logs.
- Backfill of historical `upgrade.log` into `runs` table.
- Supervisor pushing SIGHUP to long-running workers when secrets change.
- Per-secret access control beyond per-job declared `secrets: [...]`.
- Run-log redaction beyond exact-string match of loaded secrets.
