/**
 * The supervisor injects one `<script id="auto-bootstrap" type="application/json">`
 * tag into the page it serves at `/`. This parses its text; kept free of the
 * DOM so it can be unit tested. `bootstrap.ts` does the actual lookup.
 */
export type Bootstrap = { token: string; port: number };

/** Shown instead of the app when the page did not come from the supervisor. */
export const NOT_SERVED_MESSAGE =
  "This page was not served by the Auto supervisor. Open the dashboard with: auto ui";

/**
 * The bootstrap data, or null when the tag is missing, is not JSON, or has no
 * usable token (for example `vite preview` or a saved copy of the page).
 * Never throws.
 */
export function parseBootstrap(text: string | null | undefined): Bootstrap | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { token, port } = raw as { token?: unknown; port?: unknown };
  if (typeof token !== "string" || token.trim().length === 0) return null;
  return { token: token.trim(), port: typeof port === "number" ? port : 0 };
}
