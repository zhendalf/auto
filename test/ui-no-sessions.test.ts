import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Browser sessions were removed: the page embeds the API token and the app
// sends it as a bearer header. This keeps cookie, session-exchange and
// "sign in" wording, and credentialed fetches, from creeping back into the UI.

const SRC = join(import.meta.dir, "..", "ui", "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the UI has no cookie sessions", () => {
  const files = sources(SRC).map((p) => ({ p, text: readFileSync(p, "utf8") }));

  test("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const [label, re] of [
    ["cookie", /cookie/i],
    ["auto_session", /auto_session/i],
    ["ui-session or exchange endpoint", /ui-session|\/auth\/exchange/i],
    ["sign in wording", /sign(ed|ing)?[ -]in|not signed/i],
    ["same-origin credentials", /credentials:\s*["']same-origin["']|credentials:\s*["']include["']/],
    ["EventSource", /new EventSource/],
    ["token in a URL", /[?&]token=/],
  ] as const) {
    test(`no ${label}`, () => {
      const hits = files.filter((f) => re.test(f.text)).map((f) => f.p);
      expect(hits).toEqual([]);
    });
  }

  // The bearer header itself is asserted behaviorally in ui-api-client.test.ts and
  // ui-event-stream.test.ts (they call the client and inspect what fetch receives).
  test("no fetch in the API layer sets credentials other than omit", () => {
    const client = readFileSync(join(SRC, "api", "client.ts"), "utf8");
    const credentials = client.match(/credentials:\s*["'][a-z-]+["']/g) ?? [];
    expect(credentials.length).toBeGreaterThan(0);
    expect(credentials.every((c) => /["']omit["']/.test(c))).toBe(true);
  });
});
