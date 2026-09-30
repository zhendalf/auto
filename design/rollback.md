# Rollback and recovery

Auto separates the engine from the live workspace:

- engine/package: the installed `auto-supervisor` package, or your source
  checkout (`<engine checkout>` below)
- live workspace: `~/.auto` (or `AUTO_HOME`)
- generated watchdog entry: `~/.auto/.auto-runtime/supervisor.ts`
- runtime data: `~/.auto/data` (or `AUTO_DATA_DIR`)

## Stop a broken supervisor

```bash
auto svc stop
```

This removes the Bun OS cron watchdog and sends `SIGTERM` to the running
supervisor, then waits up to 16 seconds for it to exit. The supervisor gives
running workers up to 10 seconds and force-kills the rest; runs that were
still active are recorded as `killed` with reason `supervisor_shutdown`. It does
not delete workspace data. `auto svc start` registers the watchdog again.

If `auto svc stop` reports that the supervisor is still running after the wait,
read `auto svc tail` first; as a last resort the command prints the pid to
`kill -9`. That is safe: the next start finalizes any interrupted runs (below).

## What a start does after a crash

After `kill -9`, a crash, or power loss, the next supervisor start:

- takes over the singleton lock if its holder is gone. The lock
  (`data/supervisor.lock`) records the holder's pid and command line, so a
  reused pid does not block a start. If the lock is held by a live supervisor,
  the new process prints "supervisor already running" and exits. Remove a lock by hand only when you are sure
  no supervisor runs (`auto doctor` and `auto svc tail` will tell you).
- marks runs still `queued` or `running` as `failed` with reason
  `supervisor_interrupted`, appends a note to their logs, and stops a worker
  process that is still alive and whose command line matches the recorded
  worker path;
- clears stale pending condition markers.

`supervisor.log` (`data/state/`) records what recovery did.

## Validate before restarting

```bash
cd <engine checkout>
bun run verify
auto config check
```

`bun run verify` runs the root and UI typechecks and the full test suite. Fix
engine or workspace configuration errors before reinstalling:

```bash
auto install
auto doctor
```

`auto install` rewrites the watchdog entry so it points at the checkout you run
it from; run it again after moving or upgrading an engine.

## Restore an earlier engine revision

Use a known-good release or Git revision of the engine, then run its normal
install command again.

Database migrations are additive and forward-only, and an older engine refuses
a database that a newer one has migrated: it will not start and exits `78` with
a message in `data/state/last-error.txt` rather than write to a schema it does
not know. Before installing a newer engine, and before any release that
introduces a migration, take a protected copy of `~/.auto/data/` while the
supervisor is stopped. To go back to an older engine after a migration, restore
that copy (this loses history written since the copy). Otherwise do not modify
`~/.auto/data/` during an engine rollback. Release notes should name compatible
engine versions.

Migration `0003_retention_indexes.sql` (retention indexes) is the first
migration after the original schema; it only adds indexes.

## Retention is permanent

The retention sweeper deletes old runs, their logs, and old webhook receipts
without a trash. If a rollback or a restore brings back a database from before
a sweep, the next sweep prunes it again. To keep everything while you investigate,
set `AUTO_RETENTION_DAYS=0` and run `auto install` again so the watchdog carries
it.

## Rebuild runtime state

Only when history and runtime overrides are intentionally disposable:

```bash
auto svc stop
auto data wipe
auto install
```

`auto data wipe` removes the database, token, secrets, run logs, and condition
state, after showing what will go and asking you to type `wipe`. It refuses
while a supervisor is running. It is not an ordinary repair step; `auto doctor`
prints the specific remedy for a damaged database.

## After rotating or losing the token

`auto token rotate` replaces the token. The old token stops working at once;
reload open dashboards to pick up the new one (`auto ui` reopens the
dashboard), and scripts that cached the token must re-read `data/.token`. If
`data/.token` is deleted, the supervisor creates a new one at the next start,
which has the same effect.
