/**
 * Shared Tailwind class strings, so buttons, inputs and panels look the same
 * on every page. Colors come from the tokens in styles.css (light and dark).
 */
const BASE_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

export const BTN = `${BASE_BTN} border border-line-strong bg-surface text-fg hover:bg-sunken`;
export const BTN_PRIMARY = `${BASE_BTN} bg-accent text-on-accent hover:bg-accent-hover`;
export const BTN_DANGER = `${BASE_BTN} border border-bad-fg/50 bg-surface text-bad-fg hover:bg-bad-bg`;
export const BTN_SM = "px-2 py-1 text-xs";
/** Add to a button that carries aria-pressed: the pressed state is visible, not only announced. */
export const TOGGLE =
  "aria-pressed:border-info-fg/50 aria-pressed:bg-info-bg aria-pressed:text-info-fg";

export const INPUT =
  "rounded-md border border-line-strong bg-surface px-2 py-1 text-sm text-fg placeholder:text-subtle";

export const CARD = "rounded-lg border border-line bg-surface p-4";
export const H2 = "mb-2 text-xs font-semibold uppercase tracking-wide text-muted";
export const TH = "py-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted";

export const NOTE_OK = "rounded-md border border-ok-fg/40 bg-ok-bg px-3 py-2 text-sm text-ok-fg";
export const NOTE_WARN = "rounded-md border border-warn-fg/40 bg-warn-bg px-3 py-2 text-sm text-warn-fg";
export const NOTE_BAD = "rounded-md border border-bad-fg/40 bg-bad-bg px-3 py-2 text-sm text-bad-fg";
export const NOTE_INFO = "rounded-md border border-info-fg/40 bg-info-bg px-3 py-2 text-sm text-info-fg";

export const CODE = "rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em] text-fg";
