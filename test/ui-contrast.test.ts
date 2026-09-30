import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Text colors must stay readable in both color schemes. The tokens live in
 * ui/src/styles.css; this reads them, so editing a color that breaks 4.5:1
 * fails here instead of in someone's dark-mode dashboard.
 */
const css = readFileSync(new URL("../ui/src/styles.css", import.meta.url), "utf8");

function block(start: RegExp): Record<string, string> {
  const m = start.exec(css);
  if (!m) throw new Error(`block not found: ${start}`);
  let depth = 0;
  let i = css.indexOf("{", m.index);
  const from = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) break;
  }
  const body = css.slice(from + 1, i);
  const out: Record<string, string> = {};
  for (const d of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[d[1]!] = d[2]!;
  return out;
}

const light = block(/^:root\s*\{/m);
const dark = { ...light, ...block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/) };

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS: [string, string][] = [
  ["fg", "page"],
  ["fg", "surface"],
  ["muted", "page"],
  ["muted", "surface"],
  ["muted", "sunken"],
  ["subtle", "page"],
  ["subtle", "surface"],
  ["subtle", "sunken"],
  ["link", "page"],
  ["link", "surface"],
  ["on-accent", "accent"],
  ["on-accent", "accent-hover"],
  ["ok-fg", "ok-bg"],
  ["bad-fg", "bad-bg"],
  ["warn-fg", "warn-bg"],
  ["orange-fg", "orange-bg"],
  ["info-fg", "info-bg"],
  ["neutral-fg", "neutral-bg"],
  ["log-fg", "log-bg"],
];

describe("color tokens meet 4.5:1", () => {
  for (const [scheme, tokens] of [["light", light], ["dark", dark]] as const) {
    for (const [fg, bg] of PAIRS) {
      test(`${scheme}: ${fg} on ${bg}`, () => {
        expect(tokens[fg]).toBeDefined();
        expect(tokens[bg]).toBeDefined();
        expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("ANSI colors are readable on the log background", () => {
    for (let n = 0; n < 16; n++) {
      const m = new RegExp(`\\.ansi-fg-${n}\\s*\\{\\s*color:\\s*(#[0-9a-fA-F]{6})`).exec(css);
      expect(m).not.toBeNull();
      expect(contrast(m![1]!, light["log-bg"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(m![1]!, dark["log-bg"]!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
