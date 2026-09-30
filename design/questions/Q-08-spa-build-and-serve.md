# Q-08 — React+Tailwind SPA build and serve

## Context

The UI is a React + Tailwind SPA, served at `/` by the same
`Bun.serve` that runs the API + webhooks (Q-07). Per Q-07, the SPA's
HTML shell is what bootstraps the API token to the browser.

This question covers:
- Build tool (Vite vs Bun bundler vs HTML imports)
- Dev workflow (HMR? proxy back to supervisor? two ports?)
- Production: where built assets live, how cache headers work
- Tailwind v3 vs v4

## Options

### a) Vite + React + Tailwind v4

- Dev: `bun run vite` on a separate port (e.g., 5173). Vite proxies
  `/api/*`, `/hooks/*`, `/events` to the supervisor on 7777.
- Build: `bun run build` produces `ui/dist/` with hashed assets +
  an `index.html`.
- Prod: supervisor serves `ui/dist/` at `/` with long cache for
  hashed assets, no-cache for `index.html`.
- Tailwind v4 has a first-party Vite plugin (`@tailwindcss/vite`),
  no more PostCSS/`tailwind.config.js` — config is `@theme` blocks
  in CSS.

### b) Bun bundler + Bun's HTML imports

Bun 1.x supports HTML imports in `Bun.serve`: import `index.html`,
the bundler walks `<script>` and `<link>` and produces a runtime
bundle.

- Pros: zero config; no Vite; one toolchain.
- Cons: less mature for React + Tailwind in practice (Tailwind
  needs a PostCSS-style step that Bun doesn't yet handle as
  smoothly as Vite); HMR exists but is newer than Vite's; smaller
  community for troubleshooting.

### c) No build step — vanilla TS modules served raw

Bun.serve can serve `.tsx` directly via on-the-fly transpile.
- Pros: simplest possible.
- Cons: no bundling means many requests; Tailwind can't be
  generated on the fly without a watcher; not real for production
  use.

## Tailwind version

- **Tailwind v4** (released 2025) — Vite plugin, `@theme` in CSS,
  no `tailwind.config.js`. Faster dev. Standard going forward.
- **Tailwind v3** — older; rich plugin ecosystem; well-known.

For a fresh build, no reason to start on v3.

## Recommendation

**(a) Vite + React 19 + Tailwind v4 (with the official Vite plugin).**

Layout:
```
~/.automations/
├── ui/                      # SPA source
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── routes/
│   │   ├── components/
│   │   └── styles.css       # @import "tailwindcss" + @theme block
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json         # workspace member; or share root deps
├── ui/dist/                 # build output, gitignored
└── supervisor/              # Bun supervisor
    └── ...
```

- **Dev workflow:**
  - Terminal A: `bun supervisor.ts` (the supervisor on :7777)
  - Terminal B: `bun --cwd ui run dev` (Vite on :5173, proxies
    `/api/*`, `/hooks/*`, `/events` to :7777)
  - You point your browser at Vite (5173) for HMR; the SPA still
    talks to the supervisor through the proxy.
- **Prod:**
  - `bun --cwd ui run build` → static files in `ui/dist/`.
  - Supervisor serves `ui/dist/` at `/`, with:
    - `Cache-Control: public, max-age=31536000, immutable` for
      `assets/*` (hashed filenames)
    - `Cache-Control: no-cache` for `index.html`
  - Token bootstrap: supervisor injects the token into
    `index.html` at serve time (replace `__AUTO_TOKEN__` in the
    HTML before responding) so the SPA picks it up on first
    paint.
- **Routing:** client-side via React Router. SPA fallback on the
  Bun.serve catch-all returns `index.html` for any non-API,
  non-hook, non-asset path.

## Bundle size & dependencies

- React 19 + React Router + Tailwind: ~50–80 KB gzipped baseline.
- For data fetching: `@tanstack/react-query` (well-suited to
  cache + revalidate runs/jobs) or just `useEffect`+`fetch`.
  Recommend React Query — the run-list view will benefit from
  background refetch and SSE-driven invalidation.
- For SSE consumption in React: native `EventSource`. No library.
- For state: nothing global. URL + React Query is enough.

## Tradeoffs to flag

- **Two terminals in dev.** Inevitable when SPA dev server is
  separate from the supervisor. Easy to wrap in a `bun run dev`
  that uses `concurrently` or two `Bun.spawn`s.
- **Bun bundler maturity.** Picking Vite means we don't bet on
  Bun's bundler ecosystem yet. If Bun.serve+HTML imports get
  better, we can revisit.
- **Token injection at serve time.** Means `index.html` from the
  build can't be served by a CDN as-is — but we have no CDN; the
  supervisor serves it, so this is fine.
- **Workspace setup.** `ui/package.json` adds React+Vite deps.
  Either set up a Bun workspace or just put SPA deps in root.
  Recommend separate `ui/package.json` for clarity (the
  supervisor doesn't need React; the SPA doesn't need
  supervisor deps).

## Question for reviewer

Vite + React 19 + Tailwind v4 — right call? Token injection at
serve time the right approach for SPA bootstrap (vs `<meta>` tag
filled by JS, vs `/api/_init` we already rejected)? React Query —
warranted for v1, or premature? Anything missed?

## Codex verdict

**Verdict:** AGREE-WITH-CAVEAT

**Reasoning:**
- Vite is the right default. The UI is not the experiment here; the supervisor/runtime model is. Use the mature React dev server, proxy to `127.0.0.1:7777`, and keep Bun focused on serving prod assets and running the backend.
- Tailwind v4 is fine for a fresh app, but do not overstate "no config" as a virtue. If the UI needs content scanning, theme tokens, or plugins later, keep the setup boring and explicit enough that upgrades/debugging are not magic CSS archaeology.
- Token injection into `index.html` is acceptable for same-origin local UI, but inject as a JSON script blob or escaped data attribute, not string replacement into arbitrary HTML. Treat this as a secret-bearing response: `no-store` is safer than merely `no-cache` for `index.html`.
- React Query is warranted once run history, job state, polling/refetch, and SSE invalidation exist. It is not premature if you commit to using it as the API cache boundary, not as global state.

**Anything missed:**
- Dev token bootstrap needs a concrete answer. If Vite serves `index.html`, the supervisor is not injecting it. Either Vite middleware/proxy serves the shell from supervisor, or dev uses a local token file/env-backed placeholder with clear safeguards.
- Static serving needs path traversal and MIME handling called out. Bun's catch-all must not accidentally serve `data/.token`, logs, DB files, or arbitrary repo paths.
- SPA fallback must exclude real static misses under `/assets/*`; returning `index.html` for missing JS/CSS makes failures harder to debug.

**Recommended choice:** Option a: Vite + React 19 + Tailwind v4, with escaped runtime token injection in prod, an explicit dev-token bootstrap plan, `no-store` for the HTML shell, immutable caching only for hashed assets, and React Query included from v1.
