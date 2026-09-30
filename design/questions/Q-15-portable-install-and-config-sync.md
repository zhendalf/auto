# Q-15 — Portable installation and configuration transfer

## Context

The current repository is both application source and local deployment:
`automations.config.ts` and workers are versionable, while `data/` contains
machine-local runtime state, tokens, logs, condition state, and secrets. The
existing installer derives absolute paths from the checkout and writes a
macOS-specific LaunchAgent. Bun 1.4.2 now provides OS-level `Bun.cron(path,
schedule, title)` registration across macOS, Linux, and Windows, so maintaining
our own launchd/systemd/Task Scheduler adapters would duplicate Bun's platform
layer.

The goal is a straightforward way to move the service and its definitions to
another machine without copying credentials, stale locks, run history, or
machine-specific paths by accident.

## Options

### a) Sync the whole repository, including `data/`

- Pros: apparent one-command copy.
- Cons: copies secrets, auth tokens, SQLite WAL files, locks, logs, and local
  overrides; unsafe and likely to produce split-brain state.

### b) Git-sync code and definitions; bootstrap local runtime state

Keep workers, config, migrations, and a machine-readable manifest in Git.
Each machine creates its own `data/`, API token, service definition, runtime
overrides, and secrets.

- Pros: simple, reviewable, and compatible with the current source-of-truth
  split; normal Git tools handle transfer.
- Cons: secrets and selected runtime overrides need an explicit export/import
  story.

### c) Publish a self-contained package with remote configuration service

- Pros: polished fleet management.
- Cons: introduces hosting, identity, update channels, and remote mutation far
  beyond a personal automation supervisor.

## Recommendation

Choose **(b): Git-distributed definitions plus machine-local bootstrap**.
Separate three things that happen to live together today:

1. **Package:** supervisor, CLI, UI, migrations, worker code, lockfiles.
2. **Definitions:** `automations.config.ts` and non-secret job assets, tracked
   in Git.
3. **Instance state:** `data/`, secrets, auth token, run history, pending
   condition/webhook state, and enable/pause overrides, never Git-synced.

### Installation contract

Add one idempotent entry point:

```sh
bun run auto-install
```

It should:

- require a supported Bun version and verify the frozen lockfiles;
- install root and UI dependencies with frozen locks;
- build the UI;
- run config validation and a read-only migration preflight;
- create private state directories and a fresh local API token;
- register the portable supervisor watchdog with `Bun.cron` and install the
  `auto` shim;
- start the service, then run `auto doctor` and print a concise receipt.

The command must be safe to rerun. It must not create or guess missing
secrets, enable a trigger whose required secret is absent, or import runtime
state implicitly.

### Portable lifecycle through Bun

Use Bun as the only OS-scheduler abstraction:

```ts
await Bun.cron(
  "./supervisor/main.ts",
  "* * * * *",
  "automations-supervisor",
);
```

The registered module exports an async `scheduled()` handler that starts the
supervisor and does not resolve until graceful shutdown. The once-per-minute
schedule is a watchdog, not the job scheduler:

- while the supervisor is healthy, subsequent launches either remain
  suppressed by the host scheduler or exit immediately on the existing
  singleton lock;
- after a crash or reboot, the next minute boundary starts it again;
- uninstall uses `Bun.cron.remove("automations-supervisor")`;
- foreground mode remains available everywhere for development and recovery.

This gives a portable lifecycle with a worst-case restart delay of roughly one
minute and no bespoke launchd/systemd/Task Scheduler templates. Installation
must verify the registration using the platform's readback surface and then
verify `/healthz`; a resolved `Bun.cron()` call alone is not enough evidence.

Configured time-based triggers run inside the live supervisor using Bun's
in-process `Bun.cron(schedule, handler)` API. This replaces `croner` while
preserving the supervisor's registry, condition checks, runtime enable/disable,
run history, and reentrancy controls. The supervisor remains the caller of the
worker; OS-level Bun cron is not registered separately for every job.

Portability constraints still need validation:

- Bun's OS-level implementation uses crontab on Linux, launchd on macOS, and
  Task Scheduler on Windows; those host facilities must be available.
- Windows OS-level cron rejects some expressions that expand beyond 48 native
  triggers, but the watchdog's `* * * * *` is supported and configured job
  schedules are in-process, so they do not inherit that limit.
- Windows containers do not support Bun's OS-level cron; use foreground mode
  with the container's process manager there.
- Worker scripts and instance bindings must still avoid POSIX-only assumptions
  before the package can truthfully claim Windows support.

### Definition synchronization

Git is the default transport:

```sh
git clone <repo> ~/.automations
cd ~/.automations
bun run auto-install
auto config check
```

- Job definitions must avoid absolute machine paths. Add `${HOME}` and
  named-root resolution in schema rather than checking literal home paths into
  config.
- A tracked `automations.instance.example.json` declares required local
  values: named roots, required secret names, optional port, and timezone.
- The real `automations.instance.json` is gitignored and contains non-secret
  machine bindings only. Secret values stay in the secret store.
- Pulling Git changes updates definitions through the existing last-known-good
  reload. Updating application code requires an explicit `auto upgrade` that
  performs frozen install/build/preflight/restart/doctor with rollback to the
  previous Git revision on preflight failure.
- Do not run `git pull` continuously inside the supervisor. Repository sync is
  a separate explicit command or automation, so code changes do not silently
  become execution authority.

### Transfer commands

Provide two explicit, inspectable artifacts:

- `auto config export --output <file>` exports normalized definitions,
  required secret names, named-root bindings, and selected enable/pause
  overrides. It excludes secret values, tokens, run history, payloads, and
  pending condition/webhook deliveries.
- `auto config import <file> --dry-run` previews validation, path resolution,
  missing secrets, and override changes. Applying the import requires a second
  explicit command and never starts jobs whose prerequisites are missing.

Secrets are provisioned separately on the destination with `auto secret set`
or a future encrypted backup mechanism. Plaintext secret export is not part of
v1.

### Instance identity and split-brain safety

- Each bootstrap generates a stable local `instance_id` in private state.
- Runs and webhook receipts record the instance ID.
- Copying definitions to another machine creates another independent executor;
  it does not transfer leadership.
- Jobs that must run on only one machine need a config-level placement rule
  (`instances: ["name"]`) or must remain disabled until explicitly enabled.
  Multi-machine leader election is out of scope for v1.

## Tradeoffs to flag

- **Git sync is distribution, not orchestration.** Two enabled machines will
  both execute the same cron unless placement is explicit.
- **Runtime history stays local.** Moving definitions does not migrate run
  history or pending condition state. A separate stopped-service backup/restore
  command can be designed later.
- **Secrets remain the manual bootstrap step.** This is intentional; convenient
  plaintext replication would make the portability story less safe.
- **Bun abstracts registration, not application portability.** Worker commands,
  paths, file watching, and shell assumptions still need cross-platform tests.
- **Restart is minute-granularity.** The portable watchdog favors simplicity
  over an immediate `KeepAlive` restart. A machine-specific service manager can
  remain an optional optimization if this proves too slow.

## Question for reviewer

Should portability mean Git-synced code/definitions plus per-machine bootstrap,
with Bun-owned cross-platform lifecycle and cron scheduling, idempotent install,
explicit config export/import, and independent local state/secrets?

## User decision

**Accepted on 2026-09-21.** Rely on Bun's cross-platform cron functionality
instead of maintaining a launchd-specific service lifecycle. Use Git for code
and definition transfer, keep runtime state and secrets local, and provide an
idempotent installer with a Bun-managed watchdog.

## Codex verdict

**Verdict:** RECOMMEND

This is the smallest honest portability model. Bun owns platform registration;
the supervisor still owns admission, history, monitoring conditions, and the
webhook server. Git distributes definitions without becoming a database or
secretly creating two active schedulers.
