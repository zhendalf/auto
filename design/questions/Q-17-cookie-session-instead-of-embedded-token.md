# Q-17 — How the browser authenticates: embedded token or cookie session

The file name records the option that was considered first. The outcome is the opposite: the cookie session was rejected and the token stays in the served page.

## Context

Q-07 and Q-08 let the dashboard authenticate by embedding the API token in the served HTML (a JSON bootstrap tag) and by passing it as `/events?token=` because `EventSource` cannot send headers. The pre-launch review flagged three things about that: the full-control token is readable by any script or extension with access to the page, it can end up in caches and history, and `?token=` put it in URLs and logs. It also tied the SPA to a single hard-coded proxy host name.

The dashboard runs on a single-user machine over plain HTTP on loopback. Its callers are the user's browser and the CLI. Requirements: opening the dashboard must be trivial, it must survive supervisor restarts (the watchdog restarts the supervisor without a person present), and a leaked credential must be revocable.

## Options

### a) Keep the token in the bootstrap tag; remove the URL exposure and gate the page

Keep embedding the token as a JSON data block. Send it as `Authorization: Bearer`, fetch the event stream with `fetch` (which can send headers) instead of `EventSource`, remove `?token=`, and control who is served the page: `Host` must be present and allowed, a present `Origin` must be allowed, the page cannot be framed or read cross-origin, and it is never cached.

- Pros: no sign-in step and no cookies; `http://127.0.0.1:<port>/` just works, including from a bookmark, another browser or a fresh profile; nothing to expire or re-issue after a restart; one credential and one code path for the CLI and the SPA.
- Cons: anything that can open a TCP connection to the loopback port can `GET /` and read the token. Extensions and DevTools see it in the DOM.

### b) HttpOnly session cookie derived from the token, obtained through a one-time code

`auto ui` (authenticated with the token) asks `POST /api/ui-session` for a code valid for 60 seconds and one use, and opens `/auth/exchange?code=...`, which sets `auto_session = HMAC-SHA256(token, "auto-ui-session-v1")` as an `HttpOnly`, `SameSite=Strict` cookie and redirects to `/`. `/api` and `/events` accept the bearer token or the cookie; cookie writes also need a matching `Origin`. Rotating the token changes the HMAC key and ends all cookies.

- Pros: the page never holds the token; the cookie survives restarts because there is no server state; rotation is a complete revocation.
- Cons: a sign-in step. The dashboard only opens through `auto ui`; a bookmark, another browser, a private window or a different host name (`localhost` versus `127.0.0.1`) shows "Not signed in". The cookie is per host and not `Secure` on plain HTTP. There is no per-session revocation. It adds an endpoint, a code store, a cookie policy and an extra Origin rule to get right.

### c) Server-side session table with random session ids

- Pros: per-session revocation and expiry.
- Cons: in-memory sessions die on every restart (the watchdog restarts the supervisor), so the user is signed out at random; persisted sessions add a table and a cleanup story. More moving parts for a one-user tool, and still a sign-in step.

### d) Cookie plus a bootstrap-time CSRF token in the page

- Cons: the page would again carry a secret, so it buys nothing over (a).

## Decision

**(a).** The cookie session (b) was implemented during the pre-launch pass and then **rejected by the project owner for ergonomics**: the dashboard must be trivially reachable, with no sign-in step. It was removed together with `POST /api/ui-session`, `/auth/exchange`, the `auto_session` cookie and the one-time code store.

The chosen model:

- The page served at `/` (and every SPA fallback path) embeds `{"token", "port"}` in `<script id="auto-bootstrap" type="application/json">`, `Cache-Control: no-store`. The SPA sends the token as `Authorization: Bearer`, with `credentials: "omit"`, on every request and on the fetch-streamed `/events`.
- `Authorization: Bearer` is the only credential on `/api` and `/events`. `?token=`, `X-Auto-Token` and cookies are not accepted.
- Gates, in order, on everything except `/hooks/*` and `/healthz`: `Host` present and allowed (`403 bad_host`); a present `Origin` allowed for every method (`403 bad_origin`); a built-in loopback `Host` with proxy forwarding headers refused (`403 proxied_request`); then the bearer (`401`).
- Allowed hosts: `127.0.0.1:<port>`, `localhost:<port>`, `auto.localhost:<port>` (`[::1]` was later dropped: the server listens on IPv4 only) plus exact entries from `AUTO_ALLOWED_HOSTS` (default empty). `auto.localhost` is safe by construction because browsers resolve `*.localhost` to loopback without DNS, so it cannot be rebound. The hard-coded `automations.localhost` is gone.
- Every response carries a CSP (`frame-ancestors 'none'`, no unsafe-inline), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`; no response has CORS headers.
- `POST /api/token/rotate` writes a new `0600` token atomically, swaps it in memory, closes every event stream and makes the old token stop working. Dashboards reload to pick up the new token (a 401 shows a "reload" prompt); the CLI re-reads the file.
- `auto ui` just prints and opens `<base URL>/`, and only contacts `/healthz` to say so when the supervisor is down.

## Tradeoffs

- **The token is readable by anything that can reach the loopback port.** Any local process or user can `GET /` with an allowed `Host` and read it. This is accepted for a single-user tool and is why Auto must not run on a shared multi-user machine. It is weaker than the `0600` token file against other local accounts. Workers and the config file already run as the user and can read the file anyway.
- **A tunnel that forwards `/` hands out the token.** The proxy-header refusal is best effort and misses a proxy that rewrites `Host` and sends no forwarding headers. Tunnels must forward only `/hooks/<path>`.
- **`AUTO_ALLOWED_HOSTS` entries serve the token to whoever can reach that name.** The server prints a warning at start.
- **Extensions and DevTools can read the token** from the page DOM.
- Revocation is rotation only; there is no per-browser revocation. The old cookie option did not have it either.
- Web pages, DNS rebinding, framing and cross-origin reads are still blocked (Host allowlist, Origin check, CSP and frame headers, no CORS). A no-cors request from another origin can be sent but its response is opaque.
- Breaking for anything that used `?token=` or `X-Auto-Token`.
- The Vite dev page embeds the token too; `server.cors` is off so another local origin cannot read it, and Vite's own host check refuses foreign `Host` values. Keep Vite on localhost.

## Question for reviewer

Is "the loopback page hands the token to any local process" acceptable for a single-user tool in exchange for a dashboard that opens with no sign-in? Be clear about what is given up: the cookie model kept the token out of the page, so a local user account that cannot read `data/.token` also could not obtain a credential, and an extension reading the DOM saw no token. The embedded-token model gives both of those up. It keeps the protections against web pages, and it depends on Auto running on a machine with one user.

## Codex verdict

Not reviewed. Decided by the project owner (cookie sessions rejected for ergonomics); recorded as D-26 (amended) and D-41.
