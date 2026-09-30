# Q-18 — Config loading in a subprocess

## Context

`auto.config.ts` is TypeScript evaluated by importing it (Q-05). Hot reload used `import("file://...?ts=<now>")` to defeat the module cache. On Bun 1.4.2 that trick returns the stale module for `file://` URLs (reproduced by importing the same file twice with different `?ts=` values), so after the first load every later edit was silently ignored and an invalid edit was never reported. The same code path also validated less than `--check` did, so a config could pass a reload and fail at the scheduler.

## Options

### a) Keep the in-process import with a cache-buster

- Pros: no new moving parts.
- Cons: does not work on the Bun version in use; any future change in Bun's module cache can break it again.

### b) Clear or bypass the module registry in-process

Delete the entry from `require.cache` or use `Loader.registry`.

- Pros: stays in-process.
- Cons: relies on undocumented behavior for ESM, does not cover the config's own imports, and can leave partly evaluated modules in memory.

### c) Evaluate the config in a short-lived Bun subprocess

Run `supervisor/config-loader.ts` with `process.execPath` in the workspace root; it imports the config, prints the default export as one JSON line after a marker, and exits. The supervisor parses and validates the JSON.

- Pros: a fresh module graph on every load, on every Bun version; a broken or hanging config cannot take the supervisor down (10 s kill timeout, capped output); output the config prints itself cannot corrupt the result; the same function serves hot reload, cold start, `--check` and `auto create --add`.
- Cons: each reload spawns a process (about 50-100 ms, not benchmarked); the default export must be JSON-serializable, so functions, symbols, bigints, non-finite numbers and cycles are rejected; the config file runs as code with the supervisor's environment on every reload.

## Recommendation

Choose **(c)**. Put all validation behind it so hot reload, cold start and `--check` report the same errors: job names, cron syntax (through the scheduler's own parser), numeric limits, and that every worker and checker file exists. Commit a new config only after the runtime has applied it, keep the last-known-good on any failure, serialize and coalesce reloads through one entry point, and watch the parent directory with a poll backstop so atomic-rename saves, a deleted file and a missing directory recover by themselves.

## Tradeoffs

- The config is trusted code and must be side-effect free; the docs say so.
- A config that imports npm packages was not exercised.
- Worker and checker existence is enforced even for `enabled: false` jobs.
- A slow config (up to the 10 s limit) delays that one reload, not the supervisor.

## Question for reviewer

Is a process per reload acceptable for a config that changes a few times a day, in exchange for correct hot reload independent of the runtime's module cache?

## Codex verdict

Not reviewed. Decided by the project owner's instruction to fix and polish everything before launch; recorded as D-32.
