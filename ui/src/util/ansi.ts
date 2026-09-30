/**
 * ANSI SGR handling for run logs. Workers print colored output; the log
 * viewer shows the sixteen basic colors, bold, dim, italic and underline as
 * styled spans and removes everything else (other escape sequences, cursor
 * movement, stray control characters). Output is data, never markup: callers
 * render `segments` as React text nodes, so nothing here can inject HTML.
 */

export type AnsiState = {
  /** 0-7 normal, 8-15 bright; null is the default color. */
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};

export type AnsiSegment = AnsiState & { text: string };

export const INITIAL_ANSI_STATE: AnsiState = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

// CSI ... final byte. `m` is SGR (applied); every other final byte is dropped.
const CSI = /\x1b\[([0-?]*)([ -/]*[@-~])/y;
// A CSI cut off at the end of the text (no final byte yet): dropped.
const CSI_TRUNCATED = /\x1b\[[0-?]*[ -/]*$/y;
// OSC (window title, hyperlinks): up to BEL or ST. An unterminated one is
// dropped to the end of the line.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/y;
// Any other two-byte escape (charset selection, keypad mode, ...).
const OTHER_ESC = /\x1b[@-Z\\-_`a-~0-9=>]|\x1b[ -/][0-~]/y;
// Control characters that mean nothing in a log (tab and newline are kept).
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

function applySgr(state: AnsiState, params: string): AnsiState {
  const next = { ...state };
  // "38;5;123" style colors use ";" (or ":"); an empty list means reset.
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (!Number.isFinite(c)) continue;
    if (c === 0) Object.assign(next, INITIAL_ANSI_STATE);
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 22) {
      next.bold = false;
      next.dim = false;
    } else if (c === 23) next.italic = false;
    else if (c === 24) next.underline = false;
    else if (c >= 30 && c <= 37) next.fg = c - 30;
    else if (c === 39) next.fg = null;
    else if (c >= 40 && c <= 47) next.bg = c - 40;
    else if (c === 49) next.bg = null;
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8;
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8;
    else if (c === 38 || c === 48) {
      // Extended colors: only the first sixteen of the 256 palette are
      // rendered; true color and the rest are consumed and ignored.
      const mode = codes[i + 1];
      if (mode === 5) {
        const n = codes[i + 2];
        if (n !== undefined && n >= 0 && n < 16) {
          if (c === 38) next.fg = n;
          else next.bg = n;
        }
        i += 2;
      } else if (mode === 2) {
        i += 4;
      }
    }
  }
  return next;
}

/**
 * Parse one line (or any run of text) into styled segments, starting from
 * `state`. Returns the state at the end so a caller can continue with the
 * next line. Empty segments are omitted.
 */
export function parseAnsi(
  text: string,
  state: AnsiState = INITIAL_ANSI_STATE,
): { segments: AnsiSegment[]; state: AnsiState } {
  const segments: AnsiSegment[] = [];
  let current = state;
  let buf = "";
  const flush = () => {
    if (buf) segments.push({ ...current, text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch !== 0x1b) {
      // Copy the run up to the next escape in one go.
      let j = text.indexOf("\x1b", i);
      if (j === -1) j = text.length;
      buf += text.slice(i, j).replace(CONTROL, "");
      i = j;
      continue;
    }
    CSI.lastIndex = i;
    const csi = CSI.exec(text);
    if (csi) {
      if (csi[2] === "m") {
        flush();
        current = applySgr(current, csi[1] ?? "");
      }
      i = CSI.lastIndex;
      continue;
    }
    CSI_TRUNCATED.lastIndex = i;
    if (CSI_TRUNCATED.exec(text)) {
      i = text.length;
      continue;
    }
    OSC.lastIndex = i;
    if (OSC.exec(text)) {
      i = OSC.lastIndex;
      continue;
    }
    OTHER_ESC.lastIndex = i;
    if (OTHER_ESC.exec(text)) {
      i = OTHER_ESC.lastIndex;
      continue;
    }
    // A lone ESC (or one cut off at the end of the text): drop it.
    i += 1;
  }
  flush();
  return { segments, state: current };
}

/** The text without any escape sequences or control characters. */
export function stripAnsi(text: string): string {
  return parseAnsi(text)
    .segments.map((s) => s.text)
    .join("");
}
