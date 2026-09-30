import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient } from "../cli/client.ts";
import { createLogSink, followRun } from "../cli/follow.ts";
import { setGlobals } from "../cli/runtime.ts";
import { fakeRunId, startFakeApi, type Fake } from "./cli-fake-api.ts";
import { CLI_MAIN, ROOT, makeWorkspace, runAuto } from "./cli-harness.ts";

const ws = makeWorkspace(1);
// process.on("exit") never runs under `bun test`, which leaked a temp dir per run.
afterAll(() => ws.cleanup());

let fake: Fake;
beforeEach(() => {
  fake = startFakeApi();
});
afterEach(async () => {
  await fake.stop();
  setGlobals({ json: false, yes: false });
});

const RUN = fakeRunId("aaaa1111");
const OTHER = fakeRunId("bbbb2222"); // same first 8 hex digits as RUN

function auto(args: string[], opts: { stdin?: string } = {}) {
  return runAuto(ws, [...args, "--base-url", fake.baseUrl, "--token-file", fake.tokenFile], opts);
}

function seedRun(over: Partial<import("./cli-fake-api.ts").FakeRun> = {}, id = RUN): void {
  fake.runs.set(id, {
    run_id: id,
    job_name: "hello",
    state: "succeeded",
    exit_code: 0,
    duration_ms: 1200,
    log: "line one\nline two\n",
    ...over,
  });
}

const callsTo = (fragment: string) => fake.calls.filter((c) => c.path.includes(fragment));

describe("run ids", () => {
  test("`auto runs` shows the last 8 hex digits, which differ between runs that share a timestamp prefix", async () => {
    seedRun({}, RUN);
    seedRun({ job_name: "other" }, OTHER);
    const r = await auto(["runs"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aaaa1111");
    expect(r.stdout).toContain("bbbb2222");
    // the ambiguous first 8 digits are not what is shown
    expect(r.stdout).not.toContain("01a0eea2");
  });

  test("`auto log <short id>` sends exactly that id to the API, which resolves it", async () => {
    seedRun();
    seedRun({ log: "other log\n" }, OTHER);
    const r = await auto(["log", "bbbb2222"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("other log\n");
    expect(callsTo("/api/runs/bbbb2222").length).toBeGreaterThan(0);
  });

  test("a reference the API rejects gets a helpful message, not a stack trace", async () => {
    const r = await auto(["log", "zzzzzz"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no run matching 'zzzzzz'");
    expect(r.stderr).not.toContain("at ");
  });
});

describe("large output", () => {
  test("a multi-megabyte log piped to another process is not cut off when the CLI exits", async () => {
    const big = ("x".repeat(70) + "\n").repeat(40_000); // 2.8 MB, far beyond a pipe buffer
    seedRun({ log: big });
    const log = await auto(["log", "aaaa1111"]);
    expect(log.code).toBe(0);
    expect(log.stdout.length).toBe(big.length);
    const last = await auto(["last", "hello"]);
    expect(last.code).toBe(0);
    expect(last.stdout.length).toBeGreaterThan(big.length);
    const jsonLog = await auto(["--json", "log", "aaaa1111"]);
    expect((JSON.parse(jsonLog.stdout) as { lines: string[] }).lines).toHaveLength(40_000);
  }, 30_000);
});

describe("auto run", () => {
  test("a run that succeeds exits 0 and prints its output", async () => {
    seedRun();
    const r = await auto(["run", "hello"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("line one\nline two\n");
    expect(r.stderr).toContain("started run aaaa1111");
    expect(r.stderr).toContain("succeeded in 1s");
  });

  test.each([
    ["failed", 1, "failed in"],
    ["timed_out", 1, "timed out"],
    ["killed", 1, "killed"],
    ["cancelled", 1, "cancelled"],
  ])("state %s exits %d", async (state, code, text) => {
    seedRun({ state, exit_code: state === "failed" ? 3 : null });
    const r = await auto(["run", "hello"]);
    expect(r.code).toBe(code);
    expect(r.stderr).toContain(text);
  });

  test("failed shows the worker's exit code", async () => {
    seedRun({ state: "failed", exit_code: 3 });
    expect((await auto(["run", "hello"])).stderr).toContain("(exit 3)");
  });

  test("a queued (202) result says the position and is followed to the end", async () => {
    seedRun({ state: "queued", log: null });
    fake.startResponse = () => Response.json({ run_id: RUN, position: 2 }, { status: 202 });
    // it starts running, then finishes, while the CLI waits
    setTimeout(() => {
      const run = fake.runs.get(RUN)!;
      run.state = "running";
      run.log = "working\n";
    }, 500);
    setTimeout(() => {
      const run = fake.runs.get(RUN)!;
      run.state = "succeeded";
      run.log = "working\ndone\n";
    }, 1100);
    const r = await auto(["run", "hello"]);
    expect(r.stderr).toContain("queued at position 2");
    expect(r.stdout).toBe("working\ndone\n");
    expect(r.code).toBe(0);
  });

  test("a conflict exits 4 and points at --force", async () => {
    fake.startResponse = () => Response.json({ error: "conflict", running_run_id: RUN }, { status: 409 });
    const r = await auto(["run", "hello"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("--force");
    expect(r.stderr).toContain("aaaa1111");
    const start = callsTo("/api/jobs/hello/run")[0]!;
    expect(JSON.parse(start.body!).force).toBe(false);
  });

  test("--force is sent to the API", async () => {
    seedRun();
    const r = await auto(["run", "hello", "--force"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(callsTo("/api/jobs/hello/run")[0]!.body!).force).toBe(true);
  });

  test("-y confirms the retry after a conflict; --force alone is not needed", async () => {
    seedRun();
    let attempts = 0;
    fake.startResponse = (_name, body) => {
      attempts++;
      return body.force === true
        ? Response.json({ run_id: RUN })
        : Response.json({ error: "conflict", running_run_id: OTHER }, { status: 409 });
    };
    const r = await auto(["-y", "run", "hello"]);
    expect(attempts).toBe(2);
    expect(r.code).toBe(0);
  });

  test("a conflict that survives --force is still exit 4", async () => {
    fake.startResponse = () => Response.json({ error: "conflict", running_run_id: RUN }, { status: 409 });
    expect((await auto(["run", "hello", "--force"])).code).toBe(4);
  });

  test("an unknown job exits 1", async () => {
    fake.startResponse = () => Response.json({ error: "not_found" }, { status: 404 });
    const r = await auto(["run", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown job: nope");
  });

  test("a disabled job says how to enable it", async () => {
    fake.startResponse = () => Response.json({ error: "skipped", reason: "disabled" }, { status: 422 });
    const r = await auto(["run", "hello"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("auto enable hello");
  });

  test("--json keeps stdout machine-readable: one JSON object per line, status on stderr", async () => {
    seedRun();
    const r = await auto(["--json", "run", "hello"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.slice(0, 2)).toEqual([
      { run_id: RUN, line: "line one" },
      { run_id: RUN, line: "line two" },
    ]);
    expect(lines[2]).toMatchObject({ run_id: RUN, state: "succeeded", exit_code: 0, duration_ms: 1200 });
    expect(r.stderr).toContain("started run");
  });
});

describe("following a run that finished before the stream was live", () => {
  test("the event stream never says anything, yet the follower exits on the first poll", async () => {
    seedRun(); // already succeeded; no run.finished event will ever arrive
    const started = Date.now();
    const r = await auto(["log", "aaaa1111", "--follow"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("line one\nline two\n");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a failed run exits 1 under --follow", async () => {
    seedRun({ state: "failed", exit_code: 2 });
    expect((await auto(["log", "aaaa1111", "-f"])).code).toBe(1);
  });

  test("re-fetches the run through the API after the event stream opens", async () => {
    // No X-Run-State header on log reads, so only GET /api/runs/:id can reveal the state.
    seedRun({ state: "running", stateHeader: false });
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    let text = "";
    const pending = followRun(client, { runId: RUN, out: (t) => (text += t), pollMs: 50 });
    await Bun.sleep(600);
    expect(fake.sseConnects()).toBeGreaterThan(0);
    // the run finishes without any run.finished event
    fake.runs.get(RUN)!.state = "succeeded";
    const result = await pending;
    expect(result).toMatchObject({ kind: "finished", state: "succeeded", exitCode: 0 });
    expect(text).toBe("line one\nline two\n");
    const detailCalls = fake.calls.filter((c) => c.method === "GET" && c.path === `/api/runs/${RUN}`);
    expect(detailCalls.length).toBeGreaterThan(1);
  });

  test("a run.finished event wakes the follower without waiting for the next poll", async () => {
    seedRun({ state: "running" });
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    const started = Date.now();
    const pending = followRun(client, { runId: RUN, out: () => {}, pollMs: 60_000 });
    await Bun.sleep(500);
    fake.runs.get(RUN)!.state = "succeeded";
    fake.emit("run.finished", { run_id: RUN, state: "succeeded" });
    const result = await pending;
    expect(result.kind).toBe("finished");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("the event stream is authenticated with a header, never a query string", async () => {
    seedRun();
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    await followRun(client, { runId: RUN, out: () => {}, pollMs: 20 });
    const sse = fake.calls.filter((c) => c.path.startsWith("/events"));
    for (const c of sse) {
      expect(c.path).toBe("/events");
      expect(c.authorization).toBe("Bearer fake-token");
    }
  });

  test("Ctrl-C (abort) detaches and reports it", async () => {
    seedRun({ state: "running" });
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    const abort = new AbortController();
    const pending = followRun(client, { runId: RUN, out: () => {}, pollMs: 50, signal: abort.signal });
    await Bun.sleep(200);
    abort.abort();
    expect((await pending).kind).toBe("detached");
  });

  test("gives up with `unreachable` when the supervisor disappears mid-follow", async () => {
    seedRun({ state: "running" });
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile, timeoutMs: 500 });
    let text = "";
    const pending = followRun(client, {
      runId: RUN,
      out: (t) => (text += t),
      pollMs: 50,
      unreachableGraceMs: 400,
    });
    await Bun.sleep(300);
    await fake.stop();
    expect((await pending).kind).toBe("unreachable");
    expect(text).toBe("line one\nline two\n");
  });

  test("a multi-byte character split across two log reads is not mangled", async () => {
    const full = "café ✓ done\n";
    const bytes = new TextEncoder().encode(full);
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", tokenFile: fake.tokenFile });
    let reads = 0;
    client.runLogFrom = async (_id, offset) => {
      reads++;
      const slice = reads === 1 ? bytes.slice(0, cut) : bytes.slice(offset);
      return { bytes: slice, size: bytes.length, state: reads === 1 ? "running" : "succeeded", missing: false, outOfRange: false };
    };
    client.run = async () =>
      ({ run_id: RUN, state: "succeeded", exit_code: 0, duration_ms: 5 }) as Awaited<ReturnType<ApiClient["run"]>>;
    let text = "";
    const result = await followRun(client, { runId: RUN, out: (t) => (text += t), pollMs: 10, useSse: false });
    expect(result.kind).toBe("finished");
    expect(text).toBe(full);
  });
});

describe("Ctrl-C", () => {
  test("`auto run` detaches on SIGINT: exit 130, the run keeps going, and the message says how to reattach", async () => {
    seedRun({ state: "running", log: "still going\n" });
    const child = Bun.spawn(
      [process.execPath, CLI_MAIN, "run", "hello", "--base-url", fake.baseUrl, "--token-file", fake.tokenFile],
      { cwd: ROOT, env: ws.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const deadline = Date.now() + 10_000;
    while (!fake.calls.some((c) => c.path.includes("/log")) && Date.now() < deadline) await Bun.sleep(50);
    await Bun.sleep(300);
    child.kill("SIGINT");
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(130);
    expect(stdout).toBe("still going\n");
    expect(stderr).toContain("detached");
    expect(stderr).toContain("auto log aaaa1111 --follow");
    expect(fake.calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  }, 30_000);
});

describe("log sink", () => {
  test("json mode emits complete lines only, and flushes a trailing partial line at the end", () => {
    setGlobals({ json: true });
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const sink = createLogSink("r1");
      sink.write("one\ntw");
      sink.write("o\r\nthree");
      sink.end();
    } finally {
      process.stdout.write = original;
    }
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { run_id: "r1", line: "one" },
      { run_id: "r1", line: "two" },
      { run_id: "r1", line: "three" },
    ]);
  });
});

describe("auto cancel", () => {
  test("cancelling a queued run needs no confirmation", async () => {
    seedRun({ state: "queued", log: null });
    const r = await auto(["cancel", "aaaa1111"]);
    expect(r.code).toBe(0);
    expect(callsTo("/cancel")).toHaveLength(1);
    expect(r.stderr).toContain("cancelled run aaaa1111 (was queued)");
  });

  test("cancelling a RUNNING run asks first; with nobody to ask it refuses and cancels nothing", async () => {
    seedRun({ state: "running" });
    const r = await auto(["cancel", "aaaa1111"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("-y");
    expect(callsTo("/cancel")).toHaveLength(0);
  });

  test("-y cancels a running run", async () => {
    seedRun({ state: "running" });
    const r = await auto(["cancel", "aaaa1111", "-y"]);
    expect(r.code).toBe(0);
    expect(callsTo("/cancel")).toHaveLength(1);
    expect(r.stderr).toContain("was running");
  });

  test("a job name cancels the job's active run", async () => {
    seedRun({ state: "running" });
    fake.jobs.set("hello", {
      name: "hello",
      active_run: { run_id: RUN, state: "running", started_at: 1 },
      recent_runs: [],
    });
    const r = await auto(["-y", "cancel", "hello"]);
    expect(r.code).toBe(0);
    expect(callsTo(`/api/runs/${RUN}/cancel`)).toHaveLength(1);
  });

  test("a job with nothing active says so", async () => {
    fake.jobs.set("hello", { name: "hello", active_run: null, recent_runs: [] });
    const r = await auto(["cancel", "hello"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no queued or running run");
  });

  test("an id that is already finished is not an error", async () => {
    seedRun({ state: "succeeded" });
    const r = await auto(["cancel", "aaaa1111"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("already finished");
  });

  test("something that is neither a run nor a job exits 1", async () => {
    const r = await auto(["cancel", "nothing"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no run or job matching 'nothing'");
  });

  test("a hex-looking job name falls back to the job when no run has that id", async () => {
    fake.jobs.set("deadbeef", {
      name: "deadbeef",
      active_run: { run_id: RUN, state: "queued", started_at: null },
      recent_runs: [],
    });
    seedRun({ state: "queued", log: null });
    const r = await auto(["cancel", "deadbeef"]);
    expect(r.code).toBe(0);
    expect(callsTo(`/api/runs/${RUN}/cancel`)).toHaveLength(1);
  });
});
