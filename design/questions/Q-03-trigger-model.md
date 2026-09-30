# Q-03 — Unified trigger abstraction or separate code paths?

## Context

The system needs four trigger kinds:
- **cron** (existing) — fire on a schedule
- **webhook** — fire when an HTTP request hits `/hooks/<path>`
- **watch** — fire when filesystem paths change
- **manual** — fire when CLI/UI requests it

Each fires a worker subprocess (per Q-02). The question is whether the
supervisor models them as instances of a single `Trigger` type, or as
three independent subsystems that all happen to call the same
"run worker N" primitive.

This decision propagates into:
- Config schema (one trigger union vs per-kind sections)
- Run-history rows (one column for `trigger_kind` vs polymorphic)
- UI ("Triggers" tab covers all kinds vs separate tabs)
- Reentrancy policy (per-job, or per-trigger?)
- Adding a new trigger type later (1 file vs N files)

## Options

### a) Unified `Trigger` union, per-job

A job declares one or more triggers; each trigger has a `kind`.

```ts
type Trigger =
  | { kind: "cron"; schedule: string }
  | { kind: "webhook"; path: string; secret?: string }
  | { kind: "watch"; paths: string[]; debounce?: number }
  | { kind: "manual" };

type Automation = {
  name: string;
  worker: string;
  triggers: Trigger[];
  timeout?: number;
  reentrancy?: "drop" | "queue" | "parallel";
};
```

Supervisor wires up each trigger to the same `runWorker(name, triggerCtx)`
primitive. Run-history row gets `trigger_kind` + `trigger_meta` (JSON
blob with kind-specific context like webhook payload digest, watched
file path that changed, etc.).

- Pros:
  - One mental model. New trigger kinds are an entry in the union +
    a small dispatcher, not a parallel subsystem.
  - Run history is uniform — UI can render "all runs of job X across
    all triggers" with one query.
  - Reentrancy and timeout policy live on the job, not duplicated
    across trigger types.
  - A job can opt into multiple trigger kinds (e.g., cron AND manual,
    or webhook AND watch) without per-kind glue.
- Cons:
  - Slight overhead from making cron, webhook, and watch fit a
    common shape. They're not perfectly symmetric (webhook has a
    payload, cron has a fire-time, watch has a path).
  - The `trigger_meta` blob is JSON — typed at the trigger boundary
    only.

### b) Separate subsystems sharing only `runWorker`

`scheduler.ts`, `webhooks.ts`, `watcher.ts` are independent modules,
each with its own config section, registration logic, and code path.

- Pros: each subsystem can be tuned in isolation.
- Cons: the system becomes "three small systems" instead of one;
  cross-cutting concerns (reentrancy, observability, UI rendering)
  get duplicated; adding a 5th trigger kind is now a 4th subsystem.

### c) Hybrid — unified Trigger, but cron stays in `Bun.cron`

Triggers are a union type, but the cron variant delegates to
`Bun.cron` rather than the supervisor's own scheduler.

- Pros: leverages an existing component.
- Cons: `Bun.cron` is a separate registry living outside the
  supervisor's control. Means migrations, log paths, and run-history
  hooks have to be coordinated across two systems. Defeats the
  purpose of having a supervisor.

## Recommendation

**(a) Unified `Trigger` union, per-job, supervisor owns all four kinds.**

- `Bun.cron` gets dropped in this rebuild — supervisor implements
  cron itself using `croner` or similar (resolved in a later question).
- Workers stay 100% trigger-agnostic. They get a `TRIGGER_*` env from
  the supervisor if they want it, but most jobs ignore trigger context.
- A manual trigger is just `{ kind: "manual" }` — it exists implicitly
  on every job; CLI/UI hit `/api/run/<name>` to invoke.
- The run-history `trigger_kind` enum gives the UI a clean filter and
  makes "show me failures from PR webhook last week" a one-liner.

## Tradeoffs to flag

- **Trigger ↔ run cardinality:** webhook and watch can fire many runs
  per minute; cron is naturally rate-limited. Reentrancy/concurrency
  policy (Q-04) needs to handle both shapes.
- **Trigger payload size:** GitHub PR webhook bodies are ~30–80KB.
  We probably want to store a digest + some fields, not the whole
  blob, in `trigger_meta`. Worth deciding when we lay out the runs
  schema.
- **Manual is special:** it's the only trigger that's always on for
  every job. May be worth modeling as "manual is implicit, only
  cron/webhook/watch are declared in `triggers`."

## Question for reviewer

Is the unified `Trigger` union the right shape? Is there a reason to
keep webhook or watch in a separate module — e.g., they outgrow the
union and start needing their own state machines? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- The unified `Trigger` union is the right domain model. Cron, webhook, watch, and manual differ at the adapter edge, but they converge on the same core event: "request a run of job X with context Y."
- Keep separate implementation modules for each trigger adapter anyway. "Unified model" should not mean one generic trigger engine. Webhook auth/body parsing and watcher debounce/coalescing will need kind-specific state.
- Job-level reentrancy is probably the correct default, but the schema should leave room for trigger-level overrides later. Watch triggers often want coalescing/debounce semantics that cron/manual should not inherit.
- Dropping `Bun.cron` is consistent with the supervisor decision. A supervisor that cannot enumerate, pause, explain, or record its scheduled triggers is not really supervising them.

**Anything missed:**
- Trigger identity needs to be explicit. If a job has two webhooks or two watch configs, `trigger_kind` is not enough; add `trigger_id` or `trigger_name` for history, UI filtering, disabling, and debugging.
- Manual should be modeled as a system-provided trigger in history, even if omitted from config. Otherwise "implicit but real" becomes an awkward special case in UI/API/run rows.
- `trigger_meta` should have a typed summary contract per kind, not an arbitrary blob. Store bounded, query-useful fields plus raw payload references only if needed.

**Recommended choice:** Option A, with unified config/history semantics, separate per-kind adapter modules, and explicit trigger IDs.
