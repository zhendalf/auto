// Host checks for the Vite dev plugin (kept free of imports so the root test
// suite can load it). The dev page embeds the live API token, so it must only
// be served to a browser that reached the dev server through a loopback name.

/** `Host` header (with or without a port) naming this machine: 127.0.0.1, localhost, [::1] or *.localhost. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  const name = lower.startsWith("[") ? lower.slice(0, lower.indexOf("]") + 1) : lower.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name.endsWith(".localhost");
}

/**
 * Whether Vite's `server.host` setting makes the dev server reachable from
 * other machines (`--host`, `0.0.0.0`, a LAN address). Unset means loopback only.
 */
export function devServerExposed(host: string | boolean | undefined): boolean {
  if (host === undefined || host === false) return false;
  if (host === true) return true;
  return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
}
