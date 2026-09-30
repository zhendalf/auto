# Q-11 — CLI surface design

## Context

The user wants both a UI and a way to manage automations from the
terminal. The UI is the polished surface; the CLI exists for fast
inspection, scripting, and bootstrapping (install/uninstall the
LaunchAgent, validate config without touching the running supervisor,
manage secrets, etc.).

Key dependencies:
- CLI talks to running supervisor via `/api/*` over loopback with
  the token from `data/.token` (Q-07).
- Some CLI subcommands (install, --check, secrets) work *without*
  a running supervisor.
- Per Q-10, secrets management is CLI-only; no UI in v1.

## Naming and entry point

- **Binary:** `auto` — short, doesn't shadow common tools.
- **Install:** `bun link` from the repo so `auto` resolves to the
  CLI script, OR a single shell script in `~/.local/bin/auto` that
  shells out to `bun ~/.automations/cli/main.ts "$@"`.
- **Style:** `auto <verb> [<noun>] [args...]` (verb-first, like git).
  Subcommand groups for `auto job`, `auto secret`, `auto svc`
  (service / supervisor lifecycle) where it adds clarity.

## Subcommand inventory

### Service / lifecycle (works without supervisor running)
- `auto svc install` — write LaunchAgent plist, load it.
- `auto svc uninstall` — unload LaunchAgent, remove plist (asks
  before deleting `data/`).
- `auto svc start` / `auto svc stop` / `auto svc restart` — wraps
  `launchctl`.
- `auto svc status` — shows whether LaunchAgent is loaded, last
  start, exit history (from `data/state/start-history.json`).
- `auto svc tail` — tail `StandardOutPath` + `StandardErrorPath`
  from the plist.
- `auto svc check` — runs supervisor in `--check` mode (validate
  config, dry-run migrations, exit 0/78). Doesn't touch a
  running supervisor.

### Jobs (talks to running supervisor over /api/*)
- `auto jobs` — list jobs with state (configured / enabled /
  paused / archived, last run summary).
- `auto job <name>` — detail view.
- `auto run <name>` — manual trigger. Honors Q-04 "manual returns
  conflict on overlap"; CLI prompts "already running, run anyway?
  (y/N)" interactively, or `--force` non-interactively.
- `auto cancel <run_id|name>` — cancel running or queued run. If
  given a job name, cancels its currently running run.
- `auto enable <name>` / `auto disable <name>` — flip runtime
  enable flag.
- `auto pause <name> [duration]` — pause for a duration (e.g.,
  `auto pause bun-global-upgrade 1h`).
- `auto trigger enable|disable <trigger_name>` — per-trigger
  flag (Q-05 codex callout).

### Runs and logs
- `auto runs [--job <name>] [--state <s>] [-n N]` — list recent
  runs.
- `auto log <run_id>` — print log file. With `--follow` for
  in-progress runs (streams from supervisor).
- `auto last <name>` — shorthand for the last run of a job, with
  log inline.

### Secrets (works without supervisor running, edits `data/secrets.json`)
- `auto secret list` — print names only, never values.
- `auto secret set <name>` — prompts (no echo) for value.
- `auto secret remove <name>` — confirms first.
- (No `get`. Codex Q-10 callout.)

### Config inspection
- `auto config check` — alias for `svc check`.
- `auto config status` — fetches `/api/config/status` from
  supervisor (current version, last reload, errors).
- `auto config edit` — opens `automations.config.ts` in `$EDITOR`.
  After editor exits, runs validation and reports.

### Misc
- `auto ui` — opens `http://127.0.0.1:7777/` in the default
  browser.
- `auto doctor` — runs a battery of diagnostics: LaunchAgent
  loaded? Port responsive? DB reachable? Config valid? Token
  file present and 0600? Reports OK/FAIL for each.
- `auto version` — prints supervisor version, CLI version,
  Bun version.

## Output format

- **Default:** human-readable with colors (gum-style or just
  ANSI). Tables for list views. Concise for scripting.
- **`--json`:** machine-readable JSON for any list/get command.
- **Stable exit codes:**
  - 0: success
  - 1: error
  - 2: usage / argument error
  - 3: supervisor not reachable (caller can detect "is the
    supervisor up?" cleanly)
  - 4: conflict (e.g., "already running" on `run` without
    `--force`)
- Default to stdout for data, stderr for status/errors so
  `auto runs --json | jq ...` Just Works.

## Library choices

- Argument parsing: **`bun:cli` once it lands**, otherwise
  `commander` or `yargs`. Recommend `commander` — small, stable,
  no Bun-specific quirks.
- Prompts: Bun's `prompt` for simple cases, `prompts` (npm) for
  password-style hidden input.
- Colors: native ANSI escape codes or `picocolors` (tiny).
- Tables: `cli-table3` or just hand-rolled spaces. The latter is
  less work and looks better.

## Tradeoffs to flag

- **`auto svc tail` shows supervisor stdout.** That's separate
  from per-run logs. Worth distinguishing in help text:
  `auto svc tail` = supervisor diagnostics, `auto log <run_id>` =
  worker output for a specific run.
- **Two CLI binaries vs one** — could split `auto` (job control)
  and `autoadmin` (svc/secret install/uninstall). Recommend one,
  with grouped subcommands.
- **Interactive prompts vs flags.** `auto run <name>` on overlap
  prompts; pipe-able usage requires `--force`. Worth defaulting
  to non-interactive when stdin isn't a TTY (auto-fail with code 4
  in pipes).

## Question for reviewer

Is this surface right and complete for v1? Any subcommands that
should NOT exist (overengineering)? Anything missing for a real
day-to-day workflow? Naming choices reasonable?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- The surface is directionally right: one `auto` binary with `svc`, `job`, `secret`, `config` groups matches the personal-ops use case better than splitting admin and job control.
- V1 inventory is slightly too large. `doctor`, `svc check`, `config check`, `svc status`, and `version` overlap; keep them, but define one canonical diagnostic path so the CLI does not become five partial health checks.
- Do not make `svc uninstall` ask about deleting `data/`. Uninstalling the service and destroying history/secrets are different blast radii. Data deletion should be a separate explicit command, probably `auto data wipe`.
- The API-dependent commands need a crisp offline behavior: exit `3` for supervisor unreachable, never silently inspect SQLite except for explicitly offline commands.

**Anything missed:**
- Add global flags: `--json`, `--no-color`, `--token-file`, `--base-url`, maybe `--yes`. These matter for scripting and recovery.
- Add `auto completion` or at least design command names so shell completion can be added later without churn.
- Define non-interactive behavior globally: if stdin is not a TTY, prompts must fail unless `--force`/`--yes` is supplied.

**Recommended choice:** AGREE-WITH-CAVEAT — keep one `auto` binary, ship a smaller v1 centered on `svc`, `jobs/job/run/cancel/log/last`, `secret`, `config check/status/edit`, `doctor`, and move destructive data deletion into a separate explicit command.
