# Claude Code notes for ~/.automations

The canonical agent guide for this repo is **[AGENTS.md](AGENTS.md)**.
Read it first; it covers conventions for any agent (Claude Code,
codex CLI, Cursor, etc.).

This file collects Claude-Code-specific tips that don't belong in
AGENTS.md.

## Repo profile

- macOS is the verified platform; Linux and Windows go through Bun's
  scheduler but are untested (README "Status"). Bun 1.3 or newer
  (`engines`), developed on Bun 1.4. Single-machine, single-user.
- Source folders: `supervisor/`, `cli/`, `ui/`, `scripts/`, `design/`, and
  `test/`. Live configuration and personal workers are under `~/.auto/`,
  outside this engine repository.
- One package. The supervisor bundles the dashboard in `ui/` (React 19 +
  Tailwind v4 + React Query 5) in memory with `Bun.build` when it starts;
  there is no build step and no `ui/dist` (D-44).
- Green bar = `bunx tsc --noEmit` (root, excludes `ui/`) AND
  `bun run typecheck:ui` AND `bun test`. `bun run verify` runs all
  three. Don't quote a test count in docs; it changes.
- CI (`.github/workflows/ci.yml`) runs the same on macOS, plus
  `bun pm pack --dry-run`. `test/ui-bundle.test.ts` bundles the real UI.

## Useful commands

```bash
bun test                          # full suite (backend, CLI, pure UI helpers)
bun run verify                    # root tsc + ui tsc + tests
bunx tsc --noEmit                 # root tsc (excludes ui/)
bun run typecheck:ui              # ui tsc (ui/tsconfig.json)
AUTO_UI_DEV=1 bun supervisor/main.ts   # with a scratch AUTO_HOME/AUTO_PORT: rebundles ui/ on change
bun pm pack --dry-run             # what the package would contain

auto svc tail                     # follow data/state/supervisor.log
auto runs                         # recent runs (via /api/runs)
auto log <id> [--follow]          # captured run log (id = last 8 hex chars)
auto run <name>                   # manual trigger; --force also bypasses disabled/paused/a run in progress
auto job <name>                   # full job detail
auto pause <name> 1h              # pause for a duration
auto config status                # config + degraded info (exit 1 if the config is rejected or degraded)
auto doctor                       # diagnostic battery, one fix line per problem
auto ui                           # print the URL and open the dashboard
bun supervisor/main.ts --check    # offline config + migration validation
```

Those `auto` commands talk to whatever supervisor `AUTO_PORT` /
`AUTO_HOME` point at, which is the owner's live one by default. Against a
scratch workspace, set `AUTO_HOME`, `AUTO_DATA_DIR` and `AUTO_PORT`
explicitly first.

## Where to look first

- "How does X work?" → [design/build-plan.md](design/build-plan.md)
  for the original shape, [design/decisions.md](design/decisions.md) D-NN for
  the why (D-17 onward record the pre-launch polish and supersede earlier
  entries where they conflict).
- "Why did we choose Y?" →
  [design/questions/Q-NN-*.md](design/questions/) — each has the
  rationale, and the older ones the codex review.
- "What changed and how was it verified?" →
  [design/build-log.md](design/build-log.md) and [CHANGELOG.md](CHANGELOG.md).
- "How do I roll back or recover?" → [design/rollback.md](design/rollback.md).

## Slash commands worth knowing

- `/ultrareview` — multi-agent cloud review of the current branch.
  Useful after any non-trivial change; user-triggered + billed.
- `/schedule` — schedule a remote agent.

## Defaults that match this repo

- Prefer `Bun.spawn` / `Bun.$` over `node:child_process`.
- Prefer `bun:sqlite`. Use `db.run`, **not** `db.exec` (deprecated).
- Prefer `node:fs.watch` over chokidar.
- Prefer the `auto` CLI over hand-querying the DB or hand-rolling
  `curl` against the API.
- Prefer extending the existing discriminated unions
  (`supervisor/config.ts` `TriggerSchema`) over inventing new
  parallel types.
- For new API endpoints: extend the typed `api` object in BOTH
  `cli/client.ts` (`ApiClient`) and `ui/src/api/client.ts` so the two
  consumers can't drift, and keep API changes additive.
- For new SSE event types: update `supervisor/sse.ts` callers,
  `cli/sse.ts`, AND `ui/src/api/sseHook.ts` together.
- For UI changes: no `clsx`, no icon libraries, no `date-fns`.
  Tailwind utilities inline; dates via `Intl.DateTimeFormat`.
- A new env var the supervisor needs after a reboot must be added to
  `OPTIONAL_ENV_VARS` in `supervisor/bun-cron-service.ts`, or it silently
  reverts to its default when the OS scheduler restarts the supervisor.
- Every defect fix gets a regression test, in a temp dir and never on
  port 7777.

## Don't surprise the user

- **Don't run the real service commands from a review or fix session:**
  `auto install`, `auto svc install|start|stop|restart|uninstall`,
  `bun scripts/auto-install.ts` (other than `--dry-run`), or anything that
  registers a Bun cron/launchd entry. They change the owner's live
  installation. Use a scratch workspace and `bun supervisor/main.ts`
  directly. Don't read or write `~/.auto/data` (token, secrets, DB) either.
- For a smoke test, use one of
  `test/fixtures/{hello,sleep,leak,hang}-worker.ts` — never wire a real
  side-effecting worker into the config just to try the runner.
- Don't remove `~/.auto/data/` without telling the user — it wipes run
  history, webhook signing secrets and the token.
- Don't `auto svc uninstall` without telling the user — it stops the
  supervisor and removes the watchdog entirely. `auto svc stop` also removes
  the watchdog (so it stays stopped) and `auto svc start` registers it again;
  use that pair for a halt you intend to undo.
- Bun's OS cron API owns service registration. Change lifecycle behavior only
  through [supervisor/bun-cron-service.ts](supervisor/bun-cron-service.ts).
- Don't bind the HTTP server to `0.0.0.0`. Loopback only.
- Don't put the API token into a URL or a log line. The dashboard needs no
  sign-in: the page at `/` embeds the token for allowed Hosts and the SPA
  sends it as a bearer (no cookies, by owner decision); the CLI reads the
  token file. Don't weaken the Host/Origin/proxy gates in
  [supervisor/server.ts](supervisor/server.ts).
- Don't import the dashboard libraries (React, Tailwind) from supervisor or
  CLI code; only `supervisor/ui-bundle.ts` hands `ui/` to the bundler.
  Record any new dependency and why (D-44 lists the current set).
- Don't invent repository, homepage, author or contact values in
  `package.json`, README or SECURITY.md; leave them for the owner.

## Scheduled automations

Machine-specific automations live in `~/.auto/auto.config.ts`, with workers in
`~/.auto/jobs/`. They are outside this engine repository and package. To add a
job, see "Create your first job" in [README.md](README.md).
