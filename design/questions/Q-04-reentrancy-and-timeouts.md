# Q-04 — Reentrancy and timeout policy

## Context

A trigger can fire while a previous run of the same job is still
executing. Codex flagged this in Q-02 and Q-03 as one of the most
load-bearing decisions, because:

- Cron firing while previous run is still going → pile-up risk
- Webhook bursts (PR-opened immediately followed by review-requested)
  → duplicate work
- File-watch on a `git pull` that touches 200 files → 200 spurious
  fires unless coalesced
- Manual trigger from UI while run is in flight → surprising UX if
  it just queues silently

This decision interacts tightly with:
- Trigger model (Q-03): per-job default with per-trigger override
- Subprocess contract (Q-02): timeout + signal escalation
- Run history (future Q): need "queued" / "skipped-due-to-overlap" /
  "killed-by-timeout" states

## Reentrancy policies (what to do when a job is already running)

- **`drop`** (default for cron, manual) — ignore the new trigger,
  record a `skipped` row in history with reason `overlap`. Previous
  run continues untouched.
- **`queue`** — enqueue, run sequentially when the current run
  finishes. Bounded queue depth (default 1? configurable?). Beyond
  the limit → drop with reason `queue_full`.
- **`parallel`** — fire and forget, run another subprocess
  concurrently. Suitable for stateless jobs (e.g., a webhook that
  just kicks off an independent task).
- **`debounce`** (typically `watch` only) — collapse triggers within
  a window into one fire. Trailing edge by default (fire after
  quiet period of N ms).
- **`coalesce`** — like debounce but accumulates payload context
  (e.g., union of changed files), passes the merged context to the
  worker. Likely **not** worth implementing now; revisit if needed.

## Timeout policy

Every run gets a default wall-clock timeout (e.g., 10 minutes).
On timeout:
1. Send `SIGTERM` to the worker subprocess.
2. After a grace period (e.g., 10s), send `SIGKILL`.
3. Record run as `timed_out`, exit code = signal info.

Per-job override (`timeout: 3600` for `bun-autoupdate` which can
take longer during major Bun upgrades).

## Recommendation

### Defaults

```ts
type Automation = {
  // ...
  reentrancy?: "drop" | "queue" | "parallel"; // default: "drop"
  queueDepth?: number;                         // when reentrancy="queue", default 1
  timeoutMs?: number;                          // default 600_000 (10 min)
  killGraceMs?: number;                        // default 10_000
};

type WatchTrigger = {
  kind: "watch";
  paths: string[];
  debounceMs?: number;     // default 500
  reentrancy?: "drop" | "queue" | "parallel"; // override; default uses job's
};
```

- **Job default reentrancy:** `drop`. Most jobs are idempotent enough
  that skipping an overlapping fire is the safe choice.
- **Watch trigger default:** `debounce` at 500ms, then defer to job's
  reentrancy on the actual fire. (Debounce is implemented at the
  trigger layer, not the run layer — it's about coalescing fires
  *before* they become runs.)
- **Webhook trigger default:** uses job's `reentrancy` (no
  trigger-layer debounce; webhooks are already discrete events).
- **Cron trigger:** uses job's `reentrancy`.
- **Timeout default:** 10 minutes wall-clock. `bun-autoupdate` will
  override to 30 or 60 minutes.

### History states

Run rows can be in:
`queued | running | succeeded | failed | timed_out | skipped | killed`

- `skipped` carries a `reason` enum: `overlap`, `queue_full`,
  `disabled`.
- `killed` is for explicit cancellation from CLI/UI (distinct from
  `timed_out`).

## Tradeoffs to flag

- **`queue` is dangerous in slow-job + bursty-trigger scenarios.**
  E.g., a webhook that fires 50 times in 10 seconds while the job
  takes 30 seconds → 50 sequential runs over 25 minutes. Bounded
  queue depth (default 1) and explicit `queueDepth: N` for
  intentional cases mitigates this. Default of 1 means "one in
  flight, one queued, drop the rest" — which is usually what you
  want.
- **`parallel` runs share log files** unless we partition by run_id.
  Need to decide on log file naming convention before workers can
  safely run parallel.
- **Debounce ≠ rate limit.** A continuous stream of file changes
  with `debounceMs: 500` will hold off forever. May want a maximum
  delay (`maxWaitMs`) to force a fire after, say, 5 seconds even if
  changes keep coming.

## Question for reviewer

Are `drop`/`queue`/`parallel` (with optional `debounce` at the
trigger layer for watch) the right primitives? Is there a real
need for `coalesce` in the v1, or can we punt? Defaults
reasonable? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- `drop` / `queue` / `parallel` are the right v1 run-layer primitives. They map cleanly to supervisor behavior, are explainable in UI/history, and avoid baking trigger-specific semantics into the runner.
- Keep `debounce` out of `reentrancy`. It is trigger admission control, not overlap policy. The proposed split is correct.
- Default `drop` is reasonable for cron/watch, but I would not make it the default for manual. Manual should usually return an explicit "already running" result and require "cancel" or "run anyway" rather than silently recording a skipped row.
- `queueDepth: 1` is fine, but define whether queued runs preserve the original trigger payload or just record "rerun requested." For webhook/manual, payload identity matters; for cron, it usually does not.

**Anything missed:**
- Add `maxWaitMs` to watch debounce in v1, not later. Without it, continuous writes can starve the job forever, which is a bad failure mode for personal automation.
- Define cancellation behavior for queued runs separately from running runs. UI cancel should be able to remove queued entries without producing `killed`.
- Parallel mode requires per-run stdout/stderr capture owned by the supervisor. Do not let worker-local shared log files be the primary trace if `parallel` exists.

**Recommended choice:** `drop` / `queue` / `parallel` as v1 run-layer primitives, watch-layer `debounceMs + maxWaitMs`, punt `coalesce`, default `drop` for cron/watch/webhook unless explicitly configured, and make manual overlap an explicit UI/API conflict rather than silent drop.
