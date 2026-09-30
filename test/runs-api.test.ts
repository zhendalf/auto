import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunsHandlers } from "../supervisor/api/runs.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import type { Runner } from "../supervisor/runner.ts";

type Row = {
  run_id: string;
  enqueued_at?: number;
  state?: string;
  log_path?: string | null;
  job?: string;
};

let tmp: string;
let dataDir: string;
let outside: string;
let db: Database;
let cancelResult: { ok: boolean; previous_state: string };
let handlers: ReturnType<typeof makeRunsHandlers>;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "runs-api-"));
  dataDir = join(tmp, "data");
  outside = join(tmp, "outside");
  mkdirSync(join(dataDir, "runs"), { recursive: true });
  mkdirSync(outside);
  db = new Database(join(tmp, "test.db"));
  db.run("PRAGMA foreign_keys = ON;");
  await runMigrations(db);
  const now = Date.now();
  for (const name of ["alpha", "beta"]) {
    db.run("INSERT INTO jobs (job_id, name, enabled, last_seen_in_config_at, created_at) VALUES (?, ?, 1, ?, ?)", [name, name, now, now]);
  }
  cancelResult = { ok: false, previous_state: "succeeded" };
  const runner = { cancel: async () => cancelResult } as unknown as Runner;
  handlers = makeRunsHandlers({ db, runner: () => runner, dataDir });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addRun(r: Row): void {
  db.run(
    `INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at, log_path)
     VALUES (?, ?, 'manual', ?, ?, ?)`,
    [r.run_id, r.job ?? "alpha", r.state ?? "succeeded", r.enqueued_at ?? 1_000, r.log_path ?? null],
  );
}

/** A UUIDv7-shaped id: the first 8 hex digits are the (colliding) timestamp bits. */
function id(prefix8: string, tail: string): string {
  // "0190a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b"
  const t = tail.padEnd(24, "0");
  return `${prefix8}-${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}-${t.slice(12, 24)}`;
}

const call = (fn: keyof typeof handlers, path: string, params: Record<string, string> = {}, init?: RequestInit) => {
  const url = new URL(`http://localhost${path}`);
  return handlers[fn](new Request(url.href, init), params, url);
};

describe("run reference resolution", () => {
  const full = "0190a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
  beforeEach(() => {
    addRun({ run_id: full });
    addRun({ run_id: "0190a3b4-1111-7222-8333-444455556666" }); // same timestamp prefix as `full`
    addRun({ run_id: "0190ffff-0000-7000-8000-000000009999" });
  });

  const detail = async (ref: string) => {
    const res = await call("detail", `/api/runs/${ref}`, { run_id: ref });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test("exact full id", async () => {
    const r = await detail(full);
    expect(r.status).toBe(200);
    expect(r.body.run_id).toBe(full);
  });

  test("full id without hyphens and in upper case", async () => {
    expect((await detail(full.replaceAll("-", ""))).body.run_id).toBe(full);
    expect((await detail(full.toUpperCase())).body.run_id).toBe(full);
  });

  test("unique prefix, with or without hyphens, including past the first hyphen", async () => {
    expect((await detail("0190ffff")).body.run_id).toBe("0190ffff-0000-7000-8000-000000009999");
    expect((await detail("0190a3b4-c5d6")).body.run_id).toBe(full);
    expect((await detail("0190a3b4c5d6")).body.run_id).toBe(full);
    expect((await detail("0190a3b4c5d67e8f9a")).body.run_id).toBe(full);
  });

  test("the 8-hex short id (last 8 digits) resolves by unique suffix", async () => {
    const short = full.replaceAll("-", "").slice(-8);
    expect(short).toBe("1c2d3e4f5a6b".slice(-8));
    const r = await detail(short);
    expect(r.status).toBe(200);
    expect(r.body.run_id).toBe(full);
  });

  test("a prefix shared by two runs is ambiguous (409 ambiguous_prefix with candidates)", async () => {
    const r = await detail("0190a3b4");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("ambiguous_prefix");
    expect((r.body.candidates as string[]).length).toBe(2);
  });

  test("a suffix shared by two runs is ambiguous", async () => {
    addRun({ run_id: "01922222-0000-7000-8000-ffffffff0001" });
    addRun({ run_id: "01933333-0000-7000-8000-ffffffff0001" });
    const dup = await detail("ffff0001");
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("ambiguous_prefix");
    expect((dup.body.candidates as string[]).length).toBe(2);
    // A longer suffix that only one of them shares still cannot tell them apart,
    // but the full id does.
    expect((await detail("01922222-0000-7000-8000-ffffffff0001")).status).toBe(200);
  });

  test("unknown reference is 404", async () => {
    expect((await detail("deadbeef")).status).toBe(404);
  });

  test("junk, too-short and over-long references are 400 and never reach SQL patterns", async () => {
    for (const ref of ["abc", "abcde", "zzzzzzzz", "0190a3b4%", "%%%%%%", "______", "0190a3_4", "0190a3b4'--", "a".repeat(33), "-------"]) {
      const r = await detail(ref);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_run_id");
    }
  });

  test("the same resolution applies to log and cancel", async () => {
    const short = full.replaceAll("-", "").slice(-8);
    expect((await call("log", "/x", { run_id: short })).status).toBe(404); // found run, no log yet
    expect((await call("log", "/x", { run_id: "%%%%%%" })).status).toBe(400);
    expect((await call("cancel", "/x", { run_id: "0190a3b4" }, { method: "POST" })).status).toBe(409);
    expect((await call("cancel", "/x", { run_id: "%%%%%%" }, { method: "POST" })).status).toBe(400);
  });
});

describe("list filters and pagination", () => {
  test("state filter is validated against the state enum", async () => {
    addRun({ run_id: id("00000001", "a"), state: "failed" });
    addRun({ run_id: id("00000002", "b"), state: "succeeded" });
    const ok = await call("list", "/api/runs?state=failed");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as unknown[]).length).toBe(1);
    for (const bad of ["bogus", "failed' OR 1=1--", "SUCCEEDED"]) {
      const res = await call("list", `/api/runs?state=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_state");
    }
  });

  test("limit and before are bounded integers; junk is 400", async () => {
    for (const q of ["limit=abc", "limit=0", "limit=-1", "limit=1.5", "limit=1e3", "limit=", "limit=99999999999999999999", "before=abc", "before=0", "before=-5", "before=1.5"]) {
      const res = await call("list", `/api/runs?${q}`);
      expect(res.status).toBe(400);
    }
    // Over the maximum is clamped, not an error.
    expect((await call("list", "/api/runs?limit=100000")).status).toBe(200);
  });

  test("before_id needs before and must look like an id", async () => {
    expect((await call("list", "/api/runs?before_id=abc")).status).toBe(400);
    expect((await call("list", "/api/runs?before=5&before_id=%25")).status).toBe(400);
    expect((await call("list", "/api/runs?before=5&before_id=abc-1")).status).toBe(200);
  });

  test("the body stays a bare array of summaries", async () => {
    addRun({ run_id: id("00000001", "a") });
    const body = await (await call("list", "/api/runs")).json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as Record<string, unknown>[])[0]).toMatchObject({ run_id: id("00000001", "a"), job_name: "alpha" });
  });

  test("runs sharing a millisecond are paged by (enqueued_at, run_id) without skips or repeats", async () => {
    // 7 runs: 5 in the same millisecond, 2 elsewhere.
    const ids = [
      id("00000010", "a"), id("00000010", "b"), id("00000010", "c"), id("00000010", "d"), id("00000010", "e"),
    ];
    for (const rid of ids) addRun({ run_id: rid, enqueued_at: 5_000 });
    addRun({ run_id: id("00000020", "f"), enqueued_at: 6_000 });
    addRun({ run_id: id("00000001", "g"), enqueued_at: 4_000 });

    const seen: string[] = [];
    let path = "/api/runs?limit=2";
    for (let pages = 0; pages < 10; pages++) {
      const res = await call("list", path);
      const rows = (await res.json()) as { run_id: string }[];
      seen.push(...rows.map((r) => r.run_id));
      const before = res.headers.get("x-next-before");
      const beforeId = res.headers.get("x-next-before-id");
      if (!before) {
        expect(beforeId).toBeNull();
        break;
      }
      expect(beforeId).toBeTruthy();
      path = `/api/runs?limit=2&before=${before}&before_id=${beforeId}`;
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
    // Newest first; ties broken by run_id descending.
    expect(seen).toEqual([id("00000020", "f"), ...[...ids].sort().reverse(), id("00000001", "g")]);
  });

  test("the last page carries no cursor headers, and a full page exactly at the limit does not either", async () => {
    addRun({ run_id: id("00000001", "a"), enqueued_at: 1 });
    addRun({ run_id: id("00000002", "b"), enqueued_at: 2 });
    const res = await call("list", "/api/runs?limit=2");
    expect(res.headers.get("x-next-before")).toBeNull();
    const more = await call("list", "/api/runs?limit=1");
    expect(more.headers.get("x-next-before")).toBe("2");
    expect(more.headers.get("x-next-before-id")).toBe(id("00000002", "b"));
  });

  test("job filter is an exact match and an unknown job is an empty list", async () => {
    addRun({ run_id: id("00000001", "a"), job: "alpha" });
    addRun({ run_id: id("00000002", "b"), job: "beta" });
    const rows = (await (await call("list", "/api/runs?job=beta")).json()) as { job_name: string }[];
    expect(rows.map((r) => r.job_name)).toEqual(["beta"]);
    expect(await (await call("list", "/api/runs?job=%25")).json()).toEqual([]);
  });
});

describe("run log", () => {
  const runId = id("00000001", "a");
  const writeLog = (rel: string, content: string) => {
    const abs = join(dataDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };

  test("full log with X-Log-Size and X-Run-State", async () => {
    writeLog("runs/a.log", "hello world\n");
    addRun({ run_id: runId, state: "running", log_path: "runs/a.log" });
    const res = await call("log", "/x", { run_id: runId });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world\n");
    expect(res.headers.get("x-log-size")).toBe("12");
    expect(res.headers.get("x-run-state")).toBe("running");
    expect(res.headers.get("x-log-offset")).toBe("0");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("?offset=N returns the bytes from N; a follower can tail as the log grows", async () => {
    const abs = writeLog("runs/a.log", "hello world\n");
    addRun({ run_id: runId, state: "running", log_path: "runs/a.log" });
    // The query string lives on the URL passed to the handler.
    const url = new URL("http://localhost/api/runs/x/log?offset=6");
    const res = await handlers.log(new Request(url.href), { run_id: runId }, url);
    expect(await res.text()).toBe("world\n");
    expect(res.headers.get("x-log-size")).toBe("12");
    expect(res.headers.get("x-log-offset")).toBe("6");

    appendFileSync(abs, "more\n");
    const url2 = new URL("http://localhost/api/runs/x/log?offset=12");
    const res2 = await handlers.log(new Request(url2.href), { run_id: runId }, url2);
    expect(await res2.text()).toBe("more\n");
    expect(res2.headers.get("x-log-size")).toBe("17");
  });

  test("offset at the end is an empty 200; past the end is 416 with the size; junk is 400", async () => {
    writeLog("runs/a.log", "abc");
    addRun({ run_id: runId, log_path: "runs/a.log" });
    const get = (q: string) => {
      const url = new URL(`http://localhost/x?${q}`);
      return handlers.log(new Request(url.href), { run_id: runId }, url);
    };
    const end = await get("offset=3");
    expect(end.status).toBe(200);
    expect(await end.text()).toBe("");
    const past = await get("offset=4");
    expect(past.status).toBe(416);
    expect(past.headers.get("x-log-size")).toBe("3");
    expect(((await past.json()) as { error: string }).error).toBe("offset_out_of_range");
    for (const bad of ["offset=-1", "offset=abc", "offset=1.5", "offset=", "offset=99999999999999999999"]) {
      expect((await get(bad)).status).toBe(400);
    }
  });

  test("a run with no log yet is 404 no_log, with state and size headers", async () => {
    addRun({ run_id: runId, state: "queued", log_path: null });
    const res = await call("log", "/x", { run_id: runId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_log");
    expect(res.headers.get("x-run-state")).toBe("queued");
    expect(res.headers.get("x-log-size")).toBe("0");
  });

  test("a log file that does not exist is 404 log_missing", async () => {
    addRun({ run_id: runId, log_path: "runs/none.log" });
    const res = await call("log", "/x", { run_id: runId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("log_missing");
  });

  test("log paths that escape the data dir are refused (dotdot, absolute, symlink)", async () => {
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(join(outside, "secret.txt"), join(dataDir, "runs", "link.log"));
    symlinkSync(outside, join(dataDir, "runs", "linkdir"));
    const cases = ["../outside/secret.txt", join(outside, "secret.txt"), "runs/link.log", "runs/linkdir/secret.txt", "runs/../../outside/secret.txt"];
    let n = 0;
    for (const log_path of cases) {
      const rid = id("0000000" + (n++), "c");
      addRun({ run_id: rid, log_path });
      const res = await call("log", "/x", { run_id: rid });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });

  test("a directory is not served as a log", async () => {
    mkdirSync(join(dataDir, "runs", "adir"));
    addRun({ run_id: runId, log_path: "runs/adir" });
    expect((await call("log", "/x", { run_id: runId })).status).toBe(404);
  });
});

describe("cancel", () => {
  test("refuses an oversize declared body and reports 409 for a finished run", async () => {
    const rid = id("00000001", "a");
    addRun({ run_id: rid });
    const url = new URL("http://localhost/x");
    const res = await handlers.cancel(new Request(url.href, { method: "POST" }), { run_id: rid }, url);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_finished", previous_state: "succeeded" });

    const big = await handlers.cancel(new Request(url.href, { method: "POST", body: "x".repeat(8 * 1024) }), { run_id: rid }, url);
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe("payload_too_large");
  });

  test("a chunked oversize body is refused too", async () => {
    const rid = id("00000001", "a");
    addRun({ run_id: rid });
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 100) { c.close(); return; }
        c.enqueue(new Uint8Array(1024));
      },
    });
    const url = new URL("http://localhost/x");
    const req = new Request(url.href, {
      method: "POST",
      body: stream,
      duplex: "half",
    });
    const res = await handlers.cancel(req, { run_id: rid }, url);
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(20);
  });

  test("success returns ok and the previous state", async () => {
    const rid = id("00000001", "a");
    addRun({ run_id: rid, state: "running" });
    cancelResult = { ok: true, previous_state: "running" };
    const res = await call("cancel", "/x", { run_id: rid }, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, previous_state: "running" });
  });
});
