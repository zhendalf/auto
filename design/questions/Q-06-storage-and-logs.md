# Q-06 — SQLite schema, DB location, and log capture

## Context

Decisions resolved so far imply we need:
- A `jobs` table (runtime state per job: enabled/paused/archived; stable `job_id`)
- A `triggers` table (per-trigger runtime state: enabled flag; stable `trigger_id`)
- A `runs` table (one row per run, with the state machine from Q-04)
- Per-run **supervisor-owned** stdout/stderr capture (Codex Q-04 flag:
  "Do not let worker-local shared log files be the primary trace if
  parallel exists.")

Also need to settle:
- Where the DB file lives.
- Where per-run log files live and how they're rotated/pruned.
- How webhook payloads are referenced (digest only vs full body
  on disk).
- Whether worker-domain logs (existing `bun-autoupdate/upgrade.log`)
  go away or keep coexisting.

## Proposed schema (sketch)

```sql
-- jobs: runtime state mirror of automations.config.ts
CREATE TABLE jobs (
  job_id          TEXT PRIMARY KEY,           -- stable UUID
  name            TEXT NOT NULL UNIQUE,       -- matches config; renamable
  enabled         INTEGER NOT NULL DEFAULT 1,
  paused_until    INTEGER,                    -- epoch ms, nullable
  archived_at     INTEGER,                    -- nullable; set when removed from config
  last_seen_in_config_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

-- triggers: one row per trigger declared in config (cron/webhook/watch)
-- manual is implicit and not stored (per Q-03)
CREATE TABLE triggers (
  trigger_id      TEXT PRIMARY KEY,           -- stable UUID
  job_id          TEXT NOT NULL REFERENCES jobs(job_id),
  kind            TEXT NOT NULL,              -- cron | webhook | watch
  config_hash     TEXT NOT NULL,              -- hash of trigger config; identifies the slot
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

-- runs: one row per fire (queued or executed)
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,           -- UUIDv7 (sortable)
  job_id          TEXT NOT NULL REFERENCES jobs(job_id),
  trigger_id      TEXT REFERENCES triggers(trigger_id), -- null for manual
  trigger_kind    TEXT NOT NULL,              -- cron | webhook | watch | manual
  state           TEXT NOT NULL,              -- queued | running | succeeded | failed
                                              -- | timed_out | skipped | killed | cancelled
  skip_reason     TEXT,                       -- when state=skipped
  enqueued_at     INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  exit_code       INTEGER,
  signal          TEXT,                       -- e.g., "SIGTERM" when killed/timed_out
  trigger_meta    TEXT,                       -- typed-per-kind JSON summary (Q-03)
  log_path        TEXT,                       -- absolute path to per-run combined log
  payload_path    TEXT                        -- optional: webhook raw body on disk
);

CREATE INDEX runs_job_started ON runs(job_id, started_at DESC);
CREATE INDEX runs_state_unfinished ON runs(state) WHERE state IN ('queued','running');
```

## DB location

- **Recommendation:** `~/.automations/data/automations.db`
- `data/` is gitignored.
- Easy to wipe: `rm -rf data/ && bun supervisor.ts` recreates schema
  on startup.
- Time Machine backs it up (it's in user home).
- WAL mode (`PRAGMA journal_mode=WAL`) so the supervisor can write
  while the UI/API reads concurrently without locking.

Alternative: macOS-conventional `~/Library/Application Support/automations/`.
Rejected because (a) keeps the repo self-contained and (b) makes
`rm -rf .automations/data` a single action.

## Per-run log capture

- Supervisor pipes worker stdout+stderr (merged) to
  `~/.automations/data/runs/<YYYY>/<MM>/<DD>/<run_id>.log`.
- Date-partitioned for trivial pruning (`rm -rf data/runs/2025/`).
- Capture limit: cap at, say, 5 MB per run. Truncate with a
  trailing marker `[truncated: N more bytes elided]`. Avoids one
  pathological job filling the disk.
- DB stores `log_path`, not log contents. Keeps the DB small;
  arbitrary-size text in SQLite hurts query performance.
- Default retention: keep run logs 90 days, then delete the file
  (DB row stays, `log_path` set to NULL). Configurable.

## Worker-domain logs

The existing `bun-autoupdate/upgrade.log` represents *application-level*
logging the worker chooses to write — diff summaries, sectioned subprocess
output. Distinct from the supervisor's raw stdout capture.

- **Recommendation:** keep both; they serve different purposes.
  - `<run_id>.log` = whatever the worker wrote to stdout/stderr,
    captured by supervisor, used for "show me the run output."
  - `<job>/upgrade.log` = worker's own structured log if it wants
    one, with rotation managed by the worker.
- For simple workers, `upgrade.log` is unnecessary — they just
  log to stdout and the supervisor handles the rest.

## Webhook payloads

- Digest stored in `trigger_meta` (a small JSON like
  `{ delivery_id, event, action, repo, sha, signature_ok }` for
  GitHub).
- Raw body optional. If `payload_path` is set, supervisor wrote
  the full body to `data/payloads/<run_id>.json`. Default off;
  per-trigger `keep_payload: true` opts in.
- Avoids storing many MBs of JSON we'll never look at.

## Migrations

- Plain SQL files in `supervisor/migrations/0001_init.sql`,
  `0002_*.sql`, etc.
- Supervisor runs pending migrations on startup, transactionally.
- Failure = supervisor refuses to start, logs the error, surfaces
  via a small "broken" page on the HTTP port (UI shows the error).
  This is *not* the same as crash-looping (Q-01 open question).

## Tradeoffs to flag

- **`config_hash` for trigger identity is fragile.** A whitespace
  change in `automations.config.ts` produces a different hash and
  the trigger looks new. Alternative: stable trigger names that
  the user assigns (e.g., `trigger: { kind: "webhook", name: "github-pr" }`).
  Recommendation: prefer **user-assigned names**, fall back to
  positional+kind hash if not provided. Simpler reconciliation.
- **WAL mode + multiple readers/writers.** The supervisor is
  single-process. The CLI/UI read via HTTP (next question), not
  direct DB access. So WAL is just for in-process readers
  (HTTP handlers) vs the writer (cron/trigger threads). Should
  Just Work, but note it.
- **No FTS in v1.** "Search across all logs" is tempting but adds
  schema complexity. Defer.

## Question for reviewer

Is the schema sketch right? `log_path` to disk vs inline in DB —
correct call? Webhook payloads on demand only — correct? User-assigned
trigger names instead of `config_hash`? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- SQLite + per-run log files is the right split. Keep queryable lifecycle metadata in DB; keep noisy, bounded stdout/stderr on disk.
- `~/.automations/data` is acceptable for this repo. The macOS-conventional path is cleaner in theory, but self-contained wipe/rebuild matters more for a personal automation repo.
- Do not use `config_hash` as identity. Stable user-assigned trigger IDs/names should be required, not preferred. Hashes are useful for drift detection, not identity.
- Keeping worker-domain logs is fine, but they must be explicitly secondary. The UI and run history should treat supervisor capture as canonical.

**Anything missed:**
- Add `updated_at` / `last_seen_in_config_at` to `triggers`, plus `archived_at`, matching jobs. Removed triggers need history-preserving retirement.
- Store relative paths under `data/`, not absolute paths, unless there is a strong reason. It makes moves/backups/restores less brittle.
- Add run-attempt/process metadata: `pid`, `cwd`, `worker_path`, maybe `config_version` or `definition_hash`, so old runs remain explainable after config changes.

**Recommended choice:** Keep the proposed design, but require explicit stable `trigger_id`/`name`, store logs and payloads under `data/` by relative path, and add archival/reconciliation fields for triggers.
