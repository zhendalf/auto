// The dashboard, bundled in memory by the supervisor itself (D-44).
//
// `ui/index.html` is handed to Bun's bundler with the Tailwind plugin the
// first time the dashboard is asked for. The output (one HTML page, hashed
// JS/CSS/SVG under /assets/) lives only in memory, so there is no build step,
// no `ui/dist` and nothing to go stale. Bundling takes well under a second.
// When it fails, the error is kept and the page says so; the API, webhooks and
// scheduler are not affected.

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

export type UiFile = { body: Uint8Array; type: string };

export type UiBuild =
  | {
      ok: true;
      /** The page, before the supervisor injects the bootstrap tag. */
      indexHtml: string;
      /** Everything else, keyed by URL path (`/assets/index-1a2b3c.js`). */
      files: ReadonlyMap<string, UiFile>;
    }
  | { ok: false; error: string };

export type UiSource = {
  /** The current build; the first call bundles (and so does the first call after a source change, when watching). */
  current(): Promise<UiBuild>;
  close(): void;
};

/**
 * Bundle the dashboard in `uiDir` on demand. With `watch`, any change below
 * `uiDir` makes the next request bundle again, so reloading the page shows it.
 */
export function bundledUi(uiDir: string, opts: { watch?: boolean } = {}): UiSource {
  let build: Promise<UiBuild> | null = null;
  let watcher: FSWatcher | null = null;
  if (opts.watch) {
    try {
      watcher = watch(uiDir, { recursive: true }, () => {
        build = null;
      });
    } catch (err) {
      process.stderr.write(`[ui] cannot watch ${uiDir}: ${(err as Error).message}\n`);
    }
  }
  return {
    current() {
      build ??= bundle(uiDir).then((result) => {
        if (!result.ok) process.stderr.write(`[ui] the dashboard could not be bundled:\n${result.error}\n`);
        return result;
      });
      return build;
    },
    close() {
      watcher?.close();
      watcher = null;
    },
  };
}

/** A fixed build from literal files (tests). `index.html` is the page; other keys are URL paths without the leading slash. */
export function staticUi(files: Record<string, string>): UiSource {
  const { "index.html": indexHtml, ...rest } = files;
  const result: UiBuild =
    indexHtml === undefined
      ? { ok: false, error: "no index.html" }
      : {
          ok: true,
          indexHtml,
          files: new Map(
            Object.entries(rest).map(([path, text]) => [
              `/${path}`,
              { body: new TextEncoder().encode(text), type: Bun.file(path).type },
            ]),
          ),
        };
  return { current: async () => result, close() {} };
}

async function bundle(uiDir: string): Promise<UiBuild> {
  try {
    const { default: tailwind } = await import("bun-plugin-tailwind");
    const result = await Bun.build({
      entrypoints: [resolve(uiDir, "index.html")],
      plugins: [tailwind],
      target: "browser",
      minify: true,
      sourcemap: "none",
      // Absolute URLs, so deep links such as /runs/123 load the same assets.
      publicPath: "/",
      naming: {
        entry: "[name].[ext]",
        chunk: "assets/[name]-[hash].[ext]",
        asset: "assets/[name]-[hash].[ext]",
      },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      throw: false,
    });
    if (!result.success) {
      return { ok: false, error: result.logs.map((log) => String(log)).join("\n") || "unknown bundler error" };
    }
    let indexHtml: string | null = null;
    const files = new Map<string, UiFile>();
    for (const output of result.outputs) {
      const path = output.path.replace(/^\.\//, "/");
      if (path === "/index.html") {
        indexHtml = await output.text();
      } else {
        files.set(path, { body: new Uint8Array(await output.arrayBuffer()), type: output.type });
      }
    }
    if (indexHtml === null) return { ok: false, error: "the bundle has no index.html" };
    return { ok: true, indexHtml, files };
  } catch (err) {
    const errors = err instanceof AggregateError ? err.errors : [err];
    return { ok: false, error: errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n") };
  }
}
