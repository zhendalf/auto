# Security policy

## Reporting a vulnerability

<!-- TODO(owner): add the private reporting channel before the first public release (a security contact address, or enable GitHub private vulnerability reporting for the repository and link it here). Until then this section is intentionally incomplete. -->

**TODO (repository owner): this project does not yet have a private security-reporting channel.** Add one here before the first public release. GitHub private vulnerability reporting is one option once the repository URL is settled.

Until a channel exists, please do not open a public issue for a suspected vulnerability involving authentication, webhook verification, path traversal, secret handling, or command execution.

## Threat model

Auto is designed for **one trusted user on one machine**. It is not a multi-user system and not an internet-facing service.

### How the dashboard is authorized

The API token (`data/.token`, 256 random bits, mode `0600`) is the only credential. The CLI reads it from the file. The dashboard has no sign-in: the page served at `/` embeds the token in a JSON block (`<script id="auto-bootstrap" type="application/json">`) and the dashboard sends it as `Authorization: Bearer <token>` on every request and on the `/events` stream. The page is served only to a request whose `Host` header is present and allowed. There are no cookies and no sessions; `?token=` and `X-Auto-Token` are not accepted.

This is a deliberate ergonomic choice by the project owner: opening `http://127.0.0.1:<port>/` just works. Its cost is stated plainly below.

**Consequence: anything that can open a TCP connection to `127.0.0.1:<port>` can `GET /` with an allowed `Host` header and read the token.** That includes every process and every user account on the machine, which makes the page weaker than the `0600` token file (other accounts cannot read the file, but they can reach the port). Therefore:

- Run Auto only on a machine you alone use. Do not run it on a shared or multi-user host, or inside a container or VM whose loopback is shared with other tenants.
- Never expose the port beyond loopback: no port forward, no `0.0.0.0` proxy in front of it, no tunnel that forwards `/`. The Vite dev server (`bun run --cwd ui dev`) is loopback-only too: it answers only loopback `Host` names and stops injecting the token if started with `--host`.
- Treat the token like a password: it grants full control (run, cancel and pause jobs, reload config, rotate the token). The config file and workers already run as your user, so this control is equivalent to running code as you.

### What Auto defends against

- **Other websites in your browser.** A foreign page cannot obtain or use the token:
  - `Host` must be present and exactly one of `127.0.0.1:<port>`, `localhost:<port>`, `auto.localhost:<port>`, or an entry in `AUTO_ALLOWED_HOSTS` (`[::1]` is not listed: the server listens on `127.0.0.1` only). A DNS-rebinding page arrives with the attacker's name in `Host` and gets `403 bad_host`, without the token. `auto.localhost` is safe by construction: browsers resolve every `*.localhost` name to loopback without asking DNS, so it cannot be rebound to another address.
  - An `Origin` header, when present, must be an allowed origin, for every method and every route behind the `Host` check; otherwise `403 bad_origin`. Cross-origin `fetch` and form posts carry a foreign `Origin` and are refused, and preflights get no `Access-Control-Allow-*` headers, so a page on another origin cannot read `/` or call the API. (A no-cors request can be sent, but its response is opaque to the page.)
  - A request that the browser marks as cross-site (`Sec-Fetch-Site: cross-site` or `same-site`) and as anything other than a top-level navigation (`Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document`) is refused with `403 cross_site`, so a foreign `<script>`, `<img>`, `<link>` or `fetch` never receives the token page. Every response also carries `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`, which keep other sites from embedding it or holding a reference to its window. Clients that send no `Sec-Fetch-*` headers (the CLI, curl) are unaffected.
  - Framing is blocked by `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so the page cannot be embedded for clickjacking or a cross-origin read.
  - The API needs the bearer header, which a cross-site request cannot attach without CORS approval.
- **Requests relayed by a proxy or tunnel under a loopback name.** If the `Host` is one of the built-in loopback names and the request carries any proxy or tunnel header, the answer is `403 proxied_request`. Whole families are matched: every `X-Forwarded-*`, `X-Real-*`, `Cf-*`, `Tailscale-*`, `Ngrok-*` and `X-Envoy-*` header, plus `Forwarded`, `Via`, `Cdn-Loop`, `Client-Ip`, `X-Client-Ip`, `True-Client-Ip`, `Fastly-Client-Ip`, `X-Original-Forwarded-For` and `X-Original-Forwarded-Host`. This is a best-effort safety net: a proxy that rewrites `Host` to a loopback name and adds none of those headers (a bare `proxy_pass`, for example) is **not** detected. Do not rely on it; keep `/` off every tunnel.
- **Other machines.** The server binds only to `127.0.0.1`.
- **Other local user accounts, for the files.** `data/` and its subdirectories are mode `0700`, and the token, `secrets.json`, run logs, and other state files are `0600`. (As noted above, this does not stop another account from fetching the token through the port.)
- **Unauthenticated webhook senders.** `/hooks/<path>` accepts only bodies with a valid HMAC-SHA256 signature.

### What Auto does **not** defend against

- **Anything running on the machine.** Any local process or user can read the token from `/` (see above). Workers, the config file, and any other process you run as your user can also read `data/.token` and `data/secrets.json` directly. Treat every worker and the config file as code with the full authority of the current operating-system user.
- **A proxy or tunnel that reaches `/`.** Beyond the heuristic above, nothing stops a tunnel that forwards `/` and rewrites `Host` from handing the token to whoever can reach the tunnel.
- **Names you add to `AUTO_ALLOWED_HOSTS`.** Anyone who can reach such a name gets the token. The supervisor prints a warning at start. Use it only behind a proxy or VPN that restricts who can connect, and never with a public tunnel.
- **The token being visible where the page is visible.** Browser extensions with page access, developer tools, the page's in-memory copy (including back/forward cache), and anything that captures the DOM can see the token. `Cache-Control: no-store` keeps the page out of HTTP caches, and the token is never placed in a URL, but a hostile extension is out of scope.
- Physical access, backups, or disk theft. `secrets.json` is plaintext. Use full-disk encryption and review how backups handle `data/`.
- A hostile local administrator or a compromised browser profile.

## Token rotation

Run `auto token rotate` (or `POST /api/token/rotate`, authenticated) if the token may have leaked, or as routine hygiene. The new token file is written atomically with mode `0600`; the old token stops working immediately and open event streams are closed. Replacing `data/.token` by hand revokes the same way: the supervisor compares the file on every request and adopts a new valid token at once (deleting the file makes it generate a fresh one; a file without a valid 64-character hex token is ignored and the current token stays). The response never contains the token. Reload open dashboards: the page then embeds the new token, and a dashboard that sees the old one rejected asks you to reload. The CLI re-reads the token file by itself; any script that cached the token must re-read `data/.token`.

## Webhooks and tunnels

`/hooks/<path>` is the only route intended to be reachable from outside the machine, and only through a tunnel or reverse proxy that you control.

What a `/hooks` tunnel exposes:

- The routes for the webhook triggers you configured, and nothing else. A disabled or paused job, a disabled trigger, or a supervisor that is shutting down answers `503` with `Retry-After: 60` without starting anything, but only to a caller that presented a valid signature.
- Uniform, minimal answers to unauthenticated callers: an unknown path, a wrong method, a missing, malformed, or wrong signature, and a trigger whose secret is not set or unreadable are all the same `401 {"error":"unauthorized"}`, so paths and missing secrets cannot be probed (the supervisor log says why a signed request could not be checked). The one residual signal is `413`, which needs a well-formed signature header plus an oversize body. Bodies are size-capped while streaming (default 1 MiB, at most 10 MiB) and content types are checked after the signature. During a degraded cold start every `/hooks/*` request is `503` with `Retry-After: 60`.
- `/hooks/*` and a minimal `/healthz` (`{"ok":...,"degraded":...}`) are the only routes that skip the `Host` check.

What must not be exposed: `/api`, `/events`, the dashboard (`/`), `/assets`, and the workspace. **The page at `/` carries the API token**, so a tunnel that forwards `/` hands the token to whoever can reach the tunnel, particularly if the tunnel rewrites `Host` to a loopback name. Configure the tunnel to forward only `/hooks/<path>` and to fail closed on everything else. Do not add the tunnel's public hostname to `AUTO_ALLOWED_HOSTS`: that setting serves the token to that host name.

Keep the signature header unchanged through the tunnel; the HMAC covers the exact request bytes.

### Replay and duplicate limits

- Deliveries are deduplicated on the SHA-256 digest of the body within 5 minutes, and on the delivery-id header (when configured) combined with the same body at any age. The delivery-id header alone never suppresses a delivery, so a captured request replayed under an id the real sender will use next cannot pre-empt it.
- The delivery-id header is not covered by the signature and the scheme has no signed timestamp, so a captured, validly signed request can be replayed once the 5-minute window has passed. If the provider signs a timestamp, verify it in the worker.
- A signed request only proves the body came from someone who holds the secret. A `202` means "authenticated and admitted", not that the action succeeded.

## Secrets and log redaction

- `auto secret set` reads the value from a hidden prompt or stdin; values are never printed and never appear in config. `auto secret list` shows names only.
- Secrets exist to verify webhook signatures. Auto does not inject them into workers.
- Run logs replace the exact value of every stored secret with `[redacted:<name>]`, including when the value is split across output chunks. Limits: values shorter than 4 characters are not redacted, and modified forms (base64, URL-encoded, partial substrings) are not caught. Redaction applies to per-run logs, not to the supervisor's own log (`data/state/supervisor.log`). Error messages about a malformed `secrets.json` name the file and never quote its content.

## Response headers

Every response carries `Content-Security-Policy` (`default-src 'self'`, no executable inline scripts or inline styles, `frame-ancestors 'none'`, `form-action 'self'`; the token block in the page is `type="application/json"`, a data block that `script-src` neither runs nor blocks), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. API and shell responses are `Cache-Control: no-store`. Error responses from the API do not include internal messages; details go to the supervisor log.

## File modes

`data/` and every directory under it are `0700`. `data/.token`, `data/secrets.json`, `data/supervisor.lock`, run logs, webhook payloads, and files under `data/state/` are `0600`. The supervisor tightens looser modes at start. On Windows, POSIX modes do not apply; rely on the directory's ACLs.

## Deployment guidance

- Keep the supervisor bound to `127.0.0.1`; there is no setting to change that, and none should be added.
- Do not expose `/api`, `/events`, the dashboard (`/`, which embeds the token), or the workspace through a reverse proxy or tunnel.
- Do not run Auto on a shared multi-user machine: any local user can read the token from `http://127.0.0.1:<port>/`.
- If webhook ingress is required, expose only configured `/hooks/<path>` routes.
- Keep `data/`, `.auto-runtime/`, tokens, secrets, logs, and webhook payloads out of version control and cloud-synced folders.
- Use full-disk encryption and review backup handling for `data/secrets.json`.
- Only put configuration and workers you trust in the workspace; the config file runs as code on every reload.
- Run one workspace per user account. Two users on the same machine should each have their own workspace, data directory, and port.
