# Dashboard (`ui/`)

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

A page that carries no token (opened from a static file server
or a saved copy) shows "This page was not served by the Auto supervisor. Open
the dashboard with: auto ui" instead of an empty screen.

## Develop

There is no build step and no dev server. The supervisor bundles this
directory in memory with Bun's bundler (`Bun.build` with `bun-plugin-tailwind`)
when it starts, see `supervisor/ui-bundle.ts`. With `AUTO_UI_DEV=1` it watches
`ui/` and bundles again on the next request after a change; reload the page to
see your edit. Use a scratch workspace and port:

```sh
AUTO_HOME=/tmp/auto-dev bun cli/main.ts init
AUTO_HOME=/tmp/auto-dev AUTO_PORT=17800 AUTO_UI_DEV=1 bun supervisor/main.ts
```

Then open http://127.0.0.1:17800/. The dev page is served exactly like the
production one (same Host and Origin checks, same token injection), so there is
no proxy or dev token to configure.

If bundling fails, the error is printed on the supervisor's stderr and the page
at `/` shows it. The API keeps working.

## The bundle

`index.html` is the entry point. The bundle is one HTML page plus hashed files
under `/assets/` (JS, CSS, the favicon), with no source maps. HTML is served
with `Cache-Control: no-store`, assets with `public, max-age=31536000,
immutable`. The page must not use inline styles or scripts: the supervisor's
Content-Security-Policy allows only same-origin ones. Import assets from
TypeScript (`import url from "../favicon.svg"`) instead of linking an absolute
path, so the bundler hashes them.

## Typecheck and tests

```sh
bun run typecheck:ui            # the UI's own tsconfig (DOM + React types)
bun test test/ui-*.test.ts      # the bundle and the pure helpers under ui/src/util
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
