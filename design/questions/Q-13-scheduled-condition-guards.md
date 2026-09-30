# Q-13 — Scheduled condition guards for change-triggered runs

## Context

The supervisor currently runs every cron-triggered worker whenever its
schedule is due. A worker can poll an external source, compare it with a
saved snapshot, and return without acting when nothing changed, but that
has three drawbacks:

- Every poll becomes a normal run, so history fills with `NO_CHANGE`
  checks rather than meaningful actions.
- Each worker has to reinvent baseline, state, retry, and deduplication
  behavior.
- The worker combines a read-only observation with the consequential
  action, making their permissions and failure semantics harder to
  separate.

Remote changes such as a new library release do not fit the planned file
`watch` trigger, which is specifically for local filesystem events. A
webhook is preferable when the source can send one, but many third-party
registries and repositories can only be observed by polling.

OpenClaw's condition-watcher model is the useful precedent: a schedule
evaluates a stateful condition, and the payload runs only when the
condition returns `fire: true`. This question decides whether and how to
add that capability without weakening the supervisor's subprocess
isolation.

## Options

### a) Keep condition logic inside each worker

The cron adapter starts the normal worker on every tick. The worker reads
and writes its own state and exits successfully when nothing changed.

- Pros: works with the current implementation; no supervisor changes.
- Cons: noisy run history; duplicated state machines; observation and
  action share permissions; the supervisor cannot explain condition
  health separately from action health.

### b) Allow inline functions in `automations.config.ts`

```ts
condition: async (previousState) => {
  // Return { fire, state, meta }.
}
```

- Pros: concise and type-friendly.
- Cons: executes user code in the long-running supervisor; functions do
  not survive the existing JSON definition snapshot; code changes are
  hard to hash and reconcile reliably; a hung condition can stall the
  control plane. This conflicts with Q-02's fault-isolation rationale.

### c) Add a subprocess condition guard to scheduled triggers

```ts
{
  kind: "cron",
  id: "check-releases",
  schedule: "*/15 * * * *",
  condition: {
    checker: "./library-release/check.ts",
    timeoutMs: 30_000,
  },
}
```

When the schedule is due, the cron adapter runs the checker in a bounded
Bun subprocess. The normal job worker is enqueued only when the checker
returns `fire: true`.

- Pros: keeps `cron` as the scheduling primitive; preserves subprocess
  isolation; separates read-only observation from action authority;
  yields quiet condition ticks and meaningful action history; supports
  arbitrary external systems without teaching the supervisor their APIs.
- Cons: adds a second executable contract, durable trigger state, and a
  two-phase state-commit path.

### d) Add a fifth `poll` trigger kind

Model polling as a peer of `cron`, `webhook`, and `watch`.

- Pros: explicit in UI and history.
- Cons: polling still needs an interval or cron expression, so this
  duplicates scheduling semantics. The real new behavior is a guard on a
  scheduled trigger, not a distinct source of timing events.

## Recommendation

Choose **(c): an optional subprocess condition guard on `cron` triggers**.

The supervisor continues to own scheduling. The checker owns observation
and comparison. The job worker owns the action. A condition is not a fifth
trigger kind and does not change the meaning of local filesystem `watch`.

### Checker contract

- `checker` is a repo-relative path beginning with `./` and must be
  directly runnable with Bun.
- The supervisor sends one bounded JSON document on stdin containing
  contract version, job/trigger identity, scheduled fire time, and the
  previous JSON state (or `null` on first evaluation).
- The checker writes exactly one JSON document to stdout:

  ```ts
  type ConditionResult = {
    fire: boolean;
    state?: JsonValue;
    meta?: JsonValue;
  };
  ```

- Diagnostics go to stderr. Stdout, stderr, `state`, and `meta` all have
  explicit size caps. Recommended v1 caps are 1 MiB combined process
  output and 16 KiB each for serialized `state` and `meta`.
- The checker is killed on `timeoutMs` using the same SIGTERM → grace →
  SIGKILL discipline as workers. Default condition timeout is 30 seconds.
- Condition checkers are trusted local code and execute with the macOS
  user's authority. They should be read-only. They receive no job secrets
  by default; any future checker-secret declaration must be separate and
  narrower than the action worker's declarations.

### State and firing semantics

- On the first evaluation, `previousState` is `null`. A checker must make
  its baseline policy explicit. Release-watcher templates default to
  recording the current release with `fire: false`, so installation does
  not treat every existing release as new.
- `fire: false`: persist the returned state, update condition-health
  counters, schedule the next evaluation, and create no normal run row.
- `fire: true`: enqueue the normal job worker with the condition `meta` in
  `TRIGGER_META`. Hold the proposed state pending while the action is
  queued or running.
- Commit the proposed state only in the same DB transaction that records
  the fired action as `succeeded`.
- If the action is skipped, fails, times out, is killed, or is cancelled,
  do not commit the proposed state. The next eligible evaluation sees the
  previous state and may fire again.
- While a fired action for the same condition is queued or running, the
  trigger is single-flight: scheduled evaluations are suppressed rather
  than creating duplicate actions.
- Actions must still be idempotent using a stable transition key supplied
  in `meta` (for example a release ID). State rollback provides retry, not
  exactly-once side effects.
- A checker error or malformed result does not modify condition state and
  does not enqueue the worker.

### Persistence and observability

Add supervisor-owned condition state keyed by `trigger_id`. It must store:

- committed `state_json`;
- pending action run ID and pending state while a fired action is active;
- evaluation count and last evaluation time;
- last fire time;
- consecutive evaluation failures and bounded last error.

Quiet evaluations do not appear in normal run history. CLI/UI trigger
status shows condition health, last evaluation, last fire, pending action,
and last error. Supervisor diagnostics retain bounded checker stderr for
failed evaluations.

`auto run <job>` remains an explicit manual action and bypasses the
condition without modifying condition state. A future
`auto trigger check <job> <trigger>` command evaluates the condition using
the normal state/commit rules and is the intended verification surface.

## Tradeoffs to flag

- **Retry is at-least-once, not exactly-once.** If an action performs a
  remote side effect and then crashes before reporting success, it can run
  again. Stable transition IDs and destination readback are mandatory for
  consequential actions.
- **Latest-only versus every unseen transition is checker policy.** A
  registry watcher may compare only the newest release, or return an
  ordered backlog. Templates must state which behavior they implement.
- **Condition state is operational data.** Resetting it can cause a new
  baseline or a repeated action. Any future reset command must preview the
  consequence and require confirmation.
- **Quiet does not mean invisible.** Suppressing `NO_CHANGE` run rows is
  desirable only if last-check time and evaluation failures remain visible
  on the trigger.
- **Webhooks still win when available.** Condition polling is a fallback
  for sources that cannot push authenticated events; it should not replace
  a reliable webhook with needless polling.

## Question for reviewer

Should scheduled conditions be modeled as subprocess guards on cron
triggers, with quiet non-firing evaluations, single-flight fired actions,
and state committed only after action success? Should condition functions
ever run inline inside the supervisor?

## User decision

**Accepted on 2026-08-24.** Use the OpenClaw-style schedule → condition →
action model, adapted to this supervisor's subprocess isolation.

## Codex verdict

**Verdict:** AGREE

**Reasoning:**

- A condition is an admission guard on a scheduled event, not a new source
  of time, so extending `cron` is cleaner than adding `poll`.
- Running checkers as subprocesses preserves the control-plane isolation
  established in Q-02 while still allowing function-defined observations.
- Delayed state commit gives failed actions a retry path; single-flight
  handling prevents that retry policy from generating concurrent duplicate
  actions.
- Separate condition health keeps normal run history focused on code that
  actually ran in response to a detected transition.

**Recommended choice:** Option C with bounded checker I/O, durable
supervisor-owned state, no secrets by default, state commit coupled to
successful action completion, and explicit idempotency keys for side
effects.
