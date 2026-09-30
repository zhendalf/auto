// The CLI against a real supervisor running in a temporary workspace (never
// through Bun cron, never the real data directory).
//
// The tests share one supervisor and run in file order: later ones use the runs
// and secrets that earlier ones created (for example `runs --job quick`). They
// are not independent, so `-t <name>` and `--randomize` are not supported for
// this file; run it whole.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_MAIN,
  LIVE_CONFIG,
  LIVE_PORT,
  LIVE_WORKERS,
  ROOT,
  makeWorkspace,
  runAuto,
  startSupervisor,
  writeWorkspaceFiles,
  type LiveSupervisor,
  type Workspace,
} from "./cli-harness.ts";

let ws: Workspace;
let sup: LiveSupervisor;

const auto = (args: string[], opts?: { stdin?: string }) => runAuto(ws, args, opts);
const json = async <T>(args: string[]): Promise<T> => JSON.parse((await auto(["--json", ...args])).stdout) as T;
const shortOf = (runId: string) => runId.replace(/-/g, "").slice(-8);

beforeAll(async () => {
  ws = makeWorkspace(LIVE_PORT);
  writeWorkspaceFiles(ws, LIVE_CONFIG, LIVE_WORKERS);
  sup = await startSupervisor(ws);
}, 30_000);

afterAll(async () => {
  await sup?.stop();
  ws?.cleanup();
}, 30_000);

type JobJson = {
  name: string;
  enabled: boolean;
  paused_until: number | null;
  triggers: { trigger_id: string; kind: string; enabled: boolean; next_run_at?: number | null }[];
  active_run?: { run_id: string; state: string } | null;
};

async function spawnCli(args: string[]) {
  const child = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    cwd: ROOT,
    env: ws.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    done: Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
      ([code, stdout, stderr]) => ({ code, stdout, stderr }),
    ),
  };
}

async function waitFor<T>(fn: () => Promise<T | null | false>, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

describe("jobs and job", () => {
  test("`auto jobs` lists state, triggers, last run and next run", async () => {
    const r = await auto(["jobs"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+STATE\s+TRIGGERS\s+LAST RUN\s+NEXT RUN$/);
    const quick = lines.find((l) => l.startsWith("quick "))!;
    expect(quick).toMatch(/enabled\s+cron\s+-\s+\d{4}-\d\d-\d\d \d\d:\d\d \(in /);
    const hooked = lines.find((l) => l.startsWith("hooked "))!;
    expect(hooked).toMatch(/enabled\s+webhook\s+-\s+-$/);
  });

  test("`auto jobs --json` is the API's list, with next_run_at on cron triggers", async () => {
    const jobs = await json<JobJson[]>(["jobs"]);
    expect(jobs.map((j) => j.name).sort()).toEqual(["boom", "hooked", "quick", "slow"]);
    const at = jobs.find((j) => j.name === "quick")!.triggers[0]!.next_run_at!;
    expect(at).toBeGreaterThan(Date.now());
    expect(new Date(at).getMinutes()).toBe(0);
  });

  test("`auto job` shows per-trigger schedule, next run, precise timeouts and webhook details", async () => {
    const quick = (await auto(["job", "quick"])).stdout;
    expect(quick).toMatch(/^STATE\s+enabled$/m);
    expect(quick).toMatch(/^NEXT RUN\s+\d{4}-\d\d-\d\d \d\d:\d\d \(in /m);
    expect(quick).toContain("quick:morning  cron  enabled");
    expect(quick).toMatch(/schedule\s+0 9 \* \* \*/);
    expect(quick).toMatch(/next run\s+\d{4}-/);
    // 5_400_000 ms is 1h30m, not "2h"
    expect(quick).toMatch(/^TIMEOUT\s+1h30m\s+\(kill grace 10s\)$/m);
    expect(quick).toContain("RECENT RUNS (0)");

    const hooked = (await auto(["job", "hooked"])).stdout;
    expect(hooked).toContain("hooked:gh  webhook  enabled");
    expect(hooked).toMatch(/endpoint\s+POST \/hooks\/gh-hook/);
    expect(hooked).toMatch(/secret\s+gh-secret\s+NOT SET: run `auto secret set gh-secret`/);
    expect(hooked).toMatch(/sig header\s+x-signature/);
    expect(hooked).toMatch(/id header\s+x-delivery/);
    expect(hooked).not.toMatch(/next run/);

    // setting the secret is seen by the supervisor without a restart
    expect((await auto(["secret", "set", "gh-secret"], { stdin: "topsecretvalue" })).code).toBe(0);
    const after = await waitFor(async () => {
      const out = (await auto(["job", "hooked"])).stdout;
      return /secret\s+gh-secret\s+\(set\)/.test(out) ? out : null;
    }, "the secret to show as set");
    expect(after).not.toContain("topsecretvalue");
  }, 30_000);

  test("unknown job", async () => {
    const r = await auto(["job", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown job: nope");
  });
});

describe("running jobs and reading their history", () => {
  test("`auto run` follows the job and exits 0 on success", async () => {
    const r = await auto(["run", "quick"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("quick says hi\n");
    expect(r.stderr).toMatch(/started run [0-9a-f]{8}/);
    expect(r.stderr).toMatch(/succeeded in \d+/);
  });

  test("a failing job exits 1 and says the exit code", async () => {
    const r = await auto(["run", "boom"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("about to fail\n");
    expect(r.stderr).toContain("(exit 3)");
  });

  test("two runs started back to back have different short ids and each short id finds its own run", async () => {
    await auto(["run", "quick"]);
    await auto(["run", "quick"]);
    await auto(["run", "boom"]);
    const runs = await json<{ run_id: string; job_name: string; state: string }[]>(["runs", "-n", "50"]);
    expect(runs.length).toBeGreaterThanOrEqual(5);
    // the first 8 hex digits of a UUIDv7 are timestamp bits: they collide across these runs
    const firsts = runs.map((r) => r.run_id.replace(/-/g, "").slice(0, 8));
    expect(new Set(firsts).size).toBeLessThan(runs.length);
    const shorts = runs.map((r) => shortOf(r.run_id));
    expect(new Set(shorts).size).toBe(runs.length);

    // the table shows the short ids
    const table = (await auto(["runs", "-n", "50"])).stdout;
    for (const s of shorts) expect(table).toContain(s);

    // every short id resolves to exactly its run, via log
    for (const r of runs) {
      const log = await auto(["--json", "log", shortOf(r.run_id)]);
      expect(log.code).toBe(0);
      const body = JSON.parse(log.stdout) as { run_id: string; lines: string[] };
      expect(body.run_id).toBe(r.run_id);
      expect(body.lines[0]).toBe(r.job_name === "boom" ? "about to fail" : "quick says hi");
    }
  }, 60_000);

  test("a run can be found by a longer prefix and by the full id", async () => {
    const [run] = await json<{ run_id: string }[]>(["runs", "-n", "1"]);
    const full = run!.run_id;
    for (const ref of [full, full.replace(/-/g, "").slice(0, 12), full.slice(0, 13)]) {
      const r = await auto(["log", ref]);
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
    }
  });

  test("a prefix shared by several runs is reported as ambiguous, listing the candidates", async () => {
    const runs = await json<{ run_id: string }[]>(["runs", "-n", "50"]);
    const prefix = runs[0]!.run_id.replace(/-/g, "").slice(0, 8);
    const r = await auto(["log", prefix]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("matches more than one run");
    // The short ids `auto runs` prints, not full UUIDs.
    expect(r.stderr).toContain(shortOf(runs[0]!.run_id));
    expect(r.stderr).not.toContain(runs[0]!.run_id);
  });

  test("`auto runs` filters by job and state", async () => {
    const boom = await json<{ job_name: string; state: string }[]>(["runs", "--job", "boom"]);
    expect(boom.length).toBeGreaterThan(0);
    expect(boom.every((r) => r.job_name === "boom")).toBe(true);
    const failed = await json<{ state: string }[]>(["runs", "--state", "failed"]);
    expect(failed.every((r) => r.state === "failed")).toBe(true);
    const bad = await auto(["runs", "--state", "bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown state 'bogus'; use one of:");
    expect(bad.stderr).toContain("succeeded");
    // A job that does not exist is not "no runs".
    const nope = await auto(["runs", "--job", "no-such-job"]);
    expect(nope.code).toBe(1);
    expect(nope.stderr).toContain("unknown job: no-such-job");
  });

  test("`auto last` shows the most recent run and its log; unknown and never-run jobs are told apart", async () => {
    const last = await auto(["last", "boom"]);
    expect(last.code).toBe(0);
    expect(last.stdout).toContain("about to fail");
    const never = await auto(["last", "slow"]);
    expect(never.code).toBe(1);
    expect(never.stderr).toContain("has not run yet");
    const unknown = await auto(["last", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown job: nope");
  });

  test("`auto jobs` and `auto job` then show the last run", async () => {
    const jobs = (await auto(["jobs"])).stdout;
    expect(jobs.split("\n").find((l) => l.startsWith("boom "))).toMatch(/failed (just now|\S+ ago)/);
    expect(jobs.split("\n").find((l) => l.startsWith("quick "))).toMatch(/succeeded (just now|\S+ ago)/);
    const detail = (await auto(["job", "boom"])).stdout;
    expect(detail).toMatch(/RECENT RUNS \(\d+\)/);
    expect(detail).toMatch(/failed\s+3\s/);
  });

  test("--json output of run/log --follow stays parseable line by line", async () => {
    const r = await auto(["--json", "run", "quick"]);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ line: "quick says hi" });
    expect(lines[lines.length - 1]).toMatchObject({ state: "succeeded", exit_code: 0 });
  });
});

describe("controlling jobs", () => {
  test("pause, unpause, disable and enable show up in `auto jobs`", async () => {
    const row = async (name: string) => (await auto(["jobs"])).stdout.split("\n").find((l) => l.startsWith(`${name} `))!;

    expect((await auto(["pause", "quick", "90m"])).code).toBe(0);
    expect(await row("quick")).toMatch(/paused until \d{4}-\d\d-\d\d \d\d:\d\d\s+cron\s+.*\s-$/);
    expect((await auto(["pause", "quick", "off"])).code).toBe(0);
    expect(await row("quick")).toMatch(/enabled/);

    expect((await auto(["disable", "quick"])).code).toBe(0);
    expect(await row("quick")).toMatch(/disabled/);
    const skipped = await auto(["run", "quick"]);
    expect(skipped.code).toBe(1);
    expect(skipped.stderr).toContain("auto enable quick");
    expect((await auto(["enable", "quick"])).code).toBe(0);
    expect(await row("quick")).toMatch(/enabled/);
    expect(await row("quick")).toMatch(/\(in /);
  });

  test("trigger disable shows (off) and removes the next run; enable brings it back", async () => {
    const row = async () => (await auto(["jobs"])).stdout.split("\n").find((l) => l.startsWith("boom "))!;
    expect((await auto(["trigger", "disable", "boom:hourly"])).code).toBe(0);
    expect(await row()).toMatch(/cron\(off\)\s.*\s-$/);
    expect((await auto(["trigger", "enable", "boom:hourly"])).code).toBe(0);
    expect(await row()).toMatch(/cron\s+.*\(in /);
    const bad = await auto(["trigger", "enable", "boom"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("job-name:trigger-id");
  });

  test("pause with a bad duration is a usage error", async () => {
    expect((await auto(["pause", "quick", "soon"])).code).toBe(2);
  });
});

describe("a run that is in progress", () => {
  test("shows as running, blocks a second run (exit 4 with a --force hint), and cancel asks first", async () => {
    const first = await spawnCli(["run", "slow"]);
    try {
      await waitFor(async () => {
        const jobs = await json<JobJson[]>(["jobs"]);
        return jobs.find((j) => j.name === "slow")?.active_run?.state === "running" ? true : null;
      }, "slow to be running");

      const table = (await auto(["jobs"])).stdout.split("\n").find((l) => l.startsWith("slow "))!;
      expect(table).toMatch(/\brunning\b/);
      expect((await auto(["job", "slow"])).stdout).toMatch(/^ACTIVE RUN\s+[0-9a-f]{8}\s+running$/m);

      const second = await auto(["run", "slow"]);
      expect(second.code).toBe(4);
      expect(second.stderr).toContain("--force");

      // without -y and without a terminal, cancelling a running run is refused
      const refused = await auto(["cancel", "slow"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("-y");
      expect((await json<JobJson[]>(["jobs"])).find((j) => j.name === "slow")?.active_run?.state).toBe("running");

      const cancelled = await auto(["-y", "cancel", "slow"]);
      expect(cancelled.code).toBe(0);
      expect(cancelled.stderr).toContain("was running");
    } finally {
      const result = await Promise.race([first.done, Bun.sleep(20_000).then(() => null)]);
      if (result === null) first.child.kill("SIGKILL");
      else {
        // the followed run ended because it was cancelled: not a success
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/cancelled|killed/);
      }
    }
  }, 60_000);

  test("`auto log --follow` sees a run through to the end", async () => {
    // quick finishes in milliseconds, so this follows a run that may already be over
    const run = await json<{ run_id: string }[]>(["runs", "--job", "quick", "--state", "succeeded", "-n", "1"]);
    const r = await auto(["log", shortOf(run[0]!.run_id), "--follow"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("quick says hi\n");
    expect(r.stderr).toMatch(/-- run [0-9a-f]{8} succeeded in /);
  });
});

describe("config commands", () => {
  test("status, reload and a bad edit that the supervisor rejects", async () => {
    const status = await auto(["config", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/CONFIG\s+ok/);
    expect(status.stdout).toMatch(/JOBS\s+4/);

    // a webhook whose secret is missing is a warning, shown by status and reload
    expect((await auto(["secret", "remove", "gh-secret"])).code).toBe(0);
    const warned = await auto(["config", "status"]);
    expect(warned.stderr).toMatch(/warning: .*gh-secret.*not set/);
    expect((await auto(["secret", "set", "gh-secret"], { stdin: "topsecretvalue" })).code).toBe(0);
    expect((await auto(["config", "status"])).stderr).not.toContain("warning:");

    const reload = await auto(["config", "reload"]);
    expect(reload.code).toBe(0);
    expect(reload.stderr).toContain("reloaded: 4 jobs, 4 triggers");

    const path = join(ws.home, "auto.config.ts");
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.replace('"0 9 * * *"', '"not a cron"'));
    const bad = await auto(["config", "reload"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("config invalid");
    expect(bad.stderr).toContain("not a cron");
    writeFileSync(path, good);
    expect((await auto(["config", "reload"])).code).toBe(0);
  }, 30_000);

  test("`create --add` adds a job the running supervisor picks up", async () => {
    const r = await auto(["create", "extra", "--add", "--cron", "5 4 * * *"]);
    expect(r.code).toBe(0);
    const row = await waitFor(async () => {
      const line = (await auto(["jobs"])).stdout.split("\n").find((l) => l.startsWith("extra "));
      return line ?? null;
    }, "the new job to appear");
    expect(row).toMatch(/enabled\s+cron/);
    expect((await auto(["run", "extra"])).code).toBe(0);
  }, 30_000);
});

describe("doctor, data wipe and token rotation", () => {
  test("doctor sees the live supervisor, token, config and database", async () => {
    const r = await auto(["--json", "doctor"]);
    const d = JSON.parse(r.stdout) as { ok: boolean; checks: { name: string; status: string; message: string }[] };
    const get = (name: string) => d.checks.find((c) => c.name === name)!;
    expect(get("Supervisor reachable").status).toBe("OK");
    expect(get("Token file").status).toBe("OK");
    expect(get("Config valid").status).toBe("OK");
    expect(get("Config valid").message).toMatch(/\d+ jobs?, \d+ triggers?/);
    expect(get("Database").status).toBe("OK");
    expect(get("Disk usage").message).toMatch(/run logs/);
    // the OS watchdog was deliberately never registered for this temporary workspace
    expect(get("Watchdog registered").status).toBe("FAIL");
    expect(r.code).toBe(1);
  });

  test("data wipe refuses while the supervisor is running", async () => {
    const r = await auto(["--yes", "data", "wipe"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("auto svc stop");
    expect(existsSync(ws.data)).toBe(true);
  });

  test("token rotate replaces the token; the CLI keeps working and the old token does not", async () => {
    const tokenPath = join(ws.data, ".token");
    const before = readFileSync(tokenPath, "utf8").trim();
    const r = await auto(["token", "rotate"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("reload");
    expect(r.stderr).not.toContain("auto ui");
    expect(r.stdout).toBe("");
    const after = readFileSync(tokenPath, "utf8").trim();
    expect(after).not.toBe(before);
    expect(r.stderr + r.stdout).not.toContain(after);
    expect(r.stderr + r.stdout).not.toContain(before);

    // the CLI picks up the new token from the file
    const jobs = await auto(["jobs"]);
    expect(jobs.code).toBe(0);

    // the old one is refused
    const old = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/jobs`, { headers: { authorization: `Bearer ${before}` } });
    expect(old.status).toBe(401);
    const current = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/jobs`, { headers: { authorization: `Bearer ${after}` } });
    expect(current.status).toBe(200);

    // with the old token supplied explicitly, the CLI says so instead of a stack trace
    const stale = join(ws.data, "stale-token");
    writeFileSync(stale, before, { mode: 0o600 });
    const rejected = await auto(["jobs", "--token-file", stale]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("rejected the API token");
    expect(statSyncMode(tokenPath)).toBe(0o600);
  });
});

function statSyncMode(path: string): number {
  return require("node:fs").statSync(path).mode & 0o777;
}
