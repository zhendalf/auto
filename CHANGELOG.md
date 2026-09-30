# Changelog

All notable changes to Auto are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Auto has not had a
public release yet; the entries below describe the pre-launch hardening pass
relative to the earlier internal builds.

## [Unreleased]

### Breaking changes

- **`GET /events?token=` is removed** (it returns 401). Send
  `Authorization: Bearer <token>`. The `X-Auto-Token` header is no longer
  accepted either; `Authorization: Bearer` is the only credential.
- **`Host` is checked on every route** except `/hooks/*` and `/healthz`. The
  hard-coded `automations.localhost` host is gone; `AUTO_ALLOWED_HOSTS`
  (comma-separated exact `host[:port]` values) replaces it. If you reach the
  dashboard through a proxy name or set `AUTO_BASE_URL` to a custom host, list
  that host and re-run `auto install`. Listing a host serves the API token to
  anyone who can reach it, and the supervisor warns about that at start.
- **A present `Origin` must be an allowed origin** on every route behind the
  `Host` check, for every method (`403 bad_origin`), and a request that
  arrives through a proxy or tunnel while claiming a built-in loopback `Host`
  is refused (`403 proxied_request`).
- **`auto.localhost:<port>` is a built-in dashboard host** alongside
  `127.0.0.1` and `localhost`; it needs no setup because browsers resolve
  `*.localhost` to loopback themselves. (`[::1]` is not a dashboard name: the
  server listens on IPv4 only.)
- **`/healthz` returns only `{"ok": bool, "degraded": bool}`** (200, or 503 when
  degraded). Uptime, job count and reason text are gone.
- **Short run ids changed.** The displayed id is now the last 8 hex characters
  of the run's UUID, not the first 8 (which are timestamp bits and collided
  within about a minute). Any unique prefix or suffix of at least 6 hex
  characters is accepted; ids copied from older output may no longer resolve
  as a short form, but full ids still work.
- **`--force` is only an option of `auto run`.** The global `-f/--force` is
  removed and no longer answers confirmation prompts; use `-y/--yes`.
  `auto cancel` on a running run now asks first unless `-y` is given.
- **Exit codes changed.** `auto run` and `auto log --follow` exit `0` only when
  the run succeeded and `130` on Ctrl-C (previously `0`); a degraded supervisor
  on `auto run` is `1`, not `3`. A supervisor start failure exits `70` or `78`
  instead of `0`.
- **Retention is on by default with a 90 day horizon.** Finished runs older than
  90 days, their logs, skipped-run rows (after at most 14 days) and old webhook
  receipts are deleted permanently, except that the newest 25 real runs of each
  job are always kept. On upgrade, the first sweep runs about a minute after
  the supervisor starts. Set `AUTO_RETENTION_DAYS=0` before `auto install` to
  keep everything.
- **A disabled or paused job, a disabled trigger, or a supervisor that is
  shutting down answers `/hooks/<path>` with `503` and `Retry-After: 60`** (with
  a `reason`), after the signature has been verified, so the sender retries. A
  job with `enabled: false` in the config is no longer scheduled at all, and
  `auto enable` cannot override it.
- **Job names are validated.** 1 to 64 characters of letters, digits, space,
  `.`, `_` or `-`; `:` and `/` are rejected. Config limits are enforced:
  `timeoutMs` and `killGraceMs` up to 2147483647, `queueDepth` up to 1000, cron
  syntax, and every worker and checker file must exist. A config that failed
  none of these before may now be rejected.
- **`log --json`** prints `{run_id, state, lines}` (was `{lines}`); `run --json`
  prints one JSON object per log line and a final summary object.
- **Webhook payloads for ephemeral triggers moved** to
  `data/payloads/ephemeral/`. Kept payloads (`keepPayload: true`) stay in
  `data/payloads/`.
- **Webhook responses changed.** An unknown path, a method other than `POST`, a
  missing, malformed or wrong signature and a trigger whose secret is not set
  all answer the same `401 {"error":"unauthorized"}` (the supervisor log says
  why); only `413` can distinguish a real path, and only with a well-formed
  signature header. While no config has ever loaded (degraded cold start) every
  `/hooks/*` request is `503` with `Retry-After: 60`. A delivery whose body
  digest matches an admitted one within 5 minutes is a duplicate even with a
  different delivery id; a delivery id alone no longer suppresses a request
  with a different body.
- **A token file replaced or deleted on disk takes effect immediately** (the old
  token stops working; a deleted file is replaced by a fresh token), instead of
  only at the next restart.
- **The proxy safety net matches header families** (`X-Forwarded-*`, `Cf-*`,
  `X-Real-*`, `Tailscale-*`, `Ngrok-*`, `X-Envoy-*`, `Cdn-Loop`, `Client-Ip`,
  ...), not a fixed list of seven.
- **`auto runs --state <bad>` exits `2`** and lists the valid states;
  `auto runs --job <unknown>` exits `1`. `auto create --add` exits `1` when it
  could not edit the config. `auto config check` prints a summary line
  (`config valid: 2 jobs, 4 triggers`); `--json` has `jobs`, `triggers`,
  `migrations_pending` and `messages` next to the old `output` and `errors`.
- **`auto enable` on a job with `enabled: false` in the config** exits `1` and
  says to edit the file. `auto ui --json` prints `{"url"}` and opens nothing.
- **`auto data wipe` only removes what Auto created** in the data directory and
  refuses a directory that holds no Auto data.
- **The `db.error` and `degraded.entered` events are gone** from the documented
  and handled event set (nothing ever sent them); `degraded.exited` is now
  really emitted when a degraded supervisor recovers.
- **Cron runs in Auto's own scheduler** and is always machine local time.
  Missed fires while the machine slept are skipped, never replayed.

### Added

- `auto token rotate` and `POST /api/token/rotate`: replace the API token, end
  open event streams, and make the old token stop working. Reload open
  dashboards afterwards; the CLI re-reads the token file by itself.
- `auto create <name> --add [--cron <expr>]`: validates the result and appends
  the job to `auto.config.ts` without ever leaving a broken file.
- `auto jobs` (state, triggers, last run, next run), richer `auto job`,
  `auto runs --state`, `auto log --follow`, `auto secret set --stdin`,
  `auto --version`, `--no-color` and `NO_COLOR`.
- `auto doctor` checks the watchdog entry, token file mode, config, database
  integrity, `PATH` and disk usage, and prints a `fix:` line for each problem.
- `auto init` is safe to re-run and appends missing lines to `.gitignore`.
  `auto install` waits for the supervisor to answer and says how to see why
  when it does not. `auto svc tail` follows `data/state/supervisor.log` on every
  platform.
- Retention sweeper with `AUTO_RETENTION_DAYS` and `AUTO_RETENTION_MIN_RUNS`
  (migration `0003_retention_indexes.sql`, additive).
- Graceful shutdown: every worker's process group is terminated, runs are
  recorded as `killed` with reason `supervisor_shutdown`, and the supervisor
  exits within 15 seconds.
- Crash recovery: on start, runs left `queued` or `running` by a dead
  supervisor are marked failed (`supervisor_interrupted`), and orphaned workers
  are stopped.
- Workers run in their own process group; timeout, cancel and shutdown stop
  the whole tree.
- Runs API: stable paging headers (`X-Next-Before`, `X-Next-Before-Id`), log
  offsets (`?offset=`, `X-Log-Size`, `X-Run-State`), and `before_id`.
- Job API: `config_enabled`, `active_run`, `next_run_at`, trigger details
  (`public_path`, `secret_present`, condition), reload `warnings` and
  `changes`.
- Dashboard: live log following, token-changed and supervisor-down screens,
  connection bar, status panel, dark mode, phone layout, inline confirmations
  and toasts, filters that survive reloads.
- `AUTO_ALLOWED_HOSTS`, `AUTO_RETENTION_DAYS` and `AUTO_RETENTION_MIN_RUNS` are
  baked into the watchdog entry and the CLI shim when set at install time.
- Security headers on every response (CSP, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`), a cap on event subscribers, and
  request-body caps on the API.
- CI workflow on macOS; this changelog; expanded README and SECURITY.md.

### Changed

- `auto ui` prints the dashboard URL and opens it; there is no sign-in step. It
  exits `3` when the supervisor is unreachable and `0` when only the browser
  opener fails. `auto install` and `auto svc start` print a `Dashboard: <url>`
  line.
- The supervisor lock is a JSON file with a pid plus command-line identity
  check, so a stale or reused pid no longer blocks a start. (Earlier notes
  called it `flock`; it never was.)
- Config hot reload evaluates the file in a subprocess and works on every edit;
  an invalid edit is reported and the previous config keeps running. A config
  that could not load at start recovers when it becomes valid.
- Job and trigger changes, and the end of a pause, now reconcile both the cron
  and the webhook adapters by themselves.
- File modes: `data/` and its subdirectories are `0700`; state files, logs,
  the token and `secrets.json` are `0600`. Looser existing modes are tightened
  at start.
- Run logs redact secrets that are split across output chunks, and a full disk
  can no longer stall a worker.
- The worker environment is an allowlist (`PATH`, `HOME`, `USER`, `LANG`,
  `LC_ALL`, `TZ`, `SHELL`, `TMPDIR`) plus the `RUN_ID`, `JOB_NAME`, `JOB_ID`,
  `TRIGGER_*` variables.
- `test:package` now runs the whole test suite.

### Fixed

- A worker's child that ignores `SIGTERM` is now killed with the rest of the
  process group on cancel, timeout, shutdown and crash recovery, even after the
  worker itself has exited. An in-flight condition checker and a config load
  that never finishes no longer outlive the supervisor.
- A queued run no longer starts after its job is set to `enabled: false` (or
  removed) by a config reload while it waited.
- A disabled job whose worker file is gone no longer makes the whole config
  invalid (it is a warning), so a restart no longer comes up degraded for it.
- `data/state/degraded.json` left by a supervisor that died while degraded is
  removed by the next healthy start.
- A malformed `secrets.json` no longer has its content quoted in error
  messages, the terminal or `supervisor.log`.
- Runs carry `skip_reason` in the API, so `auto runs` (WHY column), `auto log`,
  `auto job` and the dashboard say why a run was skipped or ended by the
  supervisor. A refused manual run no longer replaces the last real result in
  `auto jobs`, `auto job` and `auto last`.
- `auto version` reports the version and commit the RUNNING supervisor reports,
  and says when it differs from the checkout.
- The watchdog restart now gives workers the `PATH` from `auto install`, so tools
  found after `auto svc start` are also found after a crash or reboot restart.
- `auto install` and `auto svc` check the loopback port, not `AUTO_BASE_URL`, and
  say to run `auto svc restart` when the supervisor was already running.
- Dashboard: "Load full log" keeps logs between 4 and 8 MiB whole, a large burst
  of output no longer silently discards the view, the status dot no longer says
  "healthy" while the supervisor is unreachable, a pause that runs out refreshes
  the job page at once, and the token-changed warning offers Reload instead of a
  useless retry.
- A bad `AUTO_PORT` or a missing `HOME` gives one clean line instead of a stack
  trace, and `auto --version` and `--help` still work.
- `auto config edit` understands quoted `$EDITOR` values and paths with spaces.
- The dev server for the dashboard never puts the token in a page served to a
  non-loopback `Host`.

- Cron schedules are evaluated in machine local time on every Bun version,
  with defined behavior across daylight saving changes.
- Queue promotion no longer starts a run while another is active, and no longer
  starts a run whose job was disabled or paused while it waited.
- A slow conditional checker can no longer be evaluated twice at once.
- A webhook delivery that was not admitted (overlap, disabled, degraded) can be
  retried by the sender; it is no longer swallowed as a duplicate.
- `auto log <id> | wc -l` and other piped output is no longer truncated.
- `auto secret set` no longer loses concurrent updates.
- A second supervisor on a port that is already served now fails to bind (exit
  `70`) instead of sharing the port on macOS, where the kernel then split
  traffic between the two and the first one's token got `401`.
- The supervisor no longer changes permissions or file modes in a
  `AUTO_DATA_DIR` that holds none of Auto's own files (a mistaken setting such
  as the workspace itself); it warns and leaves those files alone. Inside a real
  data directory only Auto's own entries are tightened.
- A dashboard address for a job whose name ends like a file (`export.json`) now
  loads the dashboard on reload; only real file misses answer `404` JSON.
- A hand-edited, malformed `secrets.json` no longer stalls the supervisor: it is
  parsed once per change instead of sleeping 45 ms on every log chunk and every
  webhook request.
- A worker that exits in time but leaves a background process on its output
  pipes is `succeeded`, not `timed_out`.
- A run cancelled from the dashboard or `auto cancel` is `killed` with the reason
  `cancelled`.
- A supervisor started (or restarted by the watchdog) just after a minute
  boundary still runs that minute's cron fires, once; a fire that a run already
  records is not repeated.
- `commandLineOf` treats a `ps` that rejects its flags (BusyBox) as "unknown",
  so a live supervisor is no longer taken for a dead one there.
- A syntax error in `auto.config.ts` reports the reason and position of each
  error, not only "N errors building"; the missing-secret warning is a whole
  sentence.
- Responses carry `Cross-Origin-Resource-Policy` and `Cross-Origin-Opener-Policy`
  (`same-origin`), and a cross-site subresource request is refused
  (`403 cross_site`). A browser opening the dashboard under a name that is not
  allowed gets a page that says what to do instead of bare JSON.
- CLI: prompts are drawn on stderr (`--json` stays JSON on stdout); a token
  rotated while `auto run` or `auto log --follow` is running is picked up; a slow
  supervisor is reported as slow (exit `1`), not as absent, and `auto config
  reload` waits up to 30 s; `auto version` says `config error` instead of
  `degraded` for a rejected edit; `auto config status` exits `1` for a rejected
  config or a degraded supervisor; `auto run | head` keeps the run's exit code;
  printed hints quote job names with spaces; `auto create` without a workspace
  says to run `auto init`; `--base-url` without a scheme and `--token-file`
  without a value are usage errors; an ambiguous run id lists the short ids;
  `auto log --json` of a run without a log prints JSON; `auto job` and
  `auto doctor` word webhook and warning details clearly; `auto config edit`
  with a missing editor reports it once.
- Dashboard: a "not started" or "supervisor is not running" note goes away when
  it stops being true; a job removed from the config shows that it was removed
  instead of live controls; the runs text filter no longer overwrites a job or
  state chosen while typing; skipped and cancelled runs show their reason in the
  runs table; a log trimmed while following can still be loaded in full;
  focus stays on the page after Disable, Enable and navigation.
- `bun supervisor/main.ts --help` prints the usage.
