# Q-05 — Where does job/trigger config live?

## Context

Today, [automations.config.ts](../../automations.config.ts) is the single
source of truth — typed, version-controlled, edited in the IDE.

The user wants a React+Tailwind SPA UI. That raises the question:
should the UI be able to **create / edit / delete** automations, or
only **view + control** (run, pause, view logs)?

This determines whether the config lives in:
- A TS file (source of truth — UI is read-only over config, supervisor
  re-reads the file on change)
- A SQLite table (source of truth — UI does full CRUD; TS file is
  redundant or merely a seed)
- Both, with one being canonical (sync on startup, etc.)

## Options

### a) TS file is canonical; UI is view + control only

`automations.config.ts` stays as today. UI shows automations, run
history, lets user trigger runs, cancel runs, view logs. Adding /
editing / removing requires editing the TS file (and re-running
`bun register-all.ts` or similar — supervisor watches the config file
and reloads on change).

- Pros:
  - Config in git → diffable, reviewable, undoable.
  - Type-checked at edit time.
  - Easy to grep / generate / templatize.
  - "Job state" stays one-way: file → supervisor.
- Cons:
  - User must context-switch to the editor for new automations.
  - "Pause" or "disable" needs to either edit the file or live as
    runtime state in the DB (mixed source-of-truth — dangerous).
  - UI feels weaker — observation tool, not a control panel.

### b) SQLite is canonical; UI does full CRUD

Jobs + triggers live in DB tables. UI has create/edit/delete forms.
TS file is gone or kept only as a seeder for fresh-machine bootstrap.

- Pros:
  - UI is a real control panel.
  - Pause/disable, edit-cron-on-the-fly, etc. are first-class.
- Cons:
  - **No diff in git.** Configuration drift goes unreviewed.
  - Have to write CRUD UI for every config field (cron expr,
    schedule, paths, payloads, timeouts, ...).
  - Easy to break a job by editing wrong field — no type checking.
  - Workers are still files in folders → hybrid weirdness ("the
    worker is in git but its schedule isn't").
  - Migration story when schema changes.

### c) Hybrid: TS file canonical for *definitions*, DB for *runtime state*

`automations.config.ts` defines jobs and their triggers (immutable
declarations). DB tracks runtime state per job: `enabled`, `paused`,
`last_run_at`, plus all run history. UI shows definitions read-only,
but can flip `enabled`/`paused` flags in the DB.

- Pros:
  - Definitions stay in git — diffable, type-checked, reviewable.
  - Runtime "is this thing currently active?" lives where it
    naturally belongs — in the running system's state.
  - UI gets meaningful control (enable/disable, manual run, cancel,
    view logs) without becoming a config editor.
  - Adding a new automation is still "drop a worker.ts, add a config
    entry, supervisor picks it up on reload."
- Cons:
  - Two sources to look at when debugging "why isn't this firing?"
    (config + DB enabled flag). Mitigated by surfacing both in UI.

## Recommendation

**(c) Hybrid — TS file for definitions, DB for runtime state.**

- Config schema (`automations.config.ts`) is the v1 canonical source
  for `{ name, worker, triggers, timeoutMs, reentrancy, ... }`.
- DB has a `jobs` table with `(name PK, enabled, paused, last_seen_in_config)`
  and a `runs` table with run history. The supervisor on startup
  reconciles: reads config, upserts `jobs` rows, marks `last_seen_in_config`,
  archives jobs no longer present in config (don't delete — keeps
  history queryable).
- UI controls available without editing the TS file:
  - Enable / disable a job.
  - Pause a job (skip scheduled fires until resumed).
  - Manual run (already a Trigger).
  - Cancel a running or queued run.
  - View runs and logs.
- Adding/editing a job → edit `automations.config.ts`. Supervisor
  watches the file (built-in `fs.watch`) and reloads on change.
- Migration story: TS file changes are diffable in git; DB changes
  are migrations that run on supervisor startup.

## Tradeoffs to flag

- **Reload semantics.** When config changes mid-run, what happens
  to in-flight runs? Probably: in-flight runs use the *old*
  config until they finish; new triggers use the new config.
  Worth confirming.
- **Disabled vs paused.** Two separate flags? Or one tri-state?
  Suggestion: `enabled` (boolean, can be flipped from UI) +
  `paused_until` (timestamp, optional, for "pause for an hour").
- **Secrets.** Webhook secrets, API tokens — these don't belong in
  the TS config that's checked into git. Need a separate decision
  on secrets storage (env vars? `~/.automations/.env`? macOS
  Keychain?). Defer to its own question.

## Question for reviewer

Is hybrid (TS for definitions, DB for runtime state) the right
shape? Is there a UX scenario where users would feel friction —
e.g., "I want to add a webhook from the UI without opening an
editor"? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- Hybrid is the right default for this repo: worker code and trigger definitions belong in git because they are executable behavior, not casual preferences.
- Full SQLite CRUD is overbuilt for a single-machine automation repo and creates a worse split: code in git, operationally critical schedules/routes in mutable DB.
- DB runtime state is legitimate, but only if it is clearly override state. The UI must always explain "configured in TS, currently disabled/paused by DB" or debugging becomes muddy.
- Do not make `enabled` a permanent DB-only shadow of config intent without care. If a job should be retired, that should happen in TS; DB disable should mean local/runtime override.

**Anything missed:**
- Persist runtime state by stable `job_id`, not just `name`, or renames will either lose pause state/history linkage or accidentally attach old state to a different job.
- Trigger-level enable/disable will probably be needed before job-level only: disabling one noisy webhook/watch trigger while keeping cron/manual active is a real control-panel use case.
- Bad config reload behavior needs a hard rule: keep last-known-good config active, surface reload error in UI, and do not tear down working triggers on a syntax/type/import failure.

**Recommended choice:** Option C, hybrid: TS canonical for definitions, SQLite canonical for runtime state and history, with stable IDs, trigger-level runtime overrides, and last-known-good reload semantics.
