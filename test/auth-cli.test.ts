import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiClient, ApiError } from "../cli/client.ts";
import { openerCommand, runUi } from "../cli/commands/ui.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import { startServer, type ServerHandle } from "../supervisor/server.ts";

describe("openerCommand", () => {
  test("picks the opener per platform", () => {
    const u = "http://127.0.0.1:7777/";
    expect(openerCommand("darwin", u)).toEqual(["open", u]);
    expect(openerCommand("linux", u)).toEqual(["xdg-open", u]);
    expect(openerCommand("win32", u)).toEqual(["cmd", "/c", "start", "", u]);
    expect(openerCommand("aix", u)).toBeNull();
  });
});

type Live = { tmp: string; db: Database; server: ServerHandle; client: ApiClient; tokenPath: string };
let live: Live | null = null;

async function boot(): Promise<Live> {
  const tmp = mkdtempSync(join(tmpdir(), "auth-cli-"));
  const tokenPath = join(tmp, ".token");
  const db = new Database(join(tmp, "t.db"));
  await runMigrations(db);
  const server = await startServer({
    db,
    registry: () => null,
    cronAdapter: () => null,
    runner: () => null,
    configStore: () => null,
    port: 0,
    uiDistDir: join(tmp, "no-dist"),
    tokenPath,
    dataDir: tmp,
    heartbeatMs: 60_000,
  });
  const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, tokenFile: tokenPath });
  live = { tmp, db, server, client, tokenPath };
  return live;
}

afterEach(async () => {
  if (!live) return;
  await live.server.stop();
  live.db.close();
  rmSync(live.tmp, { recursive: true, force: true });
  live = null;
});

/** Capture what a command writes to stdout/stderr. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((err += String(c)), true)) as typeof process.stderr.write;
  try {
    return { result: await fn(), out, err };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

describe("ApiClient: rotateToken / eventsUrl", () => {
  test("the sign-in helpers are gone", async () => {
    const { client } = await boot();
    expect((client as unknown as Record<string, unknown>).uiSession).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).exchangeUrl).toBeUndefined();
    const res = await fetch(client.url("/api/ui-session"), {
      method: "POST",
      headers: { authorization: `Bearer ${client.token}` },
    });
    expect(res.status).toBe(404);
  });

  test("eventsUrl() has no token in it", async () => {
    const { client } = await boot();
    expect(client.eventsUrl()).toBe(`${client.baseUrl}/events`);
  });

  test("rotateToken() swaps the token and the client follows the new token file", async () => {
    const { client, server, tokenPath } = await boot();
    const old = client.token;
    const res = await client.rotateToken();
    expect(res.ok).toBe(true);
    expect(res.message).toContain("reload");
    const fresh = readFileSync(tokenPath, "utf8").trim();
    expect(fresh).not.toBe(old);
    expect(client.token).toBe(fresh);
    expect(server.token).toBe(fresh);
    // The client keeps working after rotating.
    expect((await client.configStatus()).ok).toBe(false); // no config store in this fixture
    // A second client still holding the old token is locked out.
    const stale = new ApiClient({ baseUrl: client.baseUrl, tokenFile: join(tokenPath + ".old") });
    (stale as unknown as { cachedToken: string }).cachedToken = old;
    await expect(stale.configStatus()).rejects.toBeInstanceOf(ApiError);
  });

  test("refreshToken() re-reads the token file", async () => {
    const { client, server } = await boot();
    expect(client.token).toBe(server.token);
    await client.rotateToken();
    expect(client.refreshToken()).toBe(server.token);
  });
});

describe("auto ui", () => {
  test("opens the plain dashboard URL and prints it", async () => {
    const { client } = await boot();
    const opened: string[] = [];
    const { result, out, err } = await capture(() =>
      runUi({
        client,
        open: async (u) => {
          opened.push(u);
          return true;
        },
      }),
    );
    expect(result).toBe(0);
    expect(opened).toEqual([`${client.baseUrl}/`]);
    expect(out.trim()).toBe(`${client.baseUrl}/`);
    // No credential in the URL, and nothing about signing in.
    expect(opened[0]).not.toContain(client.token);
    expect(opened[0]).not.toContain("?");
    expect(err).toBe("");
    // The URL just works: the page carries the token for the dashboard.
    const page = await (await fetch(opened[0]!)).text();
    expect(page).toContain(client.token);
  });

  test("does not need the token file at all", async () => {
    const { client } = await boot();
    const dir = mkdtempSync(join(tmpdir(), "auth-cli-notoken-"));
    try {
      const noToken = new ApiClient({ baseUrl: client.baseUrl, tokenFile: join(dir, "nope") });
      const { result } = await capture(() => runUi({ client: noToken, open: async () => true }));
      expect(result).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("browser could not be opened: still prints the URL and exits 0", async () => {
    const { client } = await boot();
    const { result, out, err } = await capture(() => runUi({ client, open: async () => false }));
    expect(result).toBe(0);
    expect(out.trim()).toBe(`${client.baseUrl}/`);
    expect(err).toContain("could not open a browser");
  });

  test("supervisor unreachable: prints the URL, exits 3 with a hint, never opens a browser", async () => {
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", tokenFile: "/nonexistent/.token", timeoutMs: 500 });
    let opened = false;
    const { result, out, err } = await capture(() => runUi({ client, open: async () => ((opened = true), true) }));
    expect(result).toBe(3);
    expect(opened).toBe(false);
    expect(out.trim()).toBe("http://127.0.0.1:1/");
    expect(err).toContain("unreachable");
    expect(err).toContain("auto install");
    expect(err).toContain("auto svc start");
  });
});
