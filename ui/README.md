# @automations/ui

The supervisor's React + Tailwind v4 dashboard. It is a single-page app that
talks to the supervisor's `/api/*` and `/events`; it has no data of its own.

## Opening the dashboard

There is no sign-in step. Open the supervisor's address in any browser on this
machine:

```sh
auto ui          # opens the dashboard in your default browser
```

or go straight to `http://127.0.0.1:<port>/` (port 7777 unless `AUTO_PORT` says
otherwise), `http://localhost:<port>/` or
`http://auto.localhost:<port>/` (a built-in name that browsers resolve to this
machine). Other names work only when listed in `AUTO_ALLOWED_HOSTS` on the
supervisor (for example the name of an access-controlled proxy).

The supervisor embeds the API token in the `<script id="auto-bootstrap">` tag
of the page it serves at `/`, and only when the request's `Host` header is
present and allowed. The app sends it as `Authorization: Bearer <token>` on
every API call and on the `/events` stream (fetched with `fetch`, not
`EventSource`, so the token never appears in a URL). No cookies are used.

Because the page embeds the token, rotating it (`auto token rotate`) makes the
open dashboard's requests fail with 401. The app then says "The API token
changed. Reload this page to pick up the new one." and offers a Reload button.

A page that carries no token (opened from `vite preview`, a static file server
or a saved copy) shows "This page was not served by the Auto supervisor. Open
the dashboard with: auto ui" instead of an empty screen.

## Develop

The supervisor must be running (`auto install`, or `bun supervisor/main.ts`
with `AUTO_PORT` set for a scratch workspace). Then:

```sh
bun run --cwd ui dev
```

Open http://127.0.0.1:5173. Vite serves the app with hot reload and injects the
same bootstrap tag the supervisor does, reading the token from the workspace
(`AUTO_DATA_DIR`, else `AUTO_HOME/data/.token`, else `~/.auto/data/.token`) each
time the page loads, so reloading after a supervisor restart or a token
rotation picks up the current token. It proxies `/api`, `/events` and
`/healthz` to the supervisor (`AUTO_PORT`, default 7777) with the Host and
Origin of the supervisor itself, so the supervisor's allowlist accepts dev
requests without listing the dev port. The proxy adds no credentials: the page
sends the bearer token itself. The dev page contains the token, so Vite must stay
on localhost: it answers only requests whose `Host` is a loopback name, and if
you start it with `--host` (or set `server.host`) it stops injecting the token
and warns.

If the token file does not exist yet, Vite still starts and warns, and the page
shows the "not served by the Auto supervisor" message until the supervisor has
run once and you reload.

## Build

```sh
bun run --cwd ui build
```

Produces `ui/dist/index.html`, `ui/dist/favicon.svg` and `ui/dist/assets/*`
(no source maps). The supervisor serves these directly: HTML with
`Cache-Control: no-store`, hashed assets with `public, max-age=31536000,
immutable`. The page must not use inline styles or scripts: the supervisor's
Content-Security-Policy allows only same-origin ones.

Do not use `vite preview` to try the production bundle: it serves the files
only, with no supervisor behind it, no `/api` proxy and no token, so the app
shows "This page was not served by the Auto supervisor". Build, then let the
supervisor serve it and open the dashboard with `auto ui`.

## Typecheck and tests

```sh
bun run --cwd ui typecheck      # the UI's own tsconfig (DOM + React types)
bun test test/ui-*.test.ts      # pure helpers under ui/src/util (from the repo root)
```

The UI has no component test framework. Logic that is worth testing lives in
DOM-free modules under `ui/src/util` (formatting, ANSI, the log follower, error
mapping, cron phrases, run filters, ...) and their type shapes in
`ui/src/api/types.ts`, so the root test run can import them.

## Layout

- `src/api/` client, React Query hooks, the event stream and its cache
  invalidation. All requests go through `client.ts` (which adds the bearer
  header); never call `fetch` directly from a component. The log download is
  `api.downloadRunLog`, a fetch handed to the browser as a blob, because a
  plain link cannot send a header.
- `src/routes/` compose data and components; `src/components/` hold the logic.
- `src/util/` pure helpers, including the bootstrap parser, the SSE frame
  parser (`sseParse.ts`) and the event-stream reconnect loop (`eventStream.ts`). `src/hooks/` `useNow` (shared 1 s / 30 s clock so
  relative times and running durations tick) and `useDocumentTitle`.
- `src/styles.css` semantic color tokens for light and dark (following
  `prefers-color-scheme`). Components use `bg-surface`, `text-muted`,
  `border-line`, status pairs like `bg-ok-bg text-ok-fg`, never raw palette
  colors, so both schemes stay readable. `test/ui-contrast.test.ts` checks the
  token pairs against 4.5:1.

No `clsx`, no icon library, no `date-fns`, no UI kit: Tailwind utilities inline,
dates through `Intl.DateTimeFormat`.
