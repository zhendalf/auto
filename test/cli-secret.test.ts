import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretStore } from "../supervisor/secrets.ts";
import { readSecrets, withSecretsLock, writeSecrets } from "../cli/commands/secret.ts";
import { makeWorkspace, runAuto, type Workspace } from "./cli-harness.ts";

const made: Workspace[] = [];
function fresh(): Workspace {
  const ws = makeWorkspace(1);
  mkdirSync(ws.data, { recursive: true, mode: 0o700 });
  made.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of made.splice(0)) ws.cleanup();
});

const secretsPath = (ws: Workspace) => join(ws.data, "secrets.json");
const load = (ws: Workspace) => JSON.parse(readFileSync(secretsPath(ws), "utf8")) as { version: number; secrets: Record<string, string> };

describe("auto secret", () => {
  test("set reads the value from stdin and stores it mode 0600; list shows names only", async () => {
    const ws = fresh();
    const set = await runAuto(ws, ["secret", "set", "gh-hook"], { stdin: "s3cr3t-value\n" });
    expect(set.code).toBe(0);
    expect(set.stdout).toBe("");
    expect(load(ws)).toEqual({ version: 1, secrets: { "gh-hook": "s3cr3t-value" } });
    expect(statSync(secretsPath(ws)).mode & 0o777).toBe(0o600);

    const list = await runAuto(ws, ["secret", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toBe("gh-hook\n");
    expect(list.stdout + list.stderr).not.toContain("s3cr3t-value");
    const json = await runAuto(ws, ["--json", "secret", "list"]);
    expect(JSON.parse(json.stdout)).toEqual({ secrets: ["gh-hook"] });
  });

  test("--stdin is accepted explicitly and strips exactly one trailing newline", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["secret", "set", "--stdin", "a-key"], { stdin: "value with spaces \n\n" });
    expect(r.code).toBe(0);
    expect(load(ws).secrets["a-key"]).toBe("value with spaces \n");
  });

  test("the supervisor's own store reads what the CLI wrote", async () => {
    const ws = fresh();
    await runAuto(ws, ["secret", "set", "gh-hook"], { stdin: "abcdef123" });
    const store = new SecretStore(secretsPath(ws));
    expect(store.get("gh-hook")).toBe("abcdef123");
  });

  test("set updates an existing secret and says so", async () => {
    const ws = fresh();
    await runAuto(ws, ["secret", "set", "k-one"], { stdin: "first-value" });
    const r = await runAuto(ws, ["secret", "set", "k-one"], { stdin: "second-value" });
    expect(r.stderr).toContain("updated");
    expect(load(ws).secrets["k-one"]).toBe("second-value");
  });

  test("bad names are usage errors; empty values are refused; short values are flagged", async () => {
    const ws = fresh();
    expect((await runAuto(ws, ["secret", "set", "Bad_Name"], { stdin: "x" })).code).toBe(2);
    const empty = await runAuto(ws, ["secret", "set", "empty"], { stdin: "\n" });
    expect(empty.code).toBe(1);
    expect(existsSync(secretsPath(ws))).toBe(false);
    const short = await runAuto(ws, ["secret", "set", "tiny"], { stdin: "ab" });
    expect(short.code).toBe(0);
    expect(short.stderr).toContain("shorter than 4 characters");
  });

  test("remove deletes one secret and reports a missing one", async () => {
    const ws = fresh();
    await runAuto(ws, ["secret", "set", "one-key"], { stdin: "value-one" });
    await runAuto(ws, ["secret", "set", "two-key"], { stdin: "value-two" });
    expect((await runAuto(ws, ["secret", "remove", "one-key"])).code).toBe(0);
    expect(Object.keys(load(ws).secrets)).toEqual(["two-key"]);
    const again = await runAuto(ws, ["secret", "remove", "one-key"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("not found");
  });

  test("list with no secrets says so on stderr and prints nothing on stdout", async () => {
    const ws = fresh();
    const r = await runAuto(ws, ["secret", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no secrets");
  });

  test("many `secret set` commands at once all persist (the read-modify-write is locked)", async () => {
    const ws = fresh();
    const count = 12;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        runAuto(ws, ["secret", "set", `key-${i}`], { stdin: `value-number-${i}` }),
      ),
    );
    expect(results.map((r) => r.code)).toEqual(Array(count).fill(0));
    const secrets = load(ws).secrets;
    expect(Object.keys(secrets).sort()).toEqual(
      Array.from({ length: count }, (_, i) => `key-${i}`).sort(),
    );
    for (let i = 0; i < count; i++) expect(secrets[`key-${i}`]).toBe(`value-number-${i}`);
    // no lock or temp files left behind
    expect(readdirSync(ws.data).sort()).toEqual(["secrets.json"]);
    expect(statSync(secretsPath(ws)).mode & 0o777).toBe(0o600);
  }, 60_000);

  test("a set and a remove racing each other lose nothing", async () => {
    const ws = fresh();
    for (let i = 0; i < 4; i++) await runAuto(ws, ["secret", "set", `old-${i}`], { stdin: `old-value-${i}` });
    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => runAuto(ws, ["secret", "remove", `old-${i}`])),
      ...Array.from({ length: 4 }, (_, i) => runAuto(ws, ["secret", "set", `new-${i}`], { stdin: `new-value-${i}` })),
    ]);
    expect(Object.keys(load(ws).secrets).sort()).toEqual(["new-0", "new-1", "new-2", "new-3"]);
  }, 60_000);

  test("a damaged secrets file is reported and never overwritten", async () => {
    const ws = fresh();
    writeFileSync(secretsPath(ws), "{ this is not json", { mode: 0o600 });
    const set = await runAuto(ws, ["secret", "set", "new-key"], { stdin: "some-value" });
    expect(set.code).toBe(1);
    expect(set.stderr).toContain("not valid JSON");
    expect(readFileSync(secretsPath(ws), "utf8")).toBe("{ this is not json");
    expect((await runAuto(ws, ["secret", "list"])).code).toBe(1);
    expect((await runAuto(ws, ["secret", "remove", "x"])).code).toBe(1);

    writeFileSync(secretsPath(ws), JSON.stringify({ version: 2, secrets: {} }));
    chmodSync(secretsPath(ws), 0o600);
    expect((await runAuto(ws, ["secret", "set", "new-key"], { stdin: "some-value" })).stderr).toContain(
      "does not look like an Auto secrets file",
    );
    writeFileSync(secretsPath(ws), JSON.stringify({ version: 1, secrets: { a: 5 } }));
    chmodSync(secretsPath(ws), 0o600);
    expect((await runAuto(ws, ["secret", "list"])).code).toBe(1);
  });

  test("a secrets file readable by others is tightened when rewritten, and flagged by list", async () => {
    const ws = fresh();
    writeFileSync(secretsPath(ws), JSON.stringify({ version: 1, secrets: { "old-key": "old-value" } }));
    chmodSync(secretsPath(ws), 0o644);
    const list = await runAuto(ws, ["secret", "list"]);
    expect(list.stderr).toContain("mode 644");
    expect(statSync(secretsPath(ws)).mode & 0o777).toBe(0o644); // list only reads
    const set = await runAuto(ws, ["secret", "set", "new-key"], { stdin: "new-value" });
    expect(set.stderr).toContain("tightened to 600");
    expect(statSync(secretsPath(ws)).mode & 0o777).toBe(0o600);
    expect(Object.keys(load(ws).secrets).sort()).toEqual(["new-key", "old-key"]);
  });
});

describe("locking", () => {
  test("concurrent read-modify-writes with a slow critical section all persist", async () => {
    const ws = fresh();
    const script = join(import.meta.dir, "fixtures", "secret-rmw.ts");
    const procs = ["one", "two", "three", "four"].map((n) =>
      Bun.spawn([process.execPath, script, secretsPath(ws), `k-${n}`, `v-${n}`], { stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(Object.keys(load(ws).secrets).sort()).toEqual(["k-four", "k-one", "k-three", "k-two"]);
  }, 30_000);

  test("`secret set` waits while another process holds the lock, then completes", async () => {
    const ws = fresh();
    const lock = `${secretsPath(ws)}.lock`;
    writeFileSync(lock, String(process.pid)); // a live holder (this test process)
    const pending = runAuto(ws, ["secret", "set", "waits-key"], { stdin: "waits-value" });
    await Bun.sleep(800);
    expect(existsSync(secretsPath(ws))).toBe(false); // still blocked
    rmSync(lock);
    const r = await pending;
    expect(r.code).toBe(0);
    expect(load(ws).secrets["waits-key"]).toBe("waits-value");
  }, 30_000);
});

describe("secrets file primitives", () => {
  test("a lock left by a dead process is taken over", () => {
    const ws = fresh();
    const path = secretsPath(ws);
    writeFileSync(`${path}.lock`, "2147483646"); // no such pid
    let ran = false;
    withSecretsLock(() => {
      ran = true;
    }, path);
    expect(ran).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a very old lock is taken over even if its pid is alive", () => {
    const ws = fresh();
    const path = secretsPath(ws);
    writeFileSync(`${path}.lock`, String(process.pid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, old, old);
    expect(withSecretsLock(() => "done", path)).toBe("done");
  });

  test("the lock is released when the callback throws", () => {
    const ws = fresh();
    const path = secretsPath(ws);
    expect(() =>
      withSecretsLock(() => {
        throw new Error("boom");
      }, path),
    ).toThrow("boom");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("writeSecrets publishes atomically with mode 0600 and readSecrets round-trips", () => {
    const ws = fresh();
    const path = secretsPath(ws);
    writeSecrets({ version: 1, secrets: { "a-key": "a-value" } }, path);
    expect(readSecrets(path)).toEqual({ version: 1, secrets: { "a-key": "a-value" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(ws.data)).toEqual(["secrets.json"]);
  });
});
