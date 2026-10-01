# Q-20 — One Bun process: the supervisor bundles the dashboard

## Context

Q-08 / D-08 chose Vite to build the dashboard into `ui/dist/` (gitignored), with `ui/` as its own package. The supervisor and CLI are TypeScript that Bun runs directly, so the dashboard was the only part that needed a build step.

That build step breaks the intended install. `bun add --global "git+ssh://git@github.com/zhendalf/auto.git"` copies the repository, does not run `prepack`, and does not install `ui/`'s dependencies, so a git install served the "UI not built" placeholder. The CLI, scheduler, webhooks and API all worked. (`github:` and `git+https:` specs fail for the private repository because Bun fetches an unauthenticated tarball; only `git+ssh://` works.)

## Options

### a) Commit the built `ui/dist`

- Pros: smallest change; no new dependencies at runtime.
- Cons: about 380 KB of generated files in every UI commit, plus a CI check that fails when they are stale. Two sources of truth.

### b) The supervisor bundles `ui/` with Bun's bundler

`Bun.build` with an HTML entry point and `bun-plugin-tailwind` bundles `ui/index.html` (React 19, React Router, React Query, Tailwind v4 `@import "tailwindcss"`, `@theme inline`, `prefers-color-scheme` dark mode) into one HTML page plus hashed JS, CSS and SVG.

- Pros: one process, one toolchain, no build step anywhere. Nothing generated is committed or shipped.
- Cons: React, React Router, React Query, Tailwind and the plugin become runtime dependencies of the root package, which reverses "root and `ui/` are separate packages on purpose". Vite's hot module replacement is gone.

### c) Publish a built tarball to a registry

- Pros: `prepack` already builds; standard npm flow.
- Cons: needs a registry and package name chosen by the owner; a git install would still be broken.

## Measurements (Bun 1.4.2, Apple Silicon)

- Bundling in memory takes about 50 ms; a cold process that also imports the plugin, about 75 ms. From an installed package (`bun pm pack`, `bun install --production`), the first bundle took 274 ms.
- Output: JS 382 KB (Vite: 354 KB), CSS 28 KB (Vite: 24 KB). The CSS differs only in a few unused utilities that Tailwind's scanner found in different places (`.container`, `.blur` and others with Bun; `.start` and `.end` with Vite). Every utility the components use is present in both.
- The page has one external stylesheet and one module script and nothing inline, so the CSP (`script-src 'self'`, `style-src 'self'`) is unchanged.

## Recommendation

Choose **(b)**, as the owner intended.

- Bundle when the server starts, in the background, into memory. Requests wait for that build. Serve outputs only by exact URL path (`/assets/<name>-<hash>.<ext>`, immutable cache). Nothing is read from disk per request, so the traversal and symlink rules for `ui/dist` no longer apply.
- Keep the shell exactly as before: inject the `auto-bootstrap` JSON tag before `</head>` for allowed Hosts only, `no-store`.
- If bundling fails, log the error and serve a placeholder that shows it, with the bootstrap tag. The API, webhooks and scheduler are unaffected.
- Dev: `AUTO_UI_DEV=1` watches `ui/` and bundles again on the next request after a change, so you reload the page to see an edit. The supervisor serves the dev page itself, so the Vite proxy, token plugin and dev host checks go away.
- Move the UI dependencies to the root package. Type the UI with `ui/tsconfig.json` from the root (`bun run typecheck:ui`).

## Tradeoffs

- Every install pulls React, Tailwind and Tailwind's native scanner (`@tailwindcss/oxide`) even though the supervisor never runs them in Bun; they are needed to bundle.
- No hot module replacement: a full reload after each edit. With a bundle this small, a reload is fast enough.
- The bundle runs in the supervisor process at start. A broken dependency shows on the dashboard instead of failing a build in CI. `test/ui-bundle.test.ts` bundles the real `ui/` in the suite so CI catches it.
- Two supervisors on the same package each hold their own copy in memory (about 400 KB). Nothing on disk is shared or raced.

## Question for reviewer

Is moving the UI dependencies into the runtime package acceptable in exchange for a build-free git install?

## Codex verdict

Not reviewed. Decided by the owner's instruction ("Bun-native") in the publish handoff; recorded as D-44.
