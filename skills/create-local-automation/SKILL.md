---
name: create-local-automation
description: Create, modify, validate, and activate jobs in an Auto workspace (the local automation supervisor). Use for scheduled jobs, condition-change monitors, signed webhook triggers, or when asked to add, change, or debug an automation that runs on this machine.
---

# Create Local Automation

Build jobs for the Auto supervisor while preserving the calling project's state and the supervisor's safety contracts. Jobs live in the Auto workspace, not in the project they act on. Change engine code only when the supervisor itself must change.

## Locate the workspace

1. The workspace is `$AUTO_HOME` when set, otherwise `~/.auto`. It holds `auto.config.ts` (job definitions), `jobs/` (workers), and `data/` (runtime state: never edit or commit it).
2. Run `auto doctor` and `auto config status` first. If the supervisor is not installed or the workspace does not exist, run `auto init` and `auto install` (ask before installing on a machine the user did not mention).
3. Read `auto.config.ts` and one or two similar workers under `jobs/` before writing anything, and follow the conventions already there.
4. If the workspace is a Git repository, check `git status` and leave unrelated changes alone. Do not switch branches, stage, commit, or discard work unless the user asks.

Keep the target project's code in its own repository. Put only the supervisor-facing worker and configuration in the workspace unless the user explicitly asks to change the target project too.

Engine changes are separate: only for a source install (the `auto` shim, `command -v auto`, names the engine checkout). Read the engine's `AGENTS.md` completely before editing it. Never edit an installed package.

## Define the job

Infer safe defaults when the request is clear. Establish these details before implementation:

- A stable lowercase hyphenated job id and name. Names must not contain `:` or `/`.
- The exact action, target paths, and expected output.
- Choose plain `cron` for unconditional schedules, `cron.condition` for polling a state transition, or `webhook` for authenticated push delivery.
- Five-field cron schedules run in the machine's local timezone. Do not rely on catch-up runs after the machine sleeps.
- Reentrancy: prefer `drop` unless overlapping work is explicitly useful; use `queue` or `parallel` only with a concrete reason.
- A realistic timeout (the default is 10 minutes) and the default 10-second termination grace period.
- Whether running the worker causes external writes, sends messages, changes remote state, or performs destructive actions.

If the request does not authorize a consequential external action, create and validate the automation but do not manually fire it. A request to build or schedule a clearly described action authorizes the corresponding scheduled behavior; a capability question does not.

## Implement the worker

Create `<workspace>/jobs/<job-name>/worker.ts` (a directory per job leaves room for a checker and tests) and add its entry to `auto.config.ts`.

A worker is an ordinary program that Auto runs as `bun <worker>`. It does not import Auto or touch its database. Follow these contracts:

- Make the worker directly runnable with `bun <absolute-worker-path>` so it can be tested by hand.
- Print useful execution evidence to stdout or stderr; the supervisor captures both in the run log. Exit non-zero on failure.
- Read run metadata from `RUN_ID`, `JOB_NAME`, `JOB_ID`, `TRIGGER_KIND`, `TRIGGER_ID`, and `TRIGGER_META` when needed. Webhook workers also get `TRIGGER_PAYLOAD_PATH`.
- Workers receive a minimal environment: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `SHELL`, `TMPDIR` (plus the variables above). Do not depend on shell-profile variables or on tools outside the inherited `PATH`; resolve them with `Bun.which` or use absolute paths.
- Auto does not inject secrets into workers. Its secret store (`auto secret set`) exists for webhook signing. A worker that needs credentials reads them from the OS keychain or a `0600` file outside any repository. Never print secrets or entire environments; log redaction only covers exact values Auto knows about.
- Use argument arrays with `Bun.spawn` for subprocesses. Avoid shell interpolation for user-controlled or secret values.
- Resolve target-project paths explicitly. Do not assume the working directory is the target project.
- Fail closed before mutation when prerequisites, identity, repository state, or authority are ambiguous.
- Recheck mutable preconditions immediately before a consequential write, then verify the final state.
- Notify only for meaningful completion or attention events (for example `terminal-notifier` on macOS with a stable `-group` so notifications replace one another), and degrade quietly when the notifier is missing.

Add focused `bun:test` coverage under `<workspace>/test/` when the worker contains branching safety logic that can be isolated from live external systems.

## Configure the job

Add an `Automation` entry with this shape, adapting values to the task. Worker and checker paths are relative to the workspace root and must begin with `./`.

```ts
{
  id: "job-name",
  name: "job-name",
  description: "Describe the observable outcome.",
  worker: "./jobs/job-name/worker.ts",
  triggers: [{ kind: "cron", id: "schedule-name", schedule: "0 9 * * *" }],
  reentrancy: "drop",
  queueDepth: 1,
  timeoutMs: 10 * 60_000,
  killGraceMs: 10_000,
  enabled: true,
}
```

Keep ids stable and unique. A job's identity is its name: renaming a job starts a new history.

For a condition-change monitor, keep observation separate from action:

```ts
triggers: [{
  kind: "cron",
  id: "reply-watch",
  schedule: "*/5 * * * *",
  condition: { checker: "./jobs/email-reply/check.ts", timeoutMs: 30_000 },
}]
```

The checker is a directly runnable Bun subprocess. It reads one JSON document from stdin and writes exactly `{ fire, state?, meta? }` as JSON to stdout. Diagnostics go to stderr. A first check normally records a baseline with `fire:false`. Keep checks read-only and idempotent; state advances only after the fired action succeeds. Use a stable transition id in `meta` for consequential actions.

For webhook ingress, use a unique path and a named secret reference:

```ts
triggers: [{
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
  contentTypes: ["application/json"],
  maxBodyBytes: 1_048_576,
  keepPayload: false,
}]
```

Webhook workers read the authenticated body from `TRIGGER_PAYLOAD_PATH` and bounded receipt metadata from `TRIGGER_META`. Set the signing secret with `auto secret set <secretRef>` (hidden prompt or stdin; never put it in config, arguments, or chat). Keep payload retention off unless replay or audit needs justify it. Auto does not expose webhooks to the internet: any tunnel must forward only `/hooks/<path>` and nothing else.

## Validate and activate

1. Run `auto config check`. It validates the workspace config offline (schema, cron syntax, that worker and checker files exist) without touching the running supervisor.
2. Run the worker's `bun test` from the workspace. Add a narrower test first when live behavior would cause side effects. If the workspace has a `tsconfig.json`, run `bunx tsc --noEmit` there as well.
3. The supervisor watches the config and applies valid changes without a restart. Confirm with `auto config status`, `auto job <job-name>`, and `auto doctor`. If the job is missing after a reload, run `auto config reload`, and if it is still missing `auto svc restart`, then check again.
4. If the user authorized a live run, execute `auto run <job-name>`, wait for completion, then inspect `auto last <job-name>` and the run log. Do not use `--force` unless the user wants to bypass the overlap policy or run a disabled job: it skips those safety checks.

The supervisor lifecycle is registered through Bun's cross-platform OS cron API. Use `auto install` and `auto svc start|stop|restart|uninstall`; do not create launchd or systemd entries directly. Do not stop or uninstall the supervisor, wipe data, or change secrets the user did not mention.

Do not treat a passing test, loaded config, enabled schedule, or running process as proof that the intended action succeeded. Use the strongest safe receipt available: a completed run record plus the target system's readback when a live run is authorized. If the schedule has not fired yet, say so plainly.

## Report the result

State:

- The job name and schedule, including timezone.
- What files changed.
- Which offline checks passed.
- The live supervisor and config state.
- Whether a real run occurred and its receipt, or why it was intentionally not fired.
- Any remaining uncommitted changes or operational caveats.
