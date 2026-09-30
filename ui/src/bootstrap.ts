import { parseBootstrap } from "./util/bootstrap.ts";
import type { Bootstrap } from "./util/bootstrap.ts";

export { NOT_SERVED_MESSAGE } from "./util/bootstrap.ts";

let cached: { value: Bootstrap | null } | null = null;

/**
 * Reads the `<script id="auto-bootstrap" type="application/json">` blob that
 * the supervisor injects into the page it serves at `/` (and the Vite dev
 * plugin injects in dev): `{"token": "...", "port": 7777}`. Returns null when
 * the tag is missing or has no token, so `main.tsx` can show a message
 * instead of a blank page. Never throws.
 */
export function loadBootstrap(): Bootstrap | null {
  if (!cached) {
    cached = { value: parseBootstrap(document.getElementById("auto-bootstrap")?.textContent) };
  }
  return cached.value;
}

/**
 * Bootstrap data for the API client. `token` is empty when the page carried
 * none (the app is not mounted in that case, so nothing normally asks); the
 * request then simply gets a 401.
 *
 * `baseUrl` is intentionally relative: in dev, Vite at :5173 proxies `/api`
 * and `/events` to the supervisor; in prod, the supervisor itself serves both.
 */
export function getBootstrap(): { token: string; port: number; baseUrl: string } {
  const b = loadBootstrap();
  return { token: b?.token ?? "", port: b?.port ?? 0, baseUrl: "" };
}
