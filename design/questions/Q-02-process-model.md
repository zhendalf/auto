# Q-02 — In-process workers vs subprocess-per-invocation?

## Context

With a supervisor process settled (Q-01: LaunchAgent), the next decision
is how the supervisor actually executes jobs when a trigger fires.

The current `bun-autoupdate/worker.ts` is structured to run either:
1. Directly: `bun bun-autoupdate/worker.ts` (via `if (import.meta.main)`)
2. As a Bun.cron-invoked module: via the `default { scheduled() }` export

Both modes share the same code; only the entry differs.

## Options

### a) Subprocess per invocation

Supervisor spawns the worker as a child process whenever a trigger
fires (`Bun.spawn(["bun", "<path>/worker.ts"])`). It collects
stdout/stderr/exit code, writes a row to the run history, and moves on.

- Pros:
  - Fault isolation: a worker that crashes, OOMs, or runs for 30s
    can't take down the supervisor or block other triggers.
  - Simple mental model: each run is a clean process with its own
    memory, stdout, exit code.
  - Workers stay individually runnable for testing (`bun worker.ts`).
  - Concurrent jobs trivially parallel — no event-loop contention.
- Cons:
  - ~30–80ms spawn cost per run. Negligible for cron, fine for
    webhooks unless we expect very high volume.
  - Worker can't directly read supervisor in-memory state (would
    need a fetch back to supervisor's HTTP API).

### b) In-process workers

Supervisor `await import()`s the worker module and calls its
`scheduled()` export directly.

- Pros:
  - No spawn overhead.
  - Shared DB connection, shared logger, shared whatever.
- Cons:
  - One bad job blocks the event loop or OOMs the whole supervisor.
  - All jobs fight over a single Bun process's memory and CPU.
  - Module cache means restarting a "fresh" run requires
    `delete require.cache[...]` gymnastics or a process restart.
  - Workers become coupled to the supervisor's runtime (can't be
    written in another language; harder to test in isolation).

### c) Hybrid

Cheap/safe workers in-process, "dangerous" ones (anything that shells
out heavily, or that user marks `isolated: true`) as subprocesses.

- Pros: best of both, in theory.
- Cons: two execution paths to debug; flag bikeshedding; the
  performance win from in-process is rarely large enough to justify
  the complexity.

## Recommendation

**(a) Subprocess per invocation.**

- Spawn cost is irrelevant for personal-scale workloads.
- Fault isolation is genuinely valuable: bun-autoupdate can take 60s
  during a Bun major upgrade, and we don't want that blocking a PR
  webhook.
- Existing workers need zero changes — they already run as
  `bun <path>/worker.ts`.
- Run-history writing happens in the supervisor (parent), not in the
  worker, so workers don't need DB access. Worker writes its own
  domain log to `<job>/<name>.log` as it does today; supervisor
  records `(run_id, started_at, finished_at, exit_code, trigger_kind)`
  to the SQLite runs table.

## Tradeoff to flag

Any job that needs supervisor state at runtime (e.g., "what was my
last successful run?") has to fetch it from the supervisor's HTTP
API. That's actually a feature, not a bug — it makes the
worker/supervisor contract explicit instead of relying on shared
process memory.

## Question for reviewer

Is subprocess-per-invocation the right default? Is there a workload
shape (high-frequency triggers, sub-second response on webhooks)
where the overhead becomes a real problem? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- Subprocess-per-invocation is the right default for this repo. Personal-scale automation values debuggability, restartability, and fault isolation more than shaving tens of milliseconds.
- The existing worker contract already supports this. Preserving `bun <job>/worker.ts` as the primary execution path keeps jobs easy to test and avoids coupling them to supervisor internals.
- The performance argument for in-process workers is weak here. If webhook volume ever makes spawn overhead matter, the real issue is probably queueing, dedupe, rate limiting, or trigger coalescing, not import overhead.
- Do not oversell "concurrent jobs trivially parallel." They are isolated processes, but the supervisor still needs explicit concurrency limits, per-job overlap policy, cancellation, timeout, and backpressure.

**Anything missed:**
- Define subprocess contract now: `cwd`, env inheritance, absolute Bun path, stdin behavior, stdout/stderr capture limits, timeout, signal escalation, and how exit due to signal is recorded.
- Same-job reentrancy needs a decision before webhooks/file-watch triggers: drop, queue, debounce, coalesce, or allow parallel runs. This matters more than spawn vs import.
- Worker logs plus supervisor run history can drift. Store enough supervisor-captured output or log path metadata to make the UI useful without pretending the SQLite row is the whole trace.

**Recommended choice:** Option a, subprocess per invocation, with an explicit runner contract and per-job concurrency/timeout policy baked into the supervisor from the start.
