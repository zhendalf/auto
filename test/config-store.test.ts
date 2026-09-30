import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigLoadError,
  ConfigStore,
  loadConfigOnce,
  validateConfigFile,
  type Config,
} from "../supervisor/config.ts";

// Hot reload of the config file: the loader subprocess, the store's
// last-known-good / commit-after-apply rules, and the watcher.

let ws: string;
let configPath: string;
let stores: ConfigStore[] = [];

function job(name: string, schedule = "0 3 * * *", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    worker: `./jobs/${name}.ts`,
    triggers: [{ kind: "cron", id: "t", schedule }],
    ...extra,
  };
}

function writeConfig(jobs: unknown[], path = configPath): void {
  writeFileSync(path, `export default ${JSON.stringify(jobs, null, 2)};\n`);
}

function makeWorker(name: string): void {
  writeFileSync(join(ws, "jobs", `${name}.ts`), "console.log('hi');\n");
}

function newStore(opts: ConstructorParameters<typeof ConfigStore>[0] = {}): ConfigStore {
  const store = new ConfigStore({ configPath, workspaceRoot: ws, debounceMs: 20, pollMs: 100, ...opts });
  stores.push(store);
  return store;
}

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition not reached in time");
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "config-store-"));
  mkdirSync(join(ws, "jobs"));
  configPath = join(ws, "auto.config.ts");
  for (const n of ["a", "b", "c"]) makeWorker(n);
  stores = [];
});

afterEach(async () => {
  for (const s of stores) await s.stop();
  rmSync(ws, { recursive: true, force: true });
});

describe("loadConfigOnce sees every edit in one process", () => {
  test("valid change, invalid change, fixed change", async () => {
    writeConfig([job("a")]);
    const opts = { configPath, workspaceRoot: ws };
    expect((await loadConfigOnce(opts)).config.map((j) => j.name)).toEqual(["a"]);

    // Regression: the cache-busting `?ts=` import returned this file's first
    // version forever on Bun 1.4.
    writeConfig([job("a"), job("b")]);
    expect((await loadConfigOnce(opts)).config.map((j) => j.name)).toEqual(["a", "b"]);

    writeConfig([job("a", "not a cron")]);
    await expect(loadConfigOnce(opts)).rejects.toThrow(/schedule/);

    writeConfig([job("c")]);
    expect((await loadConfigOnce(opts)).config.map((j) => j.name)).toEqual(["c"]);
  }, 30_000);

  test("defaults from the schema are applied", async () => {
    writeConfig([job("a")]);
    const { config } = await loadConfigOnce({ configPath, workspaceRoot: ws });
    expect(config[0]).toMatchObject({ reentrancy: "drop", queueDepth: 1, timeoutMs: 600_000, enabled: true });
  });

  test("output the config prints while loading does not disturb the result", async () => {
    writeFileSync(
      configPath,
      `console.log("loading config..."); console.log('@@auto-config-json@@[]');\nexport default ${JSON.stringify([job("a")])};\n`,
    );
    expect((await loadConfigOnce({ configPath, workspaceRoot: ws })).config.map((j) => j.name)).toEqual(["a"]);
  });

  test("a config file that does not exist", async () => {
    await expect(loadConfigOnce({ configPath: join(ws, "nope.ts"), workspaceRoot: ws })).rejects.toThrow(
      /config file not found/,
    );
  });

  test("a file that disappears while it is being loaded is reported as not found", async () => {
    // Stands in for a delete-and-recreate save landing between the existence
    // check and the loader's import: the loader dies, the file is gone.
    writeFileSync(configPath, `import { unlinkSync } from "node:fs";\nunlinkSync(import.meta.path);\nthrow new Error("vanished");\n`);
    await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/config file not found/);
  });

  test("a workspace directory that does not exist is a load error, not a crash", async () => {
    writeConfig([job("a")]);
    const err = await loadConfigOnce({ configPath, workspaceRoot: join(ws, "nope") }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(String(err.message)).toContain("could not start the config loader");
  });

  test("a syntax error carries the loader's stderr", async () => {
    writeFileSync(configPath, "export default [ {{{ ;\n");
    const err = await loadConfigOnce({ configPath, workspaceRoot: ws }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(String(err.message)).toContain("failed to load");
  });

  test("a config that throws while loading", async () => {
    writeFileSync(configPath, `throw new Error("boom from config");\nexport default [];\n`);
    const err = await loadConfigOnce({ configPath, workspaceRoot: ws }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(String(err.message)).toContain("boom from config");
  });

  test("no default export, and non-serializable exports, are clear errors", async () => {
    writeFileSync(configPath, "export const x = 1;\n");
    await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/no default export/);

    writeFileSync(configPath, "export default [() => 1];\n");
    await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/function/);

    writeFileSync(configPath, "export default [{ n: 10n }];\n");
    await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/bigint/);

    writeFileSync(configPath, "const a: any = []; a.push(a); export default a;\n");
    await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/not serializable/);

    writeFileSync(configPath, "export default [{ n: NaN }];\n");
    await expect(loadConfigOnce({ configPath, workspaceRoot: ws })).rejects.toThrow(/finite/);
  }, 30_000);

  test("a config that never finishes loading is killed at the timeout", async () => {
    writeFileSync(configPath, "await new Promise(() => setInterval(() => {}, 1000));\nexport default [];\n");
    const started = Date.now();
    const err = await loadConfigOnce({ configPath, workspaceRoot: ws, timeoutMs: 700 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(String(err.message)).toContain("did not finish loading");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the loader runs in the workspace root with the AUTO_* environment", async () => {
    writeFileSync(
      configPath,
      `export default [{ id: "cwd", name: "cwd", worker: "./jobs/a.ts",
        description: process.cwd() + "|" + process.env.AUTO_HOME + "|" + process.env.TEST_MARKER,
        triggers: [{ kind: "cron", id: "t", schedule: "0 3 * * *" }] }];\n`,
    );
    const { config } = await loadConfigOnce({ configPath, workspaceRoot: ws, env: { TEST_MARKER: "m1" } });
    const [cwd, home, marker] = (config[0]!.description ?? "").split("|");
    // macOS resolves /var -> /private/var for cwd.
    expect(cwd!.endsWith(ws.replace(/^\/private/, ""))).toBe(true);
    expect(home).toBe(ws);
    expect(marker).toBe("m1");
  });

  test("validateConfigFile agrees with loadConfigOnce", async () => {
    writeConfig([job("a")]);
    const ok = await validateConfigFile({ configPath, workspaceRoot: ws });
    expect(ok.ok).toBe(true);
    writeConfig([job("a", "* * *")]);
    const bad = await validateConfigFile({ configPath, workspaceRoot: ws });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('job "a"');
  });
});

describe("ConfigStore hot reload", () => {
  test("valid change is applied, invalid change keeps last-known-good, a fix recovers", async () => {
    writeConfig([job("a")]);
    const applied: string[][] = [];
    const errors: string[] = [];
    const reloaded: string[][] = [];
    const store = newStore({
      apply: (next) => {
        applied.push(next.map((j) => j.name));
      },
    });
    store.on("error", (e: Error) => errors.push(e.message));
    store.on("reloaded", (p: { current: Config }) => reloaded.push(p.current.map((j) => j.name)));

    await store.start();
    expect(store.current?.map((j) => j.name)).toEqual(["a"]);
    expect(store.getStatus().ok).toBe(true);

    // 1. valid change
    writeConfig([job("a"), job("b")]);
    await until(() => store.current?.length === 2);
    expect(applied.at(-1)).toEqual(["a", "b"]);
    expect(reloaded.at(-1)).toEqual(["a", "b"]);

    // 2. invalid change: last-known-good stays, lastError is set, no reloaded
    const reloadedBefore = reloaded.length;
    writeConfig([job("a"), job("b", "nope")]);
    await until(() => store.lastError !== null);
    expect(store.current?.map((j) => j.name)).toEqual(["a", "b"]);
    expect(store.lastError!.message).toContain("schedule");
    expect(store.getStatus().ok).toBe(false);
    expect(errors.at(-1)).toContain("schedule");
    expect(reloaded.length).toBe(reloadedBefore);

    // 3. fixed: recovers and clears the error
    writeConfig([job("c")]);
    await until(() => store.lastError === null);
    expect(store.current?.map((j) => j.name)).toEqual(["c"]);
    expect(store.getStatus().ok).toBe(true);
    expect(reloaded.at(-1)).toEqual(["c"]);
  }, 30_000);

  test("a failing applier keeps last-known-good, reports the error and emits no 'reloaded'", async () => {
    writeConfig([job("a")]);
    let fail = false;
    // A long debounce and poll keep the watcher out of it: only the explicit
    // reload() below applies the change, so the error is reported exactly once.
    const store = newStore({
      debounceMs: 60_000,
      pollMs: 60_000,
      apply: () => {
        if (fail) throw new Error("reconcile exploded");
      },
    });
    const errors: string[] = [];
    let reloads = 0;
    store.on("error", (e: Error) => errors.push(e.message));
    store.on("reloaded", () => reloads++);
    await store.start();

    fail = true;
    writeConfig([job("a"), job("b")]);
    const outcome = await store.reload();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("apply");
      expect(outcome.error).toContain("reconcile exploded");
    }
    expect(store.current?.map((j) => j.name)).toEqual(["a"]);
    expect(store.lastError?.message).toContain("reconcile exploded");
    expect(store.getStatus()).toMatchObject({ ok: false, jobCount: 1 });
    expect(errors).toEqual(["reconcile exploded"]);
    expect(reloads).toBe(0);

    fail = false;
    const again = await store.reload();
    expect(again.ok).toBe(true);
    expect(store.current?.length).toBe(2);
    expect(store.lastError).toBeNull();
    expect(reloads).toBe(1);
  }, 30_000);

  test("current is not committed while the applier is still running", async () => {
    writeConfig([job("a")]);
    let seenDuringApply: Config | null | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const store = newStore({
      apply: async () => {
        calls++;
        if (calls === 2) {
          seenDuringApply = store.current;
          await gate;
        }
      },
    });
    await store.start();
    writeConfig([job("a"), job("b")]);
    const pending = store.reload();
    await until(() => calls === 2);
    expect(seenDuringApply?.length).toBe(1);
    expect(store.current?.length).toBe(1);
    release();
    expect((await pending).ok).toBe(true);
    expect(store.current?.length).toBe(2);
  }, 30_000);

  test("concurrent reload requests are serialized and coalesced", async () => {
    writeConfig([job("a")]);
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const store = newStore({
      apply: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(60);
        running--;
      },
    });
    await store.start();
    calls = 0;
    const results = await Promise.all([store.reload(), store.reload(), store.reload(), store.reload()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxRunning).toBe(1);
    // One running + one shared queued reload at most.
    expect(calls).toBeLessThanOrEqual(2);
  }, 30_000);

  test("a missing config file at start is degraded, then recovers when the file appears", async () => {
    const applied: string[][] = [];
    const store = newStore({ apply: (c) => void applied.push(c.map((j) => j.name)) });
    const errors: string[] = [];
    store.on("error", (e: Error) => errors.push(e.message));
    const loaded: string[] = [];
    store.on("loaded", () => loaded.push("loaded"));

    await store.start();
    expect(store.current).toBeNull();
    expect(store.getStatus().ok).toBe(false);
    expect(errors[0]).toContain("config file not found");

    writeConfig([job("a")]);
    await until(() => store.current !== null);
    expect(applied).toEqual([["a"]]);
    expect(store.lastError).toBeNull();
    expect(loaded).toEqual(["loaded"]);
  }, 30_000);

  test("a missing parent directory at start is picked up once it exists", async () => {
    const dir = join(ws, "later");
    const path = join(dir, "auto.config.ts");
    const store = new ConfigStore({ configPath: path, workspaceRoot: ws, debounceMs: 20, pollMs: 100 });
    stores.push(store);
    store.on("error", () => {});
    await store.start();
    expect(store.current).toBeNull();

    mkdirSync(dir);
    writeConfig([job("a")], path);
    await until(() => store.current !== null);
    expect(store.current?.[0]?.name).toBe("a");
  }, 30_000);

  test("an editor that saves by atomic rename is noticed, repeatedly", async () => {
    writeConfig([job("a")]);
    const store = newStore();
    await store.start();

    for (const [i, name] of ["b", "c", "a"].entries()) {
      const tmp = join(ws, `.auto.config.ts.tmp${i}`);
      writeConfig([job(name)], tmp);
      renameSync(tmp, configPath);
      await until(() => store.current?.[0]?.name === name);
    }
  }, 30_000);

  test("the file being deleted keeps last-known-good; recreating it reloads", async () => {
    writeConfig([job("a")]);
    const store = newStore();
    store.on("error", () => {});
    await store.start();

    rmSync(configPath);
    await until(() => store.lastError !== null);
    expect(store.current?.[0]?.name).toBe("a");
    expect(store.lastError!.message).toContain("config file not found");

    writeConfig([job("b")]);
    await until(() => store.current?.[0]?.name === "b");
    expect(store.lastError).toBeNull();
  }, 30_000);

  test("a change is found by the poll alone when the watcher misses it", async () => {
    writeConfig([job("a")]);
    const store = newStore({ debounceMs: 10, pollMs: 60 });
    await store.start();
    // Make the watcher blind: closing it is what a died watch looks like.
    (store as unknown as { closeWatcher(): void }).closeWatcher();
    writeConfig([job("b")]);
    await until(() => store.current?.[0]?.name === "b");
  }, 30_000);

  test("stop() ends watching: later edits are ignored", async () => {
    writeConfig([job("a")]);
    let calls = 0;
    const store = newStore({ apply: () => void calls++ });
    await store.start();
    await store.stop();
    calls = 0;
    writeConfig([job("b")]);
    await Bun.sleep(400);
    expect(calls).toBe(0);
    expect(store.current?.[0]?.name).toBe("a");
    expect((await store.reload()).ok).toBe(false);
  }, 30_000);
});

describe("ConfigStore status warnings", () => {
  test("a webhook trigger whose secret is missing is reported and clears when it is set", async () => {
    writeConfig([
      {
        id: "hook",
        name: "hook",
        worker: "./jobs/a.ts",
        triggers: [
          {
            kind: "webhook",
            id: "in",
            path: "orders",
            auth: { profile: "hmac-sha256", secretRef: "orders-secret", signatureHeader: "X-Sig" },
          },
        ],
      },
    ]);
    let present = false;
    const store = newStore({ hasSecret: () => present });
    await store.start();
    const w = store.getStatus().warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: "missing_secret", job: "hook", trigger_id: "hook:in" });
    expect(w[0]!.message).toContain("orders-secret");
    expect(w[0]!.message).toContain("/hooks/orders");
    present = true;
    expect(store.getStatus().warnings).toEqual([]);
  }, 30_000);
});
