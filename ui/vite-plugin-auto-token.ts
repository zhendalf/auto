import type { Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { devServerExposed, isLoopbackHostHeader } from "./dev-host.ts";

/** Port of the supervisor the dev server proxies to (AUTO_PORT, default 7777). */
export function devSupervisorPort(): number {
  return Number(process.env.AUTO_PORT || "7777");
}

/**
 * Where the supervisor keeps its token for the selected workspace: the data
 * directory from AUTO_DATA_DIR, else `<AUTO_HOME>/data`, else the default
 * workspace (`~/.auto/data`).
 */
export function devTokenPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home && !process.env.AUTO_HOME && !process.env.AUTO_DATA_DIR) {
    throw new Error("HOME (or USERPROFILE) is not set");
  }
  const workspace = resolve(process.env.AUTO_HOME || resolve(home ?? "", ".auto"));
  const dataDir = resolve(process.env.AUTO_DATA_DIR || resolve(workspace, "data"));
  return resolve(dataDir, ".token");
}

/**
 * The current API token, or null when the file is absent or unreadable. Read
 * on every call so a supervisor restart or token rotation is picked up by
 * reloading the page, without restarting Vite.
 */
export function readDevToken(): string | null {
  try {
    const path = devTokenPath();
    if (!existsSync(path)) return null;
    const token = readFileSync(path, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Dev-only Vite plugin that mirrors the supervisor's bootstrap injection: one
 * `<script id="auto-bootstrap">` tag before `</head>` carrying
 * `{"token": "...", "port": N}`, which is how the supervisor-served page
 * looks in production. The `index.html` source has no placeholder, so the
 * served document has exactly one tag in either mode. With no token file yet,
 * the tag carries only the port and the app shows its "not served by the
 * supervisor" message.
 */
export function autoTokenPlugin(): Plugin {
  const port = devSupervisorPort();
  // Set when Vite listens beyond loopback (`vite --host`): the token is then
  // never put in the page, because anyone on the network could fetch it.
  let exposed = false;
  return {
    name: "auto-token",
    apply: "serve",
    configResolved(cfg) {
      exposed = devServerExposed(cfg.server.host);
      if (exposed) {
        cfg.logger.warn(
          "[auto-token] the dev server is reachable from other machines (server.host / --host); " +
            "the API token is NOT injected into the page. Bind Vite to localhost to use the dashboard.",
        );
      }
      try {
        const tokenPath = devTokenPath();
        if (!existsSync(tokenPath)) {
          cfg.logger.warn(
            `[auto-token] ${tokenPath} not found; the dev page cannot authenticate. Start the supervisor first, then reload.`,
          );
        }
      } catch (err) {
        cfg.logger.warn(`[auto-token] ${(err as Error).message}`);
      }
    },
    configureServer(server) {
      // A name that is not loopback (a LAN address is accepted by Vite's own
      // host check) never gets the page, so the token cannot leave this machine.
      server.middlewares.use((req, res, next) => {
        if (isLoopbackHostHeader(req.headers.host)) return next();
        res.statusCode = 403;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("The Auto dev server only answers on localhost, 127.0.0.1 and [::1].\n");
      });
    },
    transformIndexHtml(html) {
      const token = exposed ? "" : (readDevToken() ?? "");
      // `</` is escaped so the JSON can never close its own script tag.
      const bootstrap = JSON.stringify({ token, port }).replace(/<\//g, "<\\/");
      const scriptTag = `<script id="auto-bootstrap" type="application/json">${bootstrap}</script>`;
      const idx = html.indexOf("</head>");
      if (idx >= 0) {
        return html.slice(0, idx) + scriptTag + html.slice(idx);
      }
      return scriptTag + html;
    },
  };
}
