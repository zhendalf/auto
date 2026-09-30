import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoTokenPlugin } from "../ui/vite-plugin-auto-token.ts";

// The Vite dev page embeds the live API token, so the plugin's wiring is what
// keeps that token off the LAN. The pure helpers are tested elsewhere; this
// drives the plugin's hooks the way Vite does.

const TOKEN = "ab".repeat(32);
const KEYS = ["AUTO_HOME", "AUTO_DATA_DIR", "AUTO_PORT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vite-plugin-"));
  mkdirSync(join(tmp, "data"));
  writeFileSync(join(tmp, "data", ".token"), `${TOKEN}\n`);
  process.env.AUTO_HOME = tmp;
  process.env.AUTO_DATA_DIR = join(tmp, "data");
  process.env.AUTO_PORT = "17777";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

type Hook<T> = (...args: any[]) => T;

function setup(serverHost: string | boolean | undefined) {
  const warnings: string[] = [];
  const plugin = autoTokenPlugin() as any;
  (plugin.configResolved as Hook<void>)({ server: { host: serverHost }, logger: { warn: (m: string) => warnings.push(m) } });
  const page = (plugin.transformIndexHtml as Hook<string>)("<html><head></head><body></body></html>");
  const middlewares: Array<(req: any, res: any, next: () => void) => void> = [];
  (plugin.configureServer as Hook<void>)({ middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => middlewares.push(fn) } });
  return { page, warnings, middlewares };
}

function ask(middlewares: Array<(req: any, res: any, next: () => void) => void>, host: string | undefined) {
  const out = { status: 200, body: "", nexted: false };
  const res = {
    set statusCode(v: number) { out.status = v; },
    setHeader() {},
    end(text: string) { out.body = text; },
  };
  middlewares[0]!({ headers: { host } }, res, () => { out.nexted = true; });
  return out;
}

describe("the dev page token", () => {
  test("a loopback-only dev server puts the token and the supervisor port in the page", () => {
    const { page } = setup(undefined);
    expect(page).toContain(`"token":"${TOKEN}"`);
    expect(page).toContain('"port":17777');
    expect(page.indexOf("auto-bootstrap")).toBeLessThan(page.indexOf("</head>"));
  });

  test("a dev server reachable from other machines (--host) never puts the token in the page", () => {
    for (const host of [true, "0.0.0.0", "192.168.1.5"]) {
      const { page, warnings } = setup(host);
      expect(page).toContain('"token":""');
      expect(page).not.toContain(TOKEN);
      expect(warnings.join(" ")).toContain("NOT injected");
    }
    for (const host of [undefined, false, "localhost", "127.0.0.1"] as const) {
      expect(setup(host).page).toContain(TOKEN);
    }
  });

  test("a Host that is not this machine gets 403 before anything is served; loopback names pass", () => {
    const { middlewares } = setup(undefined);
    for (const host of ["192.168.1.5:5173", "evil.example", "10.0.0.2", undefined]) {
      const out = ask(middlewares, host);
      expect(out.status).toBe(403);
      expect(out.nexted).toBe(false);
      expect(out.body).not.toContain(TOKEN);
    }
    for (const host of ["localhost:5173", "127.0.0.1:5173", "[::1]:5173", "app.localhost:5173"]) {
      const out = ask(middlewares, host);
      expect(out.nexted).toBe(true);
      expect(out.status).toBe(200);
    }
  });
});
