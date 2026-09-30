# Q-09 — What does the supervisor do when it can't run?

## Context

Q-01 settled "supervisor as LaunchAgent with `KeepAlive=true`" but
flagged: "If it exits cleanly after setup or on config error,
launchd will repeatedly restart it unless you define failure behavior
carefully."

This question pins down what the supervisor actually does in each
failure mode it might face, so we don't end up in a crash-loop that
hides the real issue.

Failure modes to address:
1. **Bad `automations.config.ts`** (syntax error, type error, import
   failure on first load).
2. **Bad config on hot reload** (file changed while supervisor is
   running, but new content is broken).
3. **DB migration failure** on startup (broken SQL, schema drift,
   permission issue).
4. **Port already in use** (`127.0.0.1:7777` taken — could be
   another instance, an ngrok process from yesterday, etc.).
5. **Worker subprocess can't be spawned** (worker file missing,
   permission, Bun binary not on PATH).
6. **DB write failure mid-flight** (disk full, file deleted out
   from under us).
7. **Supervisor itself OOMs / crashes hard** (handled by launchd,
   but with what throttle?).

## Recommendations per mode

### 1. Bad config on first load (cold start)

- **Action:** supervisor starts in *degraded mode*. HTTP server is
  up. `/api/config/status` reports the error. UI shows a banner.
  No triggers are wired up. Manual run is disabled (no jobs known).
- **Why:** crash-looping on bad config produces no UI to see the
  error from. Better to keep the supervisor up and surface the
  failure.
- `/healthz` returns 503 with body indicating degraded mode (so
  external monitoring can detect this).

### 2. Bad config on hot reload (warm)

- **Action (already decided in Q-05):** keep last-known-good config
  active. Surface error via SSE event `config.error` and through
  `/api/config/status`. UI shows banner. **Do not** tear down
  working triggers.
- New runs continue under old config until the user fixes the file.
- Reload retries on next file modification.

### 3. DB migration failure

- **Action:** supervisor refuses to start, exits with code 78
  (EX_CONFIG). `StandardErrorPath` from launchd plist captures the
  error. `~/.automations/data/migration-error.log` written with
  full diagnostic.
- **launchd `ThrottleInterval=300`** (5 min) prevents tight
  crash-loop. After 5 retries with the same migration error,
  supervisor exits with code 70 and we rely on a `terminal-notifier`
  ping ("supervisor cannot start: see migration-error.log").
- **Why:** unlike config, DB migrations are operationally critical
  *to be correct*. Running with old schema would corrupt history.

### 4. Port in use

- **Action:** supervisor checks if it's another instance of itself
  (PID file at `data/supervisor.pid` — read PID, check if process
  exists with our binary path). If yes, exit 0 (silent — launchd
  thinks we ran successfully and goes back to sleep until next
  KeepAlive cycle).
- If different process owns the port: log error, retry every 30s
  for 10 minutes (in-process retry, not crash-loop), then exit 75
  (EX_TEMPFAIL) and trust launchd ThrottleInterval to hold off.

### 5. Worker can't spawn

- **Per-run failure**, not supervisor failure. Run row gets
  `state=failed`, `exit_code=null`, `signal=null`,
  `skip_reason=spawn_failed`, log file contains the spawn error.
- Subsequent runs are unaffected. UI shows the failure prominently
  on the job's recent runs list.
- After N consecutive spawn failures (default 5), trigger is
  auto-disabled with reason `spawn_failures` and a notification
  fires. Re-enable via UI/CLI.

### 6. DB write failure mid-flight

- **Action:** log to stderr, push an SSE `db.error` event, attempt
  to write a marker file `data/db-error.flag` (best-effort). If the
  DB is genuinely unwritable, supervisor exits 75 (EX_TEMPFAIL) and
  launchd restarts it after `ThrottleInterval`.
- **Why not crash immediately?** Disk-full and similar conditions
  can be transient or self-correcting (after a log-rotate cron
  fires elsewhere). 75/EX_TEMPFAIL signals "try again later," which
  is what we mean.

### 7. Supervisor crash (hard fault, panic, OOM)

- **launchd handles it.** `KeepAlive=true` restarts. Set
  `ThrottleInterval=10` (seconds) for default; macOS actually
  enforces a minimum of 10s anyway. After N rapid restarts, launchd
  itself backs off (`StartInterval` semantics).
- **Crash signature in stderr** is captured by `StandardErrorPath`.
- We can opt to write a `data/last-crash.json` from a SIGSEGV/uncaught
  handler if it gets useful — defer.

## launchd plist exit-code handling

Codex flagged in Q-01 that `KeepAlive=true` is dangerous if the
supervisor exits cleanly. Use the dictionary form:

```xml
<key>KeepAlive</key>
<dict>
  <key>SuccessfulExit</key>
  <false/>          <!-- don't restart on exit 0 -->
  <key>Crashed</key>
  <true/>           <!-- do restart on signal/crash -->
</dict>
<key>ThrottleInterval</key>
<integer>10</integer>
```

This way:
- Exit 0 (e.g., port-in-use, "another instance is running") = no
  restart. Sane.
- Exit 75/78 = launchd retries (because it's not a "successful"
  exit).
- SIGSEGV / SIGKILL = launchd retries.

## Exit code map

| Code | Meaning                                | Action     |
|------|----------------------------------------|------------|
| 0    | Clean shutdown, intentional exit       | No restart |
| 64   | Usage error (bad CLI args)             | No restart |
| 70   | Internal software error, give up       | No restart |
| 75   | Temporary failure, retry later         | Restart    |
| 78   | Configuration error                    | Restart    |
| signal | Crash (via launchd)                  | Restart    |

## Recovery and visibility

- `~/.automations/data/state/` — small files for status visible
  even when supervisor is down: `last-error.txt`, `start-history.json`
  (last 20 starts with timestamps + exit codes).
- `bun supervisor.ts --check` — non-running mode that validates
  config + runs migrations dry-run + reports status, exits 0/78.
  Useful in CLI for "is my config OK?" without touching the
  running supervisor.

## Tradeoffs to flag

- **Degraded-mode startup masks errors.** If we always start "up,"
  the user might not notice the config is broken. Mitigation:
  `terminal-notifier` ping on first transition into degraded mode.
- **PID file races.** Two supervisor instances starting at exactly
  the same moment can both pass the "is-PID-mine?" check. Mitigate
  with `flock(2)`-style file locking on the PID file. Bun has
  `node:fs.openSync(path, 'wx')` for exclusive open.
- **Auto-disable of triggers after 5 spawn failures** is
  user-hostile if it kicks in unexpectedly. Set the threshold
  conservatively, surface clearly in UI.

## Question for reviewer

Are these the right responses per failure mode? Is the exit-code
map useful or should we rely on launchd defaults? Degraded-mode
startup vs hard-fail on bad config — right tradeoff? Anything
missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- The per-mode behavior is mostly right: degraded cold-start for bad config, last-known-good on hot reload, and per-run spawn failures are the correct operational boundaries.
- The launchd model is overclaimed. `KeepAlive.SuccessfulExit=false` restarts on non-zero exits, so your table saying `64` and `70` are "No restart" is false unless you add a wrapper, persist retry state, or intentionally exit `0` after notifying.
- `ThrottleInterval` should be one value, probably `300`, not both `10` and `300`. For a personal automation supervisor, fast crash retries are mostly noise; five-minute retry is saner for DB/config/port faults.
- Port-in-use should not exit `0` just because another supervisor exists unless you are certain the other instance is the intended long-lived owner. Otherwise launchd may go quiet while the real supervisor later dies.

**Anything missed:**
- Persisted restart/failure counting is required if you want "after 5 retries" semantics; process memory resets on every launchd restart.
- Type errors in `automations.config.ts` are not guaranteed to exist at runtime unless startup explicitly runs a typecheck/build step.
- Use a real singleton lock before binding the port; PID files are diagnostic, not synchronization.

**Recommended choice:** AGREE-WITH-CAVEAT: keep the failure-mode policy, but simplify launchd to restart on non-zero with `ThrottleInterval=300`, make intentional no-restart exits use code `0`, persist failure history, and remove unsupported per-exit-code restart claims.
