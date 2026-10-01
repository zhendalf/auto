import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { bundledUi, staticUi, type UiSource } from "../supervisor/ui-bundle.ts";

// The supervisor bundles the dashboard itself (no build step, D-44), so this is
// the check that the real ui/ still bundles, and bundles into something the
// server's CSP allows.

const UI_DIR = resolve(import.meta.dir, "..", "ui");
const sources: UiSource[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of sources.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function track(s: UiSource): UiSource {
  sources.push(s);
  return s;
}

describe("the real dashboard", () => {
  test("bundles into one page plus hashed assets under /assets/", async () => {
    const build = await track(bundledUi(UI_DIR)).current();
    if (!build.ok) throw new Error(build.error);

    const paths = [...build.files.keys()];
    expect(paths.every((p) => p.startsWith("/assets/"))).toBe(true);
    const js = paths.filter((p) => p.endsWith(".js"));
    const css = paths.filter((p) => p.endsWith(".css"));
    expect(js).toHaveLength(1);
    expect(css).toHaveLength(1);
    expect(paths.some((p) => p.endsWith(".svg"))).toBe(true);

    // Absolute URLs, so /runs/<id> loads the same files; nothing inline (CSP: script-src 'self', style-src 'self').
    expect(build.indexHtml).toContain(`src="${js[0]}"`);
    expect(build.indexHtml).toContain(`href="${css[0]}"`);
    expect(build.indexHtml).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(build.indexHtml).not.toContain("<style");
    expect(build.indexHtml).toContain("</head>");
  });

  test("Tailwind ran: theme tokens, dark mode and utilities are in the CSS", async () => {
    const build = await track(bundledUi(UI_DIR)).current();
    if (!build.ok) throw new Error(build.error);
    const [, css] = [...build.files].find(([p]) => p.endsWith(".css"))!;
    const text = new TextDecoder().decode(css.body);
    expect(text).not.toContain('@import "tailwindcss"');
    expect(text).toContain("--page:");
    expect(text).toContain("prefers-color-scheme:dark");
    // `bg-surface` comes from the `@theme inline` block, so it proves the theme was applied to scanned sources.
    expect(text).toContain(".bg-surface{");
  });

  test("React is the production build", async () => {
    const build = await track(bundledUi(UI_DIR)).current();
    if (!build.ok) throw new Error(build.error);
    const [, js] = [...build.files].find(([p]) => p.endsWith(".js"))!;
    const text = new TextDecoder().decode(js.body);
    expect(text).not.toContain("react-dom.development");
    expect(text).not.toContain("process.env.NODE_ENV");
  });

  test("bundles once and reuses the result", async () => {
    const ui = track(bundledUi(UI_DIR));
    const first = ui.current();
    expect(ui.current()).toBe(first);
  });
});

function scratchUi(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-bundle-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head></head><body><script type="module" src="./main.ts"></script></body></html>`);
  writeFileSync(join(dir, "main.ts"), script);
  return dir;
}

describe("bundledUi", () => {
  test("a source error is reported, not thrown", async () => {
    const dir = scratchUi(`import "./missing.ts";`);
    const build = await track(bundledUi(dir)).current();
    expect(build.ok).toBe(false);
    if (!build.ok) expect(build.error).toContain("missing.ts");
  });

  test("a missing ui directory is reported, not thrown", async () => {
    const build = await track(bundledUi(join(tmpdir(), `no-ui-${process.pid}-${Date.now()}`))).current();
    expect(build.ok).toBe(false);
  });

  test("with watch, a source change is bundled again on the next request", async () => {
    const dir = scratchUi(`console.log("first");`);
    const ui = track(bundledUi(dir, { watch: true }));
    const before = await ui.current();
    if (!before.ok) throw new Error(before.error);

    writeFileSync(join(dir, "main.ts"), `console.log("second");`);
    const deadline = Date.now() + 5_000;
    let text = "";
    while (Date.now() < deadline) {
      const after = await ui.current();
      if (after.ok) {
        text = [...after.files.values()].map((f) => new TextDecoder().decode(f.body)).join("");
        if (text.includes("second")) break;
      }
      await Bun.sleep(50);
    }
    expect(text).toContain("second");
  });

  test("without watch, the first build is kept", async () => {
    const dir = scratchUi(`console.log("first");`);
    const ui = track(bundledUi(dir));
    const before = await ui.current();
    writeFileSync(join(dir, "main.ts"), `console.log("second");`);
    await Bun.sleep(200);
    expect(await ui.current()).toBe(before);
  });
});

describe("staticUi", () => {
  test("keys become URL paths with a content type from the extension", async () => {
    const build = await staticUi({ "index.html": "<html></html>", "assets/a.css": "x{}" }).current();
    if (!build.ok) throw new Error("expected ok");
    expect(build.files.get("/assets/a.css")?.type).toContain("text/css");
  });
});
