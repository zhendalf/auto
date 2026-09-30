import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_MAIN, ROOT, makeWorkspace, runAuto, startSupervisor, writeWorkspaceFiles, type LiveSupervisor, type Workspace } from "./cli-harness.ts";

// Regression tests for CLI behavior against a real supervisor (a private
// workspace on its own port, started with `bun supervisor/main.ts`, never cron).

const PORT = Number(process.env.CLI_LIVE_MORE_TEST_PORT ?? 17987);
const UNUSED_PORT = PORT + 2;

const CONFIG = `export default [
  { id: "quick", name: "quick", worker: "./jobs/quick.ts",
    triggers: [{ kind: "cron", id: "morning", schedule: "0 9 * * *" }] },
  { id: "boom", name: "boom", worker: "./jobs/boom.ts",
    triggers: [{ kind: "cron", id: "hourly", schedule: "0 * * * *" }] },
  // switched off in the file: \`auto enable\` must not pretend to undo that
  { id: "off", name: "off", worker: "./jobs/quick.ts", enabled: false,
    triggers: [{ kind: "cron", id: "daily", schedule: "0 4 * * *" }] },
  // disabled AND its worker was deleted: must not make the config invalid
  { id: "gone", name: "gone", worker: "./jobs/deleted.ts", enabled: false,
    triggers: [{ kind: "cron", id: "daily", schedule: "0 5 * * *" }] },
];
`;

let ws: Workspace;
let sup: LiveSupervisor;
const extraWorkspaces: Workspace[] = [];

const auto = (args: string[], env: Record<string, string> = {}) => runAuto(ws, args, { env });

function shortId(text: string): string {
  const m = /started run ([0-9a-f]{8})/.exec(text);
  if (!m) throw new Error(`no run id in: ${text}`);
  return m[1]!;
}

beforeAll(async () => {
  ws = makeWorkspace(PORT);
  writeWorkspaceFiles(ws, CONFIG, {
    "quick.ts": `console.log("quick says hi");\n`,
    "boom.ts": `console.log("about to fail"); process.exit(3);\n`,
  });
  sup = await startSupervisor(ws, PORT);
}, 60_000);

afterAll(async () => {
  await sup?.stop();
  ws?.cleanup();
  for (const w of extraWorkspaces) w.cleanup();
});

describe("startup with a disabled job whose worker is gone", () => {
  test("the supervisor is healthy and the other jobs are scheduled (not degraded)", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, degraded: false });
    const jobs = JSON.parse((await auto(["--json", "jobs"])).stdout) as { name: string }[];
    expect(jobs.map((j) => j.name).sort()).toEqual(["boom", "gone", "off", "quick"]);
  });

  test("`auto config check` explains the problem as a warning, with --json fields for scripts", async () => {
    const human = await auto(["config", "check"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("config valid: 4 jobs, 4 triggers");
    expect(human.stdout).not.toContain("migrations_pending");
    expect(human.stderr).toContain('job "gone" is disabled and worker ./jobs/deleted.ts does not exist');

    const machine = JSON.parse((await auto(["--json", "config", "check"])).stdout);
    expect(machine).toMatchObject({ ok: true, jobs: 4, triggers: 4 });
    expect(typeof machine.migrations_pending).toBe("number");
    expect(machine.messages.join("\n")).toContain('job "gone" is disabled');
  });

  test("`auto config status` lists the warning", async () => {
    const status = JSON.parse((await auto(["--json", "config", "status"])).stdout);
    expect(status.warnings.some((w: { code: string; job: string }) => w.code === "missing_file" && w.job === "gone")).toBe(true);
  });
});

describe("auto version reports the running supervisor", () => {
  test("the supervisor line comes from the running process and --json carries cli and supervisor separately", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    const human = await auto(["version"]);
    expect(human.stdout).toMatch(new RegExp(`^auto ${pkg.version.replaceAll(".", "\\.")}.*\\(cli\\)$`, "m"));
    expect(human.stdout).toMatch(new RegExp(`^supervisor ${pkg.version.replaceAll(".", "\\.")}.*\\(ok\\)$`, "m"));
    const machine = JSON.parse((await auto(["--json", "version"])).stdout);
    expect(machine.supervisor.version).toBe(pkg.version);
    expect(machine.supervisor.status).toBe("ok");
    expect(machine.cli.version).toBe(pkg.version);
  });

  test("with no supervisor it says so instead of printing the CLI's own version on that line", async () => {
    const r = await auto(["version"], { AUTO_PORT: String(UNUSED_PORT) });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^supervisor not running/m);
    const machine = JSON.parse((await auto(["--json", "version"], { AUTO_PORT: String(UNUSED_PORT) })).stdout);
    expect(machine.supervisor).toMatchObject({ version: null, status: "unreachable" });
  });
});

describe("a job switched off in auto.config.ts", () => {
  test("`auto enable` says it is still disabled and exits 1, in text and JSON", async () => {
    const r = await auto(["enable", "off"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("still disabled");
    expect(r.stderr).toContain("enabled: false");
    expect(r.stderr).not.toContain("enabled off");
    const j = await auto(["--json", "enable", "off"]);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.stdout)).toEqual({ ok: false, job: "off", enabled: false, config_enabled: false });
  });

  test("`auto run` no longer sends the user in a circle back to `auto enable`", async () => {
    const r = await auto(["run", "off"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("disabled in auto.config.ts");
    expect(r.stderr).not.toMatch(/enable it with `auto enable off`/);
    expect(r.stderr).toContain("--force");
  });

  test("`auto enable` on an ordinary job still succeeds", async () => {
    expect((await auto(["disable", "quick"])).code).toBe(0);
    const r = await auto(["enable", "quick"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("enabled quick");
  });
});

describe("why a run was skipped, and what `last run` means", () => {
  test("the refused run of `off` shows its reason in `auto runs`, `auto log` and `auto last`", async () => {
    const runs = await auto(["runs", "--state", "skipped"]);
    expect(runs.stdout).toMatch(/WHY/);
    expect(runs.stdout).toMatch(/\boff\b.*\bskipped\b.*\bdisabled\b/);
    const json = JSON.parse((await auto(["--json", "runs", "--state", "skipped"])).stdout) as { run_id: string; skip_reason: string }[];
    expect(json[0]!.skip_reason).toBe("disabled");

    const id = json[0]!.run_id.replaceAll("-", "").slice(-8);
    const log = await auto(["log", id]);
    expect(log.code).toBe(1);
    expect(log.stderr).toContain("has no log (state=skipped: disabled)");
    // Following a run that never started ends at once, without a bogus "skipped in -" line.
    const follow = await auto(["log", id, "--follow"]);
    expect(follow.code).toBe(1);
    expect(follow.stderr).not.toContain("skipped in");

    const last = await auto(["last", "off"]);
    expect(last.code).toBe(0);
    expect(last.stdout).toContain("run has no log");
    expect(last.stdout).toContain("disabled");
  });

  test("a refused manual run does not mask the last real result in `auto jobs` and `auto last`", async () => {
    const ran = await auto(["run", "boom"]);
    expect(ran.code).toBe(1);
    expect((await auto(["disable", "boom"])).code).toBe(0);
    const refused = await auto(["run", "boom"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("boom is disabled; enable it with `auto enable boom`");

    const jobsLine = (await auto(["jobs"])).stdout.split("\n").find((l) => l.startsWith("boom "))!;
    expect(jobsLine).toMatch(/failed (just now|\S+ ago)/);
    expect(jobsLine).not.toContain("skipped");
    const last = await auto(["last", "boom"]);
    expect(last.stdout).toContain("about to fail");
    expect(last.stdout).toContain("failed");
    expect((await auto(["enable", "boom"])).code).toBe(0);
  });

  test("an absent log file is not shown as an empty one", async () => {
    const ran = await auto(["run", "quick"]);
    expect(ran.code).toBe(0);
    const id = shortId(ran.stderr);
    // Remove the run's log file behind the supervisor's back (as retention or a user could).
    const runsDir = join(ws.data, "runs");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".log") && e.name.slice(0, -4).replaceAll("-", "").endsWith(id)) files.push(p);
      }
    };
    walk(runsDir);
    expect(files).toHaveLength(1);
    rmSync(files[0]!);

    const last = await auto(["last", "quick"]);
    expect(last.code).toBe(0);
    expect(last.stdout).toContain("(run has no log: state=succeeded)");
    expect(last.stdout).not.toContain("(no log content)");
    const log = await auto(["log", id]);
    expect(log.code).toBe(1);
    expect(log.stderr).toContain("has no log (state=succeeded)");
  });
});

describe("auto ui --json", () => {
  test("prints {url} as the only stdout, exits 0 and does not open a browser", async () => {
    // PATH has no `open`/`xdg-open`: had it tried, the failure would show as the "could not open" note.
    const r = await auto(["--json", "ui"], { PATH: "/nonexistent" });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ url: `http://127.0.0.1:${PORT}/` });
    expect(r.stderr).not.toContain("could not open a browser");
  });
});

describe("environment problems are one clean line", () => {
  test("a bad AUTO_PORT does not break --version or --help, and every other command says why", async () => {
    const v = await auto(["--version"], { AUTO_PORT: "abc" });
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await auto(["--help"], { AUTO_PORT: "abc" })).code).toBe(0);
    const r = await auto(["jobs"], { AUTO_PORT: "abc" });
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe("error: AUTO_PORT must be an integer from 1 to 65535, got abc");
    expect(r.stderr).not.toContain("    at ");
  });

  test("a missing HOME is the same: --version works, others explain", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(ws.env)) if (k !== "HOME" && k !== "USERPROFILE" && k !== "AUTO_HOME" && k !== "AUTO_DATA_DIR") env[k] = v;
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, CLI_MAIN, ...args], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    expect((await run(["--version"])).code).toBe(0);
    const r = await run(["jobs"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("HOME (or USERPROFILE) is not set");
    expect(r.stderr).not.toContain("    at ");
  });

  test("the supervisor itself refuses to start on a bad AUTO_PORT with exit 78 and one line", async () => {
    const child = Bun.spawn([process.execPath, join(ROOT, "supervisor/main.ts")], {
      cwd: ROOT, env: { ...ws.env, AUTO_PORT: "70000" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(78);
    expect(err).toContain("cannot start: AUTO_PORT must be an integer from 1 to 65535, got 70000");
  });
});

describe("auto config edit", () => {
  test("a missing editor says which variable to set", async () => {
    const r = await auto(["config", "edit"], { EDITOR: "definitely-not-an-editor-xyz", VISUAL: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not start the editor 'definitely-not-an-editor-xyz'");
    expect(r.stderr).toContain("$EDITOR");
  });
});

describe("status-line colors follow stderr, not stdout", () => {
  test.skipIf(!existsSync("/usr/bin/script"))("stdout redirected but stderr a terminal: the result line is still colored", async () => {
    const env = { ...ws.env } as Record<string, string>;
    delete env.NO_COLOR;
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const child = Bun.spawn(
      ["/usr/bin/script", "-q", "/dev/null", "bash", "-c", `${quote(process.execPath)} ${quote(CLI_MAIN)} run quick >/dev/null`],
      { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(out).toContain("\u001b[32msucceeded");
  });
});

describe("auto data wipe only removes what Auto created", () => {
  const fresh = (): Workspace => {
    const w = makeWorkspace(UNUSED_PORT);
    extraWorkspaces.push(w);
    return w;
  };

  test("a directory that holds no Auto data is refused, even with --yes", async () => {
    const w = fresh();
    mkdirSync(join(w.data, "docs"), { recursive: true });
    writeFileSync(join(w.data, "docs", "thesis.txt"), "x");
    const r = await runAuto(w, ["--yes", "data", "wipe"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("holds no Auto data");
    expect(readFileSync(join(w.data, "docs", "thesis.txt"), "utf8")).toBe("x");
  });

  test("Auto's own entries go, anything else beside them stays, and the directory is kept", async () => {
    const w = fresh();
    mkdirSync(join(w.data, "runs", "2026"), { recursive: true });
    mkdirSync(join(w.data, "state"), { recursive: true });
    writeFileSync(join(w.data, ".token"), "t");
    writeFileSync(join(w.data, "secrets.json"), "{}");
    writeFileSync(join(w.data, "automations.db-wal"), "w");
    writeFileSync(join(w.data, "notes.txt"), "mine");
    const r = await runAuto(w, ["--yes", "data", "wipe"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(w.data, "runs"))).toBe(false);
    expect(existsSync(join(w.data, ".token"))).toBe(false);
    expect(existsSync(join(w.data, "automations.db-wal"))).toBe(false);
    expect(readFileSync(join(w.data, "notes.txt"), "utf8")).toBe("mine");
  });

  test("the confirmation lists what will be kept", async () => {
    const w = fresh();
    mkdirSync(join(w.data, "state"), { recursive: true });
    writeFileSync(join(w.data, "notes.txt"), "mine");
    const r = await runAuto(w, ["data", "wipe"]);
    expect(r.stdout).toMatch(/kept\s+1 other entry Auto did not create \(notes\.txt\)/);
  });
});
