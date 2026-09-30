# Q-19 — Retention defaults

## Context

Q-06 stored run history in SQLite and per-run logs on disk and left retention as future work. Nothing pruned them: run rows, log files (up to 5 MiB each), webhook receipts and kept payloads grew without bound, and `auto doctor` had no way to say "you have too much history". A cron job firing every minute adds about 1,440 runs a day. For a tool meant to run unattended on a laptop, the default has to keep the disk bounded without asking the user to configure anything, while never deleting the history of a job that rarely runs.

## Options

### a) No pruning; document `auto data wipe`

- Pros: nothing is ever lost by surprise.
- Cons: unbounded growth is a certain failure for an always-on service; `wipe` is all-or-nothing.

### b) Opt-in retention

- Pros: safest for existing installs.
- Cons: nobody opts in; the default installation is the one that fills the disk.

### c) On by default with a time horizon and a per-job floor

Prune finished runs older than `AUTO_RETENTION_DAYS` (default 90), but always keep the newest `AUTO_RETENTION_MIN_RUNS` (default 25) real runs of each job. Skipped runs (fires dropped by overlap, pause and so on) expire sooner, after at most 14 days, and do not count toward the floor. Webhook receipts live at least 7 days and never inside the 5-minute dedupe window. `AUTO_RETENTION_DAYS=0` turns it off.

- Pros: bounded disk by default; a job that runs once a year still shows its last runs; dropped-fire noise cannot crowd out real history; one switch for "keep everything".
- Cons: permanent deletion by default on the first supervisor start after upgrading (existing installs get the 90-day cut immediately); no trash.

### d) Size-based retention (keep at most N MB of history)

- Pros: directly bounds the disk.
- Cons: harder to reason about ("why is Tuesday gone?"), needs a size accounting pass, and interacts badly with the per-job floor.

## Recommendation

Choose **(c)**. Run the sweeper 60 seconds after the supervisor starts and every 6 hours, in batches of 200 rows that yield to the event loop, so scheduling is never blocked. Never touch queued or running rows or a run that a condition trigger still names as pending. Delete a log file before its row, only confine deletions to `runs/` and `payloads/` (no symlink following), and remove empty date directories only once their date is at least two local days old. Add three additive indexes (migration 0003) so deleting a run does not scan child tables. Bake `AUTO_RETENTION_DAYS` and `AUTO_RETENTION_MIN_RUNS` into the watchdog entry and the shim when they are set at install time.

## Tradeoffs

- Existing installations lose runs older than 90 days (beyond the floor) at the first sweep after upgrading. The changelog says so.
- The floor keeps old rows for rarely-run jobs even beyond the horizon, so disk use is bounded per job rather than in total.
- A pruned run returns 404 from the API; any saved link to it breaks.
- There is no dry-run command yet: `pruneOnce({dryRun})` exists inside the supervisor but no CLI or API reaches it.
- Skipped runs expire in at most 14 days even if the horizon is longer.

## Question for reviewer

Is deleting history by default (90 days, floor of 25 real runs per job) the right default for a first release, or should the first release ship with retention off and a prominent doctor warning instead?

## Codex verdict

Not reviewed. Decided by the project owner's instruction to fix and polish everything before launch; recorded as D-34 and D-35.
