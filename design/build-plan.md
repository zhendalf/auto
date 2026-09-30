# Build plan — Auto supervisor

This document is the synthesis of the 15 decisions in
[decisions.md](decisions.md). It consolidates the architecture
into a single picture and lays out the phased implementation
order, with concrete deliverables for Phase 1 (the riskiest cut).

> **Status: historical plan.** It records the original shape and phasing.
> Decisions 17 onward in [decisions.md](decisions.md) supersede it where they
> conflict. Notably: the singleton is a JSON lock with a pid and command-line
> identity check (not `flock`, D-19); `start-history.json` no longer exists
> (D-20); the token is still embedded in the served page for allowed Hosts and
> is sent as a bearer, with no cookie sessions (D-41), and `Host`/`Origin` are
> checked (D-26); configured schedules use Auto's own cron
> implementation (D-24); and run history is pruned by a retention sweeper
> (D-34). Current behavior is documented in the README, SECURITY.md and
> AGENTS.md.

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────────────┐
│                 Bun OS cron watchdog (portable)                    │
│   title: automations-supervisor; schedule: * * * * *               │
│   ThrottleInterval=300, KeepAlive(SuccessfulExit=false)            │
└────────────────────────────────────────────────────────────────────┘
                                │ exec bun supervisor.ts
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                    supervisor process (single Bun)                 │
│                                                                    │
│  config loader     ◄──── automations.config.ts (TS, in git)       │
│  validator (Zod)        watches file, reload-on-change             │
│                         keep-last-known-good on error              │
│                                                                    │
│  trigger adapters:                                                 │
│   ├── cron     (Bun.cron; local TZ; DST-aware)                    │
│   │    └── optional condition checker subprocess (Q-13)           │
│   ├── webhook  (HMAC; body limits; loopback bind)                  │
│   ├── watch    (node:fs.watch; debounce + maxWaitMs)              │
│   └── manual   (always implicit; CLI/UI initiated)                 │
│         │                                                          │
│         ▼ all converge on:                                         │
│  runWorker(jobName, triggerCtx)                                    │
│     applies reentrancy (drop|queue|parallel) + timeout             │
│     spawns Bun.spawn(['bun', worker.ts], { env, cwd, ... })        │
│     pipes stdout+stderr (merged, redacted) to                      │
│       data/runs/<YYYY>/<MM>/<DD>/<run_id>.log                      │
│     records row in runs table                                      │
│                                                                    │
│  Bun.serve on 127.0.0.1:7777                                       │
│   ├── /api/*    token-protected, Origin/Host checked              │
│   ├── /hooks/*  HMAC, body limits, no token                        │
│   ├── /events   SSE                                                │
│   ├── /healthz                                                     │
│   └── /*        SPA (ui/dist/; token in page, D-41)                │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         data/ (gitignored)                         │
│  ├── automations.db           SQLite (WAL): jobs, triggers, runs,  │
│  │                            condition state                      │
│  ├── secrets.json             chmod 600; supervisor-only readable │
│  ├── .token                   chmod 600; CLI/UI auth token         │
│  ├── supervisor.lock          JSON singleton lock (D-19)           │
│  ├── state/                                                        │
│  │   ├── supervisor.log       supervisor stdout/stderr (D-21)      │
│  │   └── last-error.txt                                            │
│  ├── runs/<YYYY>/<MM>/<DD>/<run_id>.log                            │
│  └── payloads/<run_id>.json   webhook bodies (opt-in)              │
└────────────────────────────────────────────────────────────────────┘
```

## Repo layout (target)

```
~/.automations/
├── automations.config.ts      # job/trigger definitions (canonical)
├── supervisor/
│   ├── main.ts                # entry; --check mode for offline validation
│   ├── lifecycle.ts           # singleton lock, exit codes, degraded mode
│   ├── config.ts              # loader + Zod validation + reload-on-change
│   ├── condition-evaluator.ts # bounded checker subprocess + durable state
│   ├── runner.ts              # runWorker(): reentrancy, spawn, capture, redact
│   ├── server.ts              # Bun.serve + route handlers
│   ├── adapters/
│   │   ├── cron.ts
│   │   ├── webhook.ts
│   │   ├── watch.ts
│   │   └── manual.ts
│   ├── db/
│   │   ├── connection.ts
│   │   └── migrations/
│   │       └── 0001_init.sql
│   └── ui/                    # token injection, static serving rules
├── cli/
│   ├── main.ts                # commander entry
│   ├── commands/              # one file per top-level group
│   └── client.ts              # API client (token + base-url)
├── ui/                        # Vite + React 19 + Tailwind v4
│   ├── src/{main,App}.tsx
│   ├── src/routes/
│   ├── src/components/
│   ├── src/api/               # React Query hooks
│   ├── src/styles.css         # @import "tailwindcss" + @theme
│   ├── index.html             # contains __AUTO_TOKEN__ slot
│   ├── vite.config.ts
│   └── package.json
├── bun-autoupdate/
│   └── worker.ts              # unchanged
├── design/                    # this directory
├── data/                      # gitignored runtime state
├── package.json
├── tsconfig.json
├── README.md
└── AGENTS.md
```

## Implementation order

### Phase 1 — Supervisor + cron + run history (CRITICAL: cutover from Bun.cron)

**Deliverables:**

- [ ] Repo skeleton: `supervisor/`, `cli/`, `data/` directories;
      updated `automations.config.ts` schema.
- [ ] `supervisor/db/migrations/0001_init.sql`: jobs, triggers,
      runs tables per Q-06 schema.
- [ ] `supervisor/config.ts`: loader, Zod validation, reload-on-change,
      keep-last-known-good on reload error.
- [ ] `supervisor/lifecycle.ts`: singleton lock (originally `flock`,
      now the JSON lock of D-19), exit-code conventions (Q-09, D-20),
      degraded mode for cold-start config errors.
- [ ] `supervisor/runner.ts`: `runWorker()` primitive — spawn, env
      injection, stdout/stderr capture with secret redaction,
      reentrancy gate (drop | queue | parallel), timeout
      (SIGTERM → SIGKILL), persist run row.
- [ ] `supervisor/adapters/cron.ts`: croner wired to `runWorker`.
      Local-time scheduling; verified across DST.
- [ ] `supervisor/adapters/manual.ts`: always-on; produces
      conflict response on overlap unless force.
- [ ] `supervisor/main.ts --check`: offline validation (config +
      migrations dry-run). Exit 0/78.
- [ ] LaunchAgent install script: writes `~/Library/LaunchAgents/dev.z.automations.plist`,
      `launchctl load`. Plist sets WorkingDirectory, abs Bun path,
      explicit PATH, StandardOut/ErrorPath, ThrottleInterval=300,
      `KeepAlive` dict.
- [ ] CLI v0: `auto svc install`, `svc start/stop/restart`, `svc tail`,
      `runs`, `log <run_id>`, `last <name>`, `run <name>`.
- [ ] Migration: `bun -e 'await Bun.cron.remove("bun-global-upgrade")'`,
      followed by `auto svc install` and `auto run bun-global-upgrade`
      to verify the spawn → log → DB path.
- [ ] `design/rollback.md`: one-line recovery to old `Bun.cron`
      registration if Phase 1 is broken at 03:30.

**Phase 1 exit criteria** (Q-12 cutover checklist):

1. `launchctl list | grep automations` returns the LaunchAgent.
2. `curl 127.0.0.1:7777/healthz` returns 200 (or 503 in degraded mode).
3. `bun -e 'await Bun.cron.list?.()'` (or equivalent) confirms no
   `bun-global-upgrade` registered with Bun.cron.
4. Manual run via `auto run bun-global-upgrade` succeeds: row in
   `runs` with `state=succeeded`, log file at
   `data/runs/<YYYY>/<MM>/<DD>/<run_id>.log`, exit 0.
5. **Two real scheduled runs at 03:30 succeed** before Phase 2 begins.

### Phase 2 — HTTP API + read-only SPA

**Deliverables:**

- [ ] `supervisor/server.ts`: `Bun.serve` with route-prefix split
      (`/api/*`, `/events`, `/healthz`, `/*`); token enforcement
      with `Origin`/`Host` checks; static-serve safety rules
      (no path traversal; SPA fallback excludes `/assets/*`);
      `Cache-Control: no-store` for HTML, `immutable` for hashed
      assets; HTML token injection as escaped `<script>` JSON.
- [ ] API endpoints: jobs/runs read endpoints + manual trigger +
      cancel + enable/disable + config status (per Q-07 list).
- [ ] SSE `/events`: `run.queued`, `run.started`, `run.finished`,
      `config.reloaded`, `config.error`, `db.error`.
- [ ] `ui/` SPA: Vite + React 19 + Tailwind v4 + React Query.
      Views: jobs list, job detail, run history, run log
      (with follow mode via SSE), config status banner.
- [ ] Vite dev plugin to read `data/.token` for dev shell.
- [ ] CLI v1: `auto job <name>`, `auto cancel`, `auto enable/disable`,
      `auto pause`, `auto trigger enable/disable`, `auto config status`,
      `auto config edit`, `auto ui`, `auto doctor`, `auto data wipe`,
      global `--json | --no-color | --token-file | --base-url | --yes`.

**Phase 2 exit:** UI shows live state of bun-autoupdate runs;
manual run from UI works; SSE updates without page reload.

### Phase 3 — Webhooks + secrets

**Deliverables:**

- [ ] `data/secrets.json` (mode 0600); `auto secret list/set/remove` CLI;
      validation at supervisor startup (missing secrets → degraded
      trigger only); secret redaction in run-log capture.
- [ ] `supervisor/adapters/webhook.ts`: per-trigger HMAC verification
      (GitHub-shaped first, generic later); body size limits;
      content-type allowlist; cheap rejection before storage; opt-in
      payload persistence to `data/payloads/<run_id>.json`.
- [ ] Tunnel guidance in README (cloudflared / Tailscale Funnel,
      both must path-filter to `/hooks/*` only, fail-closed).

### Phase 4 — Scheduled condition guards + file watch

**Deliverables:**

- [ ] Optional `condition` schema on cron triggers: repo-relative checker,
      30-second default timeout, bounded JSON stdin/stdout/state/meta.
- [ ] Condition evaluator subprocess with quiet `fire=false` checks,
      single-flight fired actions, no secrets by default, and proposed state
      committed atomically only when the action run succeeds (Q-13).
- [ ] Durable per-trigger condition state and health: committed/pending
      state, evaluation count, last evaluation/fire, consecutive failures,
      and bounded last error.
- [ ] Trigger-status API/CLI visibility plus
      `auto trigger check <job> <trigger>` for explicit evaluation.
- [ ] `supervisor/adapters/watch.ts`: `node:fs.watch` (recursive,
      FSEvents on macOS); `debounceMs` + `maxWaitMs` from Q-04; paths
      relative to repo root.

### Phase 5 — Polish

**Deliverables:**

- [ ] Per-trigger enable/disable UI surfaces.
- [ ] SSE-driven React Query invalidation.
- [ ] Shell completions (`auto completion zsh|bash|fish`).
- [ ] Updated README + AGENTS.md to reflect supervisor world.

## Tech stack (locked at design time)

- **Runtime:** Bun. Workers stay runnable as `bun <job>/worker.ts`.
- **Scheduler:** Bun's in-process and OS-level cron APIs. The supervisor keeps
  admission/history/condition semantics; Bun owns platform scheduling.
- **File watcher:** `node:fs.watch` (native, FSEvents on macOS,
  recursive supported). No third-party dep. Chokidar's main value is
  cross-platform consistency, which we don't need for a macOS-only
  single-machine repo.
- **Schema validation:** [Zod](https://www.npmjs.com/package/zod) for
  config + secrets shape.
- **DB:** SQLite via Bun's built-in `bun:sqlite`. WAL mode.
- **HTTP server:** Bun.serve.
- **SPA:** React 19, React Router, Tailwind v4 (`@tailwindcss/vite`),
  `@tanstack/react-query`. Vite for build/dev.
- **CLI:** commander; prompts (npm) for hidden input; picocolors;
  hand-rolled tables.

## Open implementation questions (decided at impl time, not design time)

- **`node:fs.watch` recursive sanity-check:** confirm recursive watch
  on macOS handles the cases we care about (rename, delete, deep
  nesting). If it falls over, revisit chokidar — but start without it.
- **Token-injection placeholder name:** `__AUTO_TOKEN__` vs
  `<meta name="auto-token">` vs `<script id="auto-bootstrap">`.
  Cosmetic; pick during Phase 2.
- **Argon2 / bcrypt for the API token?** Probably not — token is
  random-bytes only, no human secret. Defer.
- **Web push / push notifications from supervisor.** Out of scope
  for v1; `terminal-notifier` covers v1.
- **Multi-user / multi-machine.** Explicitly NOT a goal.

## Pre-Phase-1 todo

Before any code lands:

1. `git tag pre-supervisor` (rollback waypoint per Q-12).
2. Confirm `bun-autoupdate/upgrade.log` last entry is recent.
3. Confirm DST schedule for the next 60 days — if a transition
   falls during Phase 1, plan an explicit cron-correctness
   check on that day.
4. Review and approve this plan with the user.
