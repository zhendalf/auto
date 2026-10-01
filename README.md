# Auto

Local-first automation for scripts you actually care about.

Auto turns ordinary TypeScript and JavaScript files into dependable scheduled jobs, with run history, captured logs, overlap controls, signed webhooks, condition-based triggers, a CLI, and a local dashboard.

It runs on your machine. There is no hosted control plane, no account to create, and no job history uploaded elsewhere.

> **Status:** Auto is preparing for its first public prerelease. macOS is the only verified host. On Linux and Windows the supervisor is registered through Bun's OS scheduler integration (crontab, Task Scheduler), but that path is implemented and untested: treat it as experimental until clean-install and reboot-recovery checks exist for those systems.

## Why Auto?

Cron is excellent at starting commands. It is less helpful when you need to know:

- Did the job run, and what did it print?
- What happens when two runs overlap?
- Can I pause one job or trigger without editing its schedule?
- Can I act only when something has actually changed?
- Can a webhook start a job without exposing a general-purpose API?

Auto supplies those operational pieces while keeping workers simple and directly runnable.

## What you get

- Five-field cron schedules in the machine's local timezone
- Manual runs from the CLI or dashboard
- Conditional schedules that act only on state changes
- HMAC-SHA256 webhook triggers with durable deduplication
- SQLite run history and per-run stdout/stderr logs, pruned automatically (90 days by default)
- `drop`, `queue`, and `parallel` overlap policies
- Timeouts, graceful cancellation, and bounded log capture; every worker runs in its own process group, so a timeout or cancel also stops the processes it spawned
- Crash recovery: runs interrupted by a supervisor crash or restart are closed out as failed on the next start, and orphaned workers are stopped
- Per-job and per-trigger enable, disable, and pause controls
- Live dashboard updates over server-sent events
- Local secrets with exact-value log redaction
- An API bound only to `127.0.0.1`, protected by a bearer token, with Host and Origin checks and no sign-in step for the dashboard
- Automatic startup and restart through Bun's OS scheduler

## Install

Auto is developed and tested on [Bun](https://bun.sh/) 1.4. `package.json` allows 1.3 or newer, but nothing older than 1.4 is tested, and `auto doctor` warns on it.

The package is not published yet. Once the first prerelease is available, setup will be:

```bash
bun add --global auto-supervisor
auto init
auto config check
auto install
auto doctor
auto ui
```

- `auto init` creates a user-owned workspace at `~/.auto` with a starter config and a `hello-world` job. It is safe to run again: it only creates what is missing.
- `auto config check` validates `auto.config.ts` without needing the supervisor.
- `auto install` registers a once-a-minute watchdog with the operating system, starts the supervisor now, and waits until it answers. If it does not come up, the command fails and points you at `auto svc tail`.
- `auto doctor` checks the installation and prints one `fix:` line for every problem.
- `auto ui` prints the dashboard URL and opens it. There is nothing to sign in to: `http://127.0.0.1:7777/` works in any browser on the machine, and so does `http://auto.localhost:7777/` (with the port you configured). See [Security model](#security-model) for what that implies.

To try the current source checkout instead:

```bash
git clone https://github.com/zhendalf/auto.git ~/.auto-engine
cd ~/.auto-engine
bun install --frozen-lockfile
AUTO_HOME="$HOME/.auto" bun cli/main.ts init
AUTO_HOME="$HOME/.auto" bun scripts/auto-install.ts
```

`scripts/auto-install.ts` runs `bun install --frozen-lockfile` for the root and `ui/`, builds the dashboard, validates the configuration, registers the watchdog, writes an `auto` shim to `~/.local/bin` (add that directory to your `PATH` if it is not there already), starts the supervisor, and waits for it to answer. Run `init` first, as above: the installer's configuration check needs a workspace. Pass `--dry-run` to print the commands it would run without registering anything.

## Create your first job

The starter workspace includes `jobs/hello-world.ts`:

```ts
console.log(`Hello from Auto at ${new Date().toISOString()}`);
```

Its `auto.config.ts` entry is ordinary data:

```ts
export default [
  {
    id: "hello-world",
    name: "hello-world",
    description: "Print a friendly message every morning.",
    worker: "./jobs/hello-world.ts",
    triggers: [
      { kind: "cron", id: "morning", schedule: "0 9 * * *" },
    ],
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 60_000,
    killGraceMs: 10_000,
    enabled: true,
  },
];
```

Validate and run it:

```bash
auto config check
auto run hello-world
auto last hello-world
```

Add another job with one command; it writes the worker, appends the entry to `auto.config.ts` only if the result still validates, and the running supervisor picks it up:

```bash
auto create weekly-report --add --cron "0 8 * * 1"
```

`auto create` needs a workspace: without `auto.config.ts` it says to run `auto init` and creates nothing. Without `--add` it writes the worker and prints the config entry to paste. With `--add` on a config that does not end in the plain `export default [ ... ];` shape it cannot edit the file: it prints the entry, keeps the worker, and exits `1`. Auto watches the configuration and applies valid changes without a restart.

### Hot reload

The supervisor evaluates `auto.config.ts` in a short-lived Bun subprocess every time the file changes (and on `auto config reload` or `POST /api/config/reload`). A fresh process is used because Bun caches imported modules, which would hide edits. Consequences:

- The config file is real code that runs with your user's authority on every reload. Keep it free of side effects; it may import other files from the workspace, but only edits to `auto.config.ts` itself trigger a reload. After changing a file it imports, touch the config (`touch ~/.auto/auto.config.ts`) or run `auto config reload`.
- The default export must be plain data (no functions, symbols, or cycles).
- A config that fails validation is rejected as a whole (a missing worker or checker file counts, but only for jobs that are enabled; for a job with `enabled: false` it is a warning in `auto config status`): the previous version keeps running, `auto config status` and the dashboard show the error, and the next valid save recovers. The same validation runs for `auto config check` and at supervisor start.
- Atomic-rename saves (most editors), a deleted and recreated file, and a missing directory at start are all handled. A cold start with a broken or missing config runs in a degraded mode (HTTP up, nothing scheduled, `/healthz` answers 503) and recovers when the file becomes valid.

## Workers are just programs

A worker is a TypeScript or JavaScript file. It does not import Auto or access Auto's database. The runner always executes it as `bun <worker>`; there is no shebang or executable-bit handling, so a shell script must be wrapped by a small `.ts` file that spawns it.

```ts
const response = await fetch("https://example.com/health");
if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
console.log("Service is healthy");
```

Run it directly while developing:

```bash
bun ~/.auto/jobs/check-service.ts
```

Then let Auto handle scheduling, admission, timeouts, logging, and history. What a worker sees:

- **Working directory:** the workspace root (`~/.auto`), not the job's folder.
- **Environment:** only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `SHELL`, and `TMPDIR` (plus a few system variables on Windows) are passed through from the supervisor, together with `RUN_ID`, `JOB_NAME`, `JOB_ID`, `TRIGGER_KIND`, `TRIGGER_ID`, and `TRIGGER_META` (JSON). Authenticated webhook workers also receive `TRIGGER_PAYLOAD_PATH`. Put anything else the worker needs in a file it reads itself.
- **Secrets:** Auto does not inject stored secrets into workers. They exist to verify webhook signatures.
- **Standard input:** closed.
- **Output:** stdout and stderr go to the run log, capped at 5 MiB per run (a truncation marker records how much was dropped).
- **Exit:** exit code 0 is success. A timeout sends `SIGTERM` to the worker's process group and `SIGKILL` after `killGraceMs`. Background processes a worker leaves behind after a normal exit are not killed.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `auto init` | Create a workspace and starter job |
| `auto create <name> [--cron <expr>] [--add]` | Scaffold a worker file; `--add` also appends the config entry |
| `auto install` | Register and start the supervisor |
| `auto jobs` | List jobs with state, triggers, last run, and next run |
| `auto job <job>` | Inspect a job, its triggers, and recent runs |
| `auto runs [--job <job>] [--state <state>] [-n <N>]` | Show recent runs |
| `auto run <job> [--force]` | Start a job manually and follow its output (`--force` also starts a job that is disabled or paused, or already running) |
| `auto last <job>` | Show the latest result and log |
| `auto log <run-id> [--follow]` | Print a run's log, or follow a running job |
| `auto pause <job> [1h]` | Temporarily pause a job (`off` resumes it) |
| `auto enable <job>` / `auto disable <job>` | Change runtime job state (`enabled: false` in `auto.config.ts` is not overridden: edit the file) |
| `auto trigger enable\|disable <job:trigger>` | Change one trigger's runtime state |
| `auto cancel <run-id or job>` | Cancel a queued or running run (asks first unless `-y`) |
| `auto config check\|status\|reload\|edit` | Validate, inspect, reload, or edit the configuration |
| `auto secret list\|set\|remove` | Manage webhook signing secrets (values are never shown) |
| `auto doctor` | Diagnose the local installation |
| `auto ui` | Open the dashboard in your browser (`--json` prints `{"url"}` and opens nothing) |
| `auto token rotate` | Replace the API token (reload open dashboards afterwards) |
| `auto svc install\|uninstall\|start\|stop\|restart\|tail` | Control the supervisor and its OS watchdog |
| `auto data wipe` | Delete run history, logs, secrets, and the token (destructive; only removes what Auto created in the data directory) |
| `auto --version` / `auto version` | Print the CLI version (`version` also shows the version the running supervisor reports, and Bun) |

Run ids are shown as the last 8 hex characters of the run's UUID. Any unique prefix or suffix of at least 6 hex characters works wherever a run id is accepted, and `auto` tells you when a fragment is ambiguous.

Global options: `--json` keeps stdout machine-readable and sends status messages and confirmation prompts to stderr; `-y/--yes` answers confirmation prompts; `--no-color` (or `NO_COLOR`) disables color; `--base-url` and `--token-file` point the CLI at a different supervisor. `--force` exists only on `auto run`.

Exit codes: `0` success; `1` error, or the run did not succeed; `2` usage error; `3` the supervisor is unreachable; `4` `auto run` found another run of the job in progress (use `--force`); `130` interrupted with Ctrl-C while following a run (the run keeps going). `auto config status` exits `1` when the last config edit was rejected or the supervisor is degraded, so a script can test it; a supervisor that accepts the connection but does not answer in time is reported as slow with exit `1`, not `3`. `auto run <job> | head` keeps the run's own exit code when the reader closes the pipe early. Run `auto --help` and `auto <command> --help` for the complete reference.

## Trigger types

### Cron

```ts
{ kind: "cron", id: "weekday-morning", schedule: "0 9 * * 1-5" }
```

Schedules are five fields (`minute hour day-of-month month day-of-week`) or one of `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`. Names (`MON`, `JAN`), lists, ranges, and steps are supported.

- **Time zone:** always the machine's local time zone, regardless of Bun version.
- **Day matching:** when both day-of-month and day-of-week are restricted, a day matches if either matches (standard cron). `0 0 1 * MON` means the 1st and every Monday.
- **Daylight saving:** a wall-clock time that does not exist (spring forward) fires once, shifted by the length of the gap. A wall-clock time that happens twice (fall back) fires once, at the first occurrence; schedules with a wildcard hour (`*`, `*/n`) also fire in the repeated hour, so "every hour" keeps its rhythm.
- **Missed fires:** if the machine sleeps or the supervisor stalls, fires that were missed are skipped, not replayed. Auto resumes at the next scheduled time after waking, with no catch-up burst. A fire at most one minute late still runs, once. That includes the first arm after the supervisor starts: a start (or watchdog restart) a moment after a minute boundary still runs that minute's fire, unless a run for exactly that fire is already recorded, so a graceful restart right after a run does not repeat it.

### Conditional cron

Poll cheaply, but run the action only when a checker reports a meaningful transition:

```ts
{
  kind: "cron",
  id: "release-watch",
  schedule: "*/5 * * * *",
  condition: {
    checker: "./jobs/release-watch/check.ts",
    timeoutMs: 30_000,
  },
}
```

The checker reads one JSON document from stdin and writes exactly `{ fire, state?, meta? }` as JSON to stdout. Quiet checks update their baseline without cluttering run history. Fired state advances only after the action succeeds, so failures do not silently consume events. A checker slower than the schedule period is not started twice: overlapping evaluations of the same trigger are suppressed.

### Signed webhooks

```ts
{
  kind: "webhook",
  id: "github-release",
  path: "github-release",
  auth: {
    profile: "hmac-sha256",
    secretRef: "github-release-webhook",
    signatureHeader: "x-hub-signature-256",
    signaturePrefix: "sha256=",
  },
  deliveryIdHeader: "x-github-delivery",
}
```

Set the signing secret without putting it in config or shell history:

```bash
auto secret set github-release-webhook
```

Auto verifies the exact request bytes, rejects invalid signatures, and deduplicates repeated deliveries before invoking the worker. External ingress is deliberately not bundled; expose only the required `/hooks/<path>` route through a tunnel or reverse proxy you control.

`POST /hooks/<path>` behaves as follows:

- **Size limit:** `maxBodyBytes` (default 1 MiB, at most 10 MiB) is enforced while the body streams. Larger requests get `413`.
- **Uniform failure:** an unknown path, a method other than `POST`, a missing, malformed, or wrong signature, and a trigger whose secret is missing or unreadable all answer the same `401 {"error":"unauthorized"}`, so an unauthenticated caller learns neither which paths exist nor which secrets are set (the supervisor logs why a signed delivery could not be checked, for example a secret that is not set). The one exception is `413`, which needs a well-formed signature header and an oversize body. Before any config has ever loaded (a degraded cold start) every `/hooks/*` request answers `503` with `Retry-After: 60` instead.
- **Content type:** must be in `contentTypes` (default `application/json`), otherwise `415`. The check runs after the signature.
- **Deduplication:** a delivery is a duplicate if its body has the same SHA-256 digest as an admitted delivery within the last 5 minutes, or if the same delivery id (from `deliveryIdHeader`) arrived with the same body before, at any age. A delivery id alone never suppresses a delivery with a different body. Duplicates get `202` with `"duplicate": true` and the original run id.
- **Replay limits:** the delivery-id header is not covered by the signature, and the HMAC scheme carries no signed timestamp. A captured request can therefore be replayed after the 5-minute window, a sender that legitimately posts an identical body twice within 5 minutes with different delivery ids has the second one dropped, and a retry that changes the body counts as a new delivery. If a provider signs a timestamp, verify it inside the worker.
- **Status mapping:** `202` with `receipt_id`, `run_id`, and `disposition` (`started` or `queued`) means authenticated and admitted, not that the action succeeded. `202` with `"status": "skipped"` and a `reason` (`overlap`, `queue_full`) means the job's own overlap policy dropped it; nothing is recorded for retry. `503` with `Retry-After: 60` means the supervisor is degraded or could not store the delivery, and the sender should retry. A job that is disabled or paused, or whose trigger is disabled, or a supervisor that is shutting down, answers `503` with `Retry-After: 60` and a `reason` (`disabled`, `paused` or `shutdown`); the delivery is not recorded, so the sender can retry it once the job is back. These answers come only after the signature has been verified.
- **Records:** a receipt is stored only once a run exists, so a delivery that was not admitted can be retried. Payload files are deleted after the run unless the trigger sets `keepPayload: true`.

## Local by design

Auto separates portable definitions from machine-local runtime state:

```text
~/.auto/
├── auto.config.ts            # jobs and triggers; safe to version intentionally
├── jobs/                     # directly runnable workers
├── .auto-runtime/            # generated watchdog entry; ignored
└── data/                     # private machine-local state; ignored (mode 0700)
    ├── automations.db        # SQLite history (plus -wal and -shm files)
    ├── .token                # API token
    ├── secrets.json          # webhook signing secrets, plaintext
    ├── supervisor.lock       # singleton lock
    ├── runs/YYYY/MM/DD/      # one <run_id>.log per run, by local start date
    ├── payloads/             # webhook bodies (ephemeral/ is swept automatically)
    └── state/
        ├── supervisor.log    # supervisor stdout and stderr (rotated at 5 MB)
        ├── degraded.json
        ├── last-error.txt
        └── notified.json
```

Configuration and workers may be stored in Git. Tokens, secrets, logs, history, condition state, webhook receipts, and runtime overrides should not be committed; `auto init` adds `data/` and `.auto-runtime/` to the workspace `.gitignore`.

Cloning the same definitions onto another computer creates an independent installation. Auto does not silently synchronize state or coordinate execution between machines; if a job is enabled on two machines, both may run it.

### Environment variables

Advanced layouts can set these before running `auto install`:

| Variable | Meaning | Default |
| --- | --- | --- |
| `AUTO_HOME` | Workspace directory | `~/.auto` |
| `AUTO_CONFIG` | Config file | `$AUTO_HOME/auto.config.ts` |
| `AUTO_DATA_DIR` | Data directory | `$AUTO_HOME/data` |
| `AUTO_PORT` | Loopback port | `7777` |
| `AUTO_ALLOWED_HOSTS` | Extra exact `Host` values for the dashboard and API, comma separated | none |
| `AUTO_RETENTION_DAYS` | Run history horizon; `0` keeps everything | `90` |
| `AUTO_RETENTION_MIN_RUNS` | Newest real runs per job that are never pruned | `25` |

The OS scheduler starts the supervisor with a bare environment, so the installer bakes the resolved workspace, data, and port settings into the generated watchdog entry (`.auto-runtime/supervisor.ts`) and the source-install CLI shim. `AUTO_ALLOWED_HOSTS`, `AUTO_RETENTION_DAYS`, and `AUTO_RETENTION_MIN_RUNS` are baked in only if they are set when you run `auto install` (or `scripts/auto-install.ts`); to change one later, set it, run `auto install` again, and then `auto svc restart`, because `auto install` does not restart a supervisor that is already running. The watchdog entry also records the `PATH` you ran `auto install` with, so workers that call tools by name (`gh`, `jq`, `node`) find them after a crash or reboot restart exactly as they do after `auto svc start`; run `auto install` again if your `PATH` changes. Use a distinct `AUTO_PORT` for each concurrently running workspace.

Two more variables affect a single process only and are not baked in: `AUTO_BASE_URL` (where the CLI looks for the supervisor, default `http://127.0.0.1:$AUTO_PORT`; `auto install` and `auto svc` always check the loopback port, whatever this says) and `AUTO_NOTIFY=0` (turns off desktop notifications for startup failures).

### Retention

A sweeper runs 60 seconds after the supervisor starts and then every 6 hours. Pruning is permanent; there is no trash.

- Finished runs older than `AUTO_RETENTION_DAYS` (default 90) are deleted together with their log files. The newest `AUTO_RETENTION_MIN_RUNS` (default 25) real runs of each job are always kept, however old, so a job that rarely runs never loses its history. Skipped runs do not count toward that floor.
- Skipped runs (fires dropped by overlap, pause, and so on) are only bookkeeping and expire after at most 14 days.
- Queued and running runs are never touched.
- Webhook receipts are kept for at least 7 days (or the run horizon, if longer), and never inside the 5-minute dedupe window. Their stored payloads go with them.
- Log or payload files that no database row refers to any more are removed once they are older than the horizon, and empty date directories are cleaned up.
- `AUTO_RETENTION_DAYS=0` turns the sweeper off entirely. Invalid values fall back to the defaults with a warning in the supervisor log. A pruned run returns `404` from the API.

## Security model

Auto is for one trusted user on one machine. Read [SECURITY.md](SECURITY.md) for the full threat model; the essentials:

- The HTTP server binds only to `127.0.0.1`. Never expose that port beyond loopback.
- **CLI and API:** every `/api` call and the `/events` stream carry the generated 256-bit token (`data/.token`, mode `0600`) as `Authorization: Bearer <token>`. Nothing else is accepted: no cookie, no `X-Auto-Token` header, no `?token=` query parameter.
- **Dashboard:** there is no sign-in and no session. The page served at `/` embeds the token in a JSON block (`<script id="auto-bootstrap" type="application/json">`) and the dashboard sends it as a bearer, exactly like the CLI. The page is served only when the request's `Host` header is allowed: `127.0.0.1:<port>`, `localhost:<port>`, `auto.localhost:<port>`, or an entry in `AUTO_ALLOWED_HOSTS`. Any other `Host`, or a missing one, gets `403` (a browser opening such a name gets a short page that says what to do; `[::1]` is not served because the supervisor listens on IPv4 only).
- **What that means:** anything that can open a TCP connection to `127.0.0.1:<port>` can fetch `/` and read the token, so every local process and every local user can control Auto. That is the accepted tradeoff for a dashboard that just opens. Do not run Auto on a shared multi-user machine.
- **Web pages cannot use it.** A `Host` check blocks DNS rebinding, a present `Origin` must be one of the allowed origins (otherwise `403`, for every method), no response carries CORS headers, every response says `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`, a request that a browser marks as coming from another site and as anything but a top-level navigation (`Sec-Fetch-Site` and `Sec-Fetch-Dest`: a `<script>`, `<img>`, `fetch`) is refused (`403 cross_site`), and the page cannot be framed (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`). `auto.localhost` needs no DNS: browsers resolve every `*.localhost` name to loopback themselves, so it cannot be rebound. If a browser or tool on your machine does not resolve it, use `127.0.0.1`.
- **Requests that came through a proxy are refused.** When the `Host` is one of the built-in loopback names and the request carries any proxy or tunnel header, the answer is `403`. Whole families are matched: every `X-Forwarded-*`, `X-Real-*`, `Cf-*`, `Tailscale-*`, `Ngrok-*` and `X-Envoy-*` header, plus `Forwarded`, `Via`, `Cdn-Loop`, `Client-Ip`, `X-Client-Ip`, `True-Client-Ip`, `Fastly-Client-Ip`, `X-Original-Forwarded-For` and `X-Original-Forwarded-Host`. This is a safety net, not a guarantee: a proxy that rewrites `Host` and adds none of those headers is not detected. Never point a tunnel at `/`; forward only `/hooks/<path>` (see below).
- **Rotating or revoking the token:** `auto token rotate` writes a new token file, makes the old token stop working immediately, and closes open event streams. Replacing `data/.token` by hand does the same: the supervisor notices the change at the next request, and deleting the file makes it mint a fresh token (a file that does not hold a 64-character hex token is ignored, and the current token stays). Reload open dashboards (the page then embeds the new token); the CLI re-reads the token file by itself. Scripts that cached the token must re-read `data/.token`. The dashboard tells you to reload when it sees the old token rejected.
- Only the dashboard bundle (built in memory at start) is served as static files, and every response carries a strict Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. The page at `/` is `Cache-Control: no-store`.
- Webhooks use per-trigger HMAC secrets, streamed body-size limits, and content-type allowlists. `/hooks/*` and a minimal `/healthz` are the only routes that skip the `Host` check.
- Workers run as the current user and have that user's operating-system access, including the token and `secrets.json`.
- `data/` and its directories are mode `0700`; state files, logs, the token, and `secrets.json` are `0600`. `secrets.json` remains plaintext on disk. Use full-disk encryption and protect backups.
- **Redaction limits:** run logs replace the exact value of every stored secret with `[redacted:<name>]`, including when a value is split across output chunks. Secrets shorter than 4 characters are not redacted, and modified forms (base64, URL-encoded, substrings) are not caught. Redaction applies to captured run logs, not to the supervisor's own log.

### Reaching the dashboard under another name

To use a name other than the four built-in ones (for example a hostname on a private network or VPN, in front of the loopback port), list the exact `Host` value the proxy forwards, set the same URL for the CLI, and re-run `auto install` (then `auto svc restart`, so the running supervisor picks the name up) so the setting survives restarts:

```bash
export AUTO_ALLOWED_HOSTS=<host>[:<port>]      # the exact Host header the proxy sends
export AUTO_BASE_URL=http://<host>[:<port>]    # so `auto ui` opens this URL
auto install
auto svc restart
auto ui
```

Listing a host hands the API token to **anyone who can reach that name**, so the supervisor prints a warning at start. Use it only behind a proxy or VPN that already restricts who can connect, and never with a public tunnel. The proxy must pass the `Host` header through unchanged. Do not publish the dashboard or `/api` on a public address.

See [SECURITY.md](SECURITY.md) for the threat model, reporting, and deployment guidance.

## Logs

- **Run logs:** `~/.auto/data/runs/YYYY/MM/DD/<run_id>.log`, created `0600`; read them with `auto log <run-id>` or `auto last <job>`.
- **Supervisor log:** `~/.auto/data/state/supervisor.log` (rotated to `supervisor.log.1` at 5 MB). `auto svc tail` follows it, and also prints where the host scheduler keeps its own logs (on macOS, `/tmp/bun.cron.<title>.stdout.log` and `.stderr.log`).

## Troubleshooting

Start with `auto doctor`; it exits `1` if any check fails and prints a `fix:` line for each problem.

| Doctor check | If it fails |
| --- | --- |
| Bun version | `bun upgrade` |
| Workspace | `auto init` |
| Watchdog registered | `auto install` |
| Watchdog entry | The checkout moved or was deleted; run `auto install` again to rewrite the entry |
| Supervisor reachable | First time: `auto install`. Otherwise `auto svc start`; if a supervisor is running but not answering, read `auto svc tail`. Degraded (warning): `auto config status` shows the config error |
| Token file | `auto install`, or `chmod 600` the file if the mode is loose |
| Config valid | Fix the errors, then `auto config check`; missing webhook secrets: `auto secret set <name>` |
| Database | Stop the supervisor, back up `data/automations.db`, then `auto data wipe` to start fresh |
| Disk usage (warning above 1 GB) | Lower `AUTO_RETENTION_DAYS`, or `auto data wipe` |

Other things to know:

- `auto svc tail` is the first place to look when the supervisor does not start. Startup failures exit non-zero: `78` when the database was migrated by a newer Auto, `70` for other failures such as an unreadable database or a port that cannot be bound (`bun supervisor/main.ts --check` exits `78` for an invalid configuration; a normal start with a bad configuration runs degraded instead). On macOS they also raise a desktop notification, at most once every 6 hours per distinct problem.
- A second supervisor is refused: the singleton lock records the holder's pid and command line, so a stale lock left by a crash or a reused pid is taken over automatically.
- After a crash, `kill -9`, or power loss, the next start closes out runs that were queued or running as failed (reason `supervisor_interrupted`), notes it in their logs, and stops workers that are still alive.
- Stopping (`auto svc stop`, SIGTERM) gives running workers up to 10 seconds, then force-kills them; runs that were still active are recorded as `killed` with reason `supervisor_shutdown`. The supervisor exits within 15 seconds.
- `auto svc stop` also removes the OS watchdog so the supervisor stays stopped; `auto svc start` registers it again. `auto svc restart` waits for the old supervisor to exit before starting a new one.
- The dashboard says "The API token changed": someone ran `auto token rotate` (or replaced or deleted `data/.token`). Reload the page.
- The dashboard or `curl` answers `403`: the `Host` header is not allowed. Use `http://127.0.0.1:<port>/`, `http://localhost:<port>/` or `http://auto.localhost:<port>/`, or list the name in `AUTO_ALLOWED_HOSTS`. A `403` for a request that went through a proxy is the proxy-header refusal described under [Security model](#security-model).
- The port is taken: choose another with `AUTO_PORT` and run `auto install` again.
- `auto enable <job>` says the job is still disabled: `auto.config.ts` sets `enabled: false` for it. Edit the file; the runtime flag cannot override it.
- A run shows as `skipped` or `failed` with no output: `auto runs` has a WHY column, and `auto log <run>` names the reason (`disabled`, `paused`, `overlap`, `queue_full`, `supervisor_interrupted`, `supervisor_shutdown`, `spawn_error`).
- A cron trigger did not fire while the laptop was asleep: this is by design (see [Cron](#cron)).

## Upgrade and uninstall

**Upgrade.** Install the new version (`bun add --global auto-supervisor@latest`, or `git pull` in a source checkout), then run `auto install` again. It rewrites the watchdog entry and, in a source checkout, `scripts/auto-install.ts` also refreshes dependencies. Restart the supervisor with `auto svc restart` to run the new code. Database migrations are additive and apply at the next supervisor start; a database that has been migrated by a newer Auto is refused by an older one, so back up `data/` before installing an older version. Your configuration and workers are untouched.

**Uninstall.** Run `auto svc uninstall` to stop the supervisor and remove the OS watchdog. It leaves `data/` and the `auto` shim alone. To remove everything else: delete the shim (`~/.local/bin/auto`) for a source install or run `bun remove --global auto-supervisor`, and delete the workspace (`~/.auto`) if you no longer need the configuration, workers, or history. Back up `data/` first if the history matters.

## Architecture

One long-running Bun supervisor owns scheduling, trigger admission, subprocess execution, SQLite history, the loopback API, and the dashboard. A Bun OS-level cron entry checks once per minute that the supervisor is alive and starts it if not. Each job invocation runs as a separate subprocess in its own process group, so workers remain isolated from supervisor memory and can be tested directly.

The dashboard and CLI use the same API. Runtime state is stored in SQLite; definitions remain in `auto.config.ts`.

## Configuration reference

| Field | Meaning |
| --- | --- |
| `id` | Lowercase identifier (`a-z`, `0-9`, `-`); unique. A label shown in the API; it does not key the job |
| `name` | The job's identity: unique, 1 to 64 characters, letters, digits, space, `.`, `_`, `-` (no `:` or `/`). Renaming a job starts a new history |
| `description` | Optional human-readable purpose |
| `worker` | Workspace-relative path beginning with `./`, without `..`; a file Bun can run. Must exist |
| `triggers` | One or more cron or webhook triggers |
| `reentrancy` | `drop` (default), `queue`, or `parallel` |
| `queueDepth` | Maximum waiting runs when queueing (default 1, at most 1000) |
| `timeoutMs` | Worker timeout before termination (default 600000, at most 2147483647) |
| `killGraceMs` | Grace between termination and forced kill (default 10000, at most 2147483647) |
| `enabled` | Definition-level state. A job with `enabled: false` is not scheduled, its webhook answers `503`, and `auto enable` cannot override it; its worker file may be missing without invalidating the config. `auto run --force` still starts it once |

Webhook trigger fields: `path`, `auth` (`profile`, `secretRef`, `signatureHeader`, `signaturePrefix`), optional `deliveryIdHeader`, `contentTypes`, `maxBodyBytes`, and `keepPayload`. Cron trigger fields: `schedule` and an optional `condition` (`checker`, `timeoutMs`, at most 300000).

## Development

```bash
bun install --frozen-lockfile
bun run verify
bun pm pack --dry-run
```

`bun run verify` runs the root and UI typechecks and the full test suite. The suite starts real supervisors on fixed local ports, so do not run two copies at once.

There is no build step. The supervisor bundles the dashboard in `ui/` (React and Tailwind) in memory with Bun's bundler when it starts, so a git install serves the dashboard as it is. To work on the dashboard, run a scratch supervisor with `AUTO_UI_DEV=1`; it bundles again after every change under `ui/`, and you reload the page to see it:

```bash
AUTO_HOME=/tmp/auto-dev bun cli/main.ts init
AUTO_HOME=/tmp/auto-dev AUTO_PORT=17800 AUTO_UI_DEV=1 bun supervisor/main.ts
```

Then open `http://127.0.0.1:17800/`. Use a scratch `AUTO_HOME` and port so a development supervisor never shares data or a port with the one you rely on.

The package contains the supervisor, the CLI and the dashboard source. See [AGENTS.md](AGENTS.md) for contributor conventions and [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

This repository contains only the distributable engine and its tests. Live
configuration, personal workers, secrets, history, and runtime state belong in
the separate `~/.auto` workspace.

## Project status

Before the first public prerelease:

- add clean-machine install, reboot, upgrade, and uninstall tests on macOS;
- add Linux and Windows lifecycle verification;
- establish the canonical repository URL, package publisher, and private security-reporting channel;
- publish release notes and a migration policy.

File-watch triggers and shell completion remain planned enhancements.

## License

[MIT](LICENSE)
