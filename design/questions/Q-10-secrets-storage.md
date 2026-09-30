# Q-10 — Where do secrets live?

## Context

`automations.config.ts` is checked into git (Q-05). It cannot
contain secrets. But several real secrets are needed:

- **Webhook signing secrets** (per-trigger HMAC; e.g., GitHub
  webhook secret).
- **API tokens** workers need (GitHub PAT, Linear API key,
  OpenAI/Anthropic keys for AI jobs).
- **Notification credentials** (Pushover key, Slack webhook URL,
  etc.) — punt unless we need them.
- **The supervisor's own UI/CLI auth token** (Q-07) — already
  located at `data/.token`, not really a secret in the user-facing
  sense.

This question pins down where these secrets are stored, how the
config references them by name, and how workers access them at
runtime.

## Options

### a) `.env` file at the repo root, gitignored

`~/.automations/.env` with `KEY=value` pairs. Bun loads it
automatically into `process.env` for any `bun` invocation.

- Pros: trivial, native to Bun, every dev knows what an `.env` is.
- Cons: world-readable secrets on disk if file mode isn't strict;
  no per-secret access control; no rotation or audit; full env is
  inherited by every worker subprocess (all workers see all secrets,
  even ones they don't need).

### b) macOS Keychain via `security` CLI

Each secret is a Keychain item under a fixed service name. Supervisor
fetches via `security find-generic-password -s automations -a <name> -w`.

- Pros: encrypted at rest by macOS; gated by login keychain unlock;
  audit trail in Keychain Access.
- Cons: every fetch shells out to `security`; macOS prompts on
  first access from new processes (mitigated by "Always Allow"
  during install); doesn't sync nicely if the user wants iCloud
  Keychain (would have to be on every Mac); slower (~30ms per
  fetch); harder to bootstrap on a fresh machine (no plain-file
  manifest to restore).

### c) Hybrid: encrypted secrets file + Keychain master key

`data/secrets.enc.json` holds AES-encrypted secrets; the
encryption key lives in macOS Keychain. Supervisor unlocks once on
startup, holds plaintext in memory.

- Pros: portable file (can be backed up encrypted), Keychain-gated
  master key, single Keychain prompt at supervisor start.
- Cons: more code than (a) or (b); rolling your own crypto
  envelope is rarely a good idea; recovery story when Keychain key
  is lost.

### d) `data/secrets.json` (plain JSON, gitignored, mode 0600)

Like (a) but in JSON, with structure (per-trigger secret slots).

- Pros: structured (can have a `secrets.<trigger_id>.signing_secret`
  shape that mirrors the config); easy to inspect and edit.
- Cons: same security as (a) — file-system perms only.

## Worker secret access pattern

Independent of where secrets live, how do workers see them?

- **Pass via env** at spawn time. Supervisor reads the secret it
  knows the worker needs, sets `WORKER_SECRET_FOO=...`, calls
  `Bun.spawn`. Worker reads `process.env.WORKER_SECRET_FOO`.
  Other workers don't see it.
- **Worker fetches at runtime** via supervisor API
  (`GET /api/secrets/:name` with the API token). Same auth surface
  as everything else.
- **Worker reads file directly.** Bad — workers shouldn't be in
  the secrets-management business; they shouldn't all have read
  access to the secrets file.

## Recommendation

**(d) `data/secrets.json` (plain JSON, mode 0600), supervisor passes
needed values to workers via env at spawn time.**

```jsonc
// data/secrets.json (gitignored, chmod 600)
{
  "version": 1,
  "secrets": {
    "github_webhook":     "whsec_...",
    "github_pat":         "ghp_...",
    "anthropic_api_key":  "sk-ant-..."
  }
}
```

- Config in `automations.config.ts` references secrets *by name*,
  never by value:
  ```ts
  {
    kind: "webhook",
    name: "github-pr",
    secretRef: "github_webhook",   // looks up data/secrets.json
  }
  ```
- For workers that need API tokens, the config declares which
  secrets it wants exposed:
  ```ts
  {
    name: "ai-daily-digest",
    worker: "./ai-digest/worker.ts",
    triggers: [...],
    secrets: ["anthropic_api_key", "github_pat"],
  }
  ```
  Supervisor sets `SECRET_ANTHROPIC_API_KEY` etc. only on this
  worker's env. Other workers don't see them.
- **Editing:** `bun secrets.ts set <name>` and `bun secrets.ts get
  <name>` CLI helpers. Or just edit the JSON file directly.
  Supervisor reloads on file change (same `fs.watch` it already
  uses for config).

Why not Keychain (b)? For personal use, the marginal security gain
over `chmod 600` on the user's own laptop is small, and the dev
ergonomics cost is real (prompts, slow fetches, two-source-of-truth
across machines). If a future job needs Keychain-grade isolation
specifically (e.g., a PIN-protected secret), wire it up per-secret
without redesigning the system.

Why not `.env` (a)? Path-of-least-resistance, but: (1) it's all-or-
nothing visibility per process — every worker inherits all env vars,
not just the ones it needs; (2) `KEY=value` makes per-trigger
indirection (`secretRef`) awkward.

## Tradeoffs to flag

- **`secrets.json` plaintext on disk.** `chmod 600` only protects
  against same-machine other-user reads, not against full-disk
  exfiltration. Acceptable for personal laptop. If the threat
  model changes, layer on (c) or (b).
- **Backup story.** Time Machine will back up `secrets.json`
  unencrypted. iCloud Drive sync should never be enabled for the
  `.automations` folder. Document in README.
- **Rotation.** No first-class rotation. User edits the file,
  supervisor reloads. Worker subprocesses started before reload
  carry the old value. For most workers this is fine; for
  long-running ones, supervisor could push a SIGHUP — defer.
- **Secrets in run logs.** Worker stdout might accidentally log a
  secret it received via env. Supervisor's per-run capture has no
  redaction layer. Document the risk; defer redaction.

## Question for reviewer

Plain-JSON-with-0600 the right call for personal scale? Per-job
opt-in for worker access (vs all workers see all) — right model?
Anything missed (rotation, backup, audit)?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- Plain JSON with `0600` is the right personal-scale default here. It matches the repo's "single-machine, direct scripts" bias and avoids Keychain complexity that will make recovery and automation worse.
- Per-job opt-in via declared `secrets: [...]` is the right model. It gives useful least-privilege boundaries without pretending subprocesses on the same user account are a hard security sandbox.
- Do not expose `bun secrets.ts get <name>` casually. A `get` command encourages terminal scrollback leaks and accidental copy/paste into logs. Prefer `set`, `list`, `remove`, maybe `show --confirm`.
- Passing secrets through env is acceptable, but document that env is still observable to child code and can leak through crash dumps, debug output, or subprocess inheritance inside the worker.

**Anything missed:**
- Add a startup/config validation rule: every `secretRef` and job-declared secret must exist before wiring the trigger/job, with degraded status surfaced in UI.
- Add redaction before v1 run-log capture, not later. Exact-value redaction for loaded secrets is cheap and prevents the most obvious footgun.
- Add backup guidance beyond "don't use iCloud": either exclude `data/secrets.json` from Time Machine or accept that encrypted disk backups are part of the threat model.

**Recommended choice:** d) `data/secrets.json` plain JSON, gitignored, mode `0600`, with supervisor-only reads and per-job env injection, plus required validation and log redaction.
