# Q-16 — Package and workspace separation

## Context

The supervisor began as a repository rooted at `~/.automations`. Engine code, personal workers, configuration, static UI assets, and runtime state therefore shared one directory. Publishing that repository would expose machine-specific jobs and make package upgrades collide with user-owned files.

## Options

1. Keep clone-and-edit distribution. Simple, but upgrades and personal configuration remain entangled.
2. Publish the engine and keep a user-owned workspace. The package owns code, migrations, and UI assets; the workspace owns configuration, workers, generated service entry, and local data.
3. Move all configuration into a hosted service. This contradicts the local-first and user-controlled goals.

## Recommendation

Choose option 2. The published package defaults to `~/.auto`, while this original source checkout retains its legacy root automatically. Support `AUTO_HOME`, `AUTO_CONFIG`, and `AUTO_DATA_DIR`. Persist resolved paths in a generated workspace watchdog entry so OS-scheduled launches use the same configuration.

Git distributes definitions, never coordination. Each machine retains independent secrets, tokens, history, condition state, webhook receipts, and runtime overrides.

## Tradeoffs

- A generated watchdog entry adds one small lifecycle artifact.
- Package upgrades must preserve the CLI and migration compatibility contract.
- Multiple concurrent workspaces need distinct scheduler titles and ports.
- Source-checkout compatibility adds a temporary legacy detection path.

## Question for reviewer

Does this boundary preserve the existing operational guarantees while making installation and upgrades safe for other users?

## Codex verdict

Approved by the user on 2026-09-28. Implement the package/workspace separation and retain explicit pre-release platform claims until clean-host verification exists.
