# Q-12 — Migrating from Bun.cron to the supervisor

## Context

The repo currently has one running automation:
[`bun-autoupdate/worker.ts`](../../bun-autoupdate/worker.ts) registered
via `Bun.cron` in `automations.config.ts` + `register-all.ts`. It's
been running daily at 03:30 for the last week (per `upgrade.log`).

Q-03 decided we drop `Bun.cron` and the supervisor owns scheduling.
This question pins down the migration path so the rebuild doesn't
silently break the daily upgrade.

## Phasing options

### a) Big bang

Build the supervisor end-to-end (cron + HTTP + UI + watch +
webhooks), drop Bun.cron in one PR, switch over.

- Pros: clean cut.
- Cons: long branch; user has no working automation while it's in
  flight; high risk of "everything broken" on flip.

### b) Strangler fig (recommended)

Build the supervisor incrementally. Each phase produces a working
system that's strictly better than the previous. Keep `Bun.cron`
alive until cron-via-supervisor is proven.

Phases:

1. **Phase 1 — Supervisor skeleton + cron + run history.**
   - LaunchAgent installed; supervisor process running.
   - Cron adapter only (drop webhook/watch/UI for now).
   - SQLite `runs` table populated; `data/runs/<run_id>.log` files
     written.
   - `automations.config.ts` schema updated to the new union
     (cron-only triggers initially).
   - `bun-global-upgrade` runs from supervisor cron, NOT from
     `Bun.cron`.
   - The CLI has minimal subcommands: `svc install/start/stop`,
     `runs`, `log <run_id>`, `last <job>`.
   - `Bun.cron`-based registration (`register-all.ts`) is removed
     in this phase. Old crons unregistered (`Bun.cron.remove`).
   - **Validation gate:** supervisor runs the upgrade for at least
     2 days successfully before merging Phase 2. (Manual sanity
     check, not automated.)

2. **Phase 2 — HTTP API + read-only SPA.**
   - `Bun.serve` on `127.0.0.1:7777`. `/api/jobs`, `/api/runs`,
     `/api/runs/:id/log`, `/healthz`, `/events` (SSE).
   - Vite + React + Tailwind SPA in `ui/`. Read-only views: jobs,
     run history, logs.
   - CLI gains `auto job`, `auto run`, `auto cancel`, `auto enable/
     disable`, `auto config status`.
   - Token in `data/.token`, mode 0600, used by both CLI and SPA.

3. **Phase 3 — Webhooks.**
   - Webhook adapter wired to the same `runWorker()` primitive.
   - `data/secrets.json` storage, `auto secret` CLI.
   - HMAC verification per trigger.
   - Network exposure left to user choice (Tailscale / cloudflared);
     supervisor binds loopback only.

4. **Phase 4 — File watch.**
   - `chokidar` (or chosen lib) wired to the same primitive.
   - `debounceMs` + `maxWaitMs` from Q-04.
   - `paths` resolved relative to repo root.

5. **Phase 5 — Polish.**
   - Per-trigger enable/disable UI surfaces.
   - SSE invalidation in React Query.
   - `auto doctor`, completion scripts, README + AGENTS.md
     updates.

Each phase ends with a working, deployable supervisor. The user
can stop at any phase and still have value.

### c) Parallel (don't recommend)

Run new supervisor alongside Bun.cron during transition.

- Pros: rollback is easy.
- Cons: double-firing is real (both could run `bun-global-upgrade`
  on a given day); coordination is more pain than just removing
  the old registration when the new one is proven.

## Pre-migration tasks

Before Phase 1 starts:

- [ ] Snapshot current state into a git tag (`pre-supervisor`).
- [ ] Confirm `bun-autoupdate` is firing at 03:30 — read
      `upgrade.log` last entry.
- [ ] Decide on the new top-level layout
      (`supervisor/`, `cli/`, `ui/`, `data/`, plus existing
      job folders unchanged) before writing any code.
- [ ] Update `AGENTS.md` and `README.md` once Phase 1 ships.

## bun-autoupdate worker changes

Surprisingly minimal. Per Q-02, worker contract is "default
`scheduled()` export, plus `if (import.meta.main)` for direct
runs." Existing worker already has both. Changes needed:

- Move trigger declaration from `automations.config.ts`'s old
  shape to the new `triggers: [{ kind: "cron", schedule: "30 3 * * *", name: "daily" }]`.
- Add `name`, `description` fields under the new schema.
- Remove `register-all.ts` (replaced by supervisor's config loader).
- Worker code itself: no changes needed in Phase 1. Optionally,
  later, drop the worker's own `notify()` and rely on supervisor
  to surface failures (Q-13 — observability).

## Schema migration

For Phase 1 (no DB exists yet), the migration is just creating
schema from scratch. No data loss risk.

Future schema changes:
- Plain SQL migration files run on supervisor start (Q-06).
- Each migration in its own transaction. Failure halts startup;
  user sees error in `data/state/last-error.txt`.

## Tradeoffs to flag

- **Phase 1 is the riskiest phase** because Bun.cron is removed
  before the supervisor is "production." Mitigation: keep the
  `pre-supervisor` git tag handy; if supervisor cron is unreliable,
  revert and re-register old `Bun.cron`.
- **Two-day validation is informal.** Could automate with a "did
  bun-global-upgrade succeed yesterday?" canary, but defer.
- **No backfill of historical run data.** The current
  `upgrade.log` has ~1 week of plain text history. We're not
  parsing it into the new `runs` table. Acceptable — keep the
  log file around indefinitely as historical record.

## Question for reviewer

Strangler-fig phasing right? Is Phase 1 the right cut (cron only,
no UI yet)? Should we keep Bun.cron running in parallel for
Phase 1 even at risk of double-fires? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- Strangler fig is right, and Phase 1 is the right cut: cron + run history is the irreducible replacement for the current system. UI/webhooks/watch would only increase blast radius before the core scheduler is proven.
- Do **not** run Bun.cron in parallel. Double-firing `bun update --latest --global` is not catastrophic, but it creates ambiguous evidence: you will not know which scheduler actually kept the promise.
- The risky part is not deleting `register-all.ts`; it is assuming unregister happened. Removing source code does not remove persisted Bun cron state. Phase 1 needs an explicit, verified unregister step.
- The two-day validation gate is directionally fine, but too informal as written. At minimum, make it a checklist with evidence: LaunchAgent loaded, supervisor health OK, no Bun.cron entry, two successful supervisor-owned runs, logs captured under `data/runs`.

**Anything missed:**
- Add a rollback artifact before deleting old registration: either keep a temporary `legacy-register.ts` or document the exact `bun -e 'await Bun.cron(...)'` recovery command. A git tag alone is slower than needed during a missed daily automation.
- Capture timezone semantics explicitly. Current log shows `2026-04-30T10:30:05Z`, which matches 03:30 Pacific; the supervisor cron parser must preserve local-time behavior across DST.
- Phase 1 should include a one-shot `auto run bun-global-upgrade` or equivalent manual trigger. Waiting overnight is unnecessary for proving worker spawn, logging, DB insert, and failure handling.

**Recommended choice:** b) Strangler fig, but tighten Phase 1 into a verified cutover: supervisor cron only, Bun.cron explicitly removed and checked, manual run supported, rollback command documented, then two real scheduled runs before moving on.
