import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError, SupervisorTimeout, SupervisorUnreachable } from "../cli/client.ts";
import { followRun } from "../cli/follow.ts";
import { baseUrlProblem, EX, missingOptionValue, safeRun } from "../cli/main.ts";
import { warningRemedy } from "../cli/commands/doctor.ts";
import { skippedMessage } from "../cli/commands/run.ts";
import { shellWord } from "../cli/runtime.ts";
import { resolveRun } from "../cli/run-ref.ts";
import { fakeRunId, startFakeApi, type Fake } from "./cli-fake-api.ts";
import { CLI_MAIN, ROOT, cleanEnv, makeWorkspace, runAuto } from "./cli-harness.ts";

const ws = makeWorkspace(1);
afterAll(() => ws.cleanup());

let fake: Fake;
beforeEach(() => {
  fake = startFakeApi();
});
afterEach(async () => {
  await fake.stop();
});

const auto = (args: string[], opts: { stdin?: string } = {}) =>
  runAuto(ws, [...args, "--base-url", fake.baseUrl, "--token-file", fake.tokenFile], opts);

// ---------------------------------------------------------------------------

describe("prompts never touch stdout", () => {
  const script = (extra = "") => `
    import { ask, setGlobals } from ${JSON.stringify(join(ROOT, "cli/runtime.ts"))};
    ${extra}
    const r = await ask({ type: "confirm", name: "value", message: "Cancel it?", initial: false });
    process.stdout.write(JSON.stringify(r) + "\\n");`;

  async function run(code: string) {
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: { ...cleanEnv(), HOME: ws.home },
      stdin: new Blob(["y\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr };
  }

  test("the question is drawn on stderr, and stdout carries only what the command prints", async () => {
    const { stdout, stderr } = await run(script());
    expect(stdout).toBe('{"value":true}\n');
    expect(stderr).toContain("Cancel it?");
  });

  test("no colors in the prompt when stderr is not a terminal (or --no-color is given)", async () => {
    const { stderr } = await run(script('setGlobals({ noColor: true });'));
    expect(stderr).toContain("Cancel it?");
    expect(stderr).not.toMatch(/\x1b\[3\dm/);
  });
});

// ---------------------------------------------------------------------------

describe("a token rotated while the CLI is running", () => {
  test("a 401 with a token that has since changed on disk is retried once with the new one", async () => {
    fake.requireToken = "NEW-TOKEN";
    writeFileSync(fake.tokenFile, "OLD-TOKEN\n");
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    expect(client.token).toBe("OLD-TOKEN"); // cached, as during a long `auto run`
    writeFileSync(fake.tokenFile, "NEW-TOKEN\n"); // `auto token rotate` in another shell

    fake.runs.set("r1", { run_id: "r1", job_name: "j", state: "succeeded", exit_code: 0, log: "hi\n" });
    expect((await client.runLogFrom("r1", 0)).state).toBe("succeeded");
    expect(fake.calls.filter((c) => c.authorization === "Bearer OLD-TOKEN").length).toBe(1);
    // ...and POSTs too (the rejected request had not been processed).
    fake.jobs.set("j", { name: "j" });
    await client.runJob("j");
    expect(fake.calls.at(-1)!.authorization).toBe("Bearer NEW-TOKEN");
  });

  test("a 401 with an unchanged token is not retried in a loop", async () => {
    fake.requireToken = "SOMETHING-ELSE";
    writeFileSync(fake.tokenFile, "OLD-TOKEN\n");
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    await expect(client.jobs()).rejects.toBeInstanceOf(ApiError);
    expect(fake.calls.filter((c) => c.path === "/api/jobs").length).toBe(1);
  });

  test("followRun keeps following across the rotation and finishes normally", async () => {
    fake.requireToken = "NEW-TOKEN";
    writeFileSync(fake.tokenFile, "OLD-TOKEN\n");
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    void client.token;
    writeFileSync(fake.tokenFile, "NEW-TOKEN\n");
    fake.runs.set("r1", { run_id: "r1", job_name: "j", state: "succeeded", exit_code: 0, duration_ms: 5, log: "hello\n" });
    let out = "";
    const result = await followRun(client, { runId: "r1", out: (t) => (out += t), useSse: false, pollMs: 20 });
    expect(result).toMatchObject({ kind: "finished", state: "succeeded" });
    expect(out).toBe("hello\n");
  });
});

// ---------------------------------------------------------------------------

describe("a slow supervisor is not an absent one", () => {
  test("a timeout is SupervisorTimeout; a refused connection is still SupervisorUnreachable", async () => {
    fake.configDelayMs = 400;
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile, timeoutMs: 100 });
    const err = await client.configStatus().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SupervisorTimeout);
    expect(err).not.toBeInstanceOf(SupervisorUnreachable);
    expect((err as Error).message).toContain("did not answer");

    const refused = new ApiClient({ baseUrl: "http://127.0.0.1:1", tokenFile: fake.tokenFile, timeoutMs: 500 });
    await expect(refused.jobs()).rejects.toBeInstanceOf(SupervisorUnreachable);
  });

  test("a reload waits much longer than the default timeout (the config file has to be evaluated)", async () => {
    fake.configDelayMs = 400;
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile, timeoutMs: 100 });
    expect(await client.configReload()).toMatchObject({ ok: true });
  });

  test("the command says the supervisor is slow, not that it needs starting, and exits 1", async () => {
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, cb?: () => void) => {
      seen.push(String(chunk));
      if (typeof cb === "function") cb();
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await safeRun(async () => {
        throw new SupervisorTimeout("http://127.0.0.1:1", 5_000);
      });
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(EX.ERR);
    const text = seen.join("");
    expect(text).toContain("did not answer within 5s");
    expect(text).not.toContain("auto install");
  });
});

// ---------------------------------------------------------------------------

describe("auto version and auto config status agree about health", () => {
  const json = async (args: string[]) => JSON.parse((await auto(args)).stdout);

  test("a rejected edit while the last good config runs is a config error, not 'degraded'", async () => {
    fake.configStatus = { ...fake.configStatus, ok: false, lastError: { at: 1, message: "worker missing" } };
    expect((await json(["--json", "version"])).supervisor.status).toBe("config_error");
    const text = await auto(["version"]);
    expect(text.stdout).toContain("(config error)");
    expect(text.stdout).not.toContain("degraded");
  });

  test("degraded means nothing is scheduled; ok is ok", async () => {
    fake.configStatus = { ...fake.configStatus, ok: false, degraded: { active: true, reason: { kind: "config_error", message: "x" } } };
    expect((await json(["--json", "version"])).supervisor.status).toBe("degraded");
    fake.configStatus = { ...fake.configStatus, ok: true, degraded: { active: false, reason: null } };
    expect((await json(["--json", "version"])).supervisor.status).toBe("ok");
  });

  test("`config status` exits 1 for a rejected config and for a degraded supervisor, 0 when healthy", async () => {
    expect((await auto(["config", "status"])).code).toBe(0);
    fake.configStatus = { ...fake.configStatus, ok: false, lastError: { at: 1, message: "worker missing" } };
    const bad = await auto(["config", "status"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("worker missing"); // still printed
    expect((await auto(["--json", "config", "status"])).code).toBe(1);
    fake.configStatus = { ...fake.configStatus, ok: false, degraded: { active: true, reason: { kind: "config_error", message: "x" } } };
    expect((await auto(["config", "status"])).code).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("`auto run <job> | head` still reports the run's own result", () => {
  test("a failing run keeps exit 1 when the reader closes the pipe early", async () => {
    const id = fakeRunId("deadbeef");
    // Far more output than a pipe holds, so the reader really closes it mid-write.
    fake.runs.set(id, { run_id: id, job_name: "failer", state: "failed", exit_code: 3, duration_ms: 5, log: "x".repeat(200) + "\n".repeat(1) + "y".repeat(3_000_000) + "\n" });
    const child = Bun.spawn(
      ["bash", "-c", `${process.execPath} ${CLI_MAIN} run failer --base-url ${fake.baseUrl} --token-file ${fake.tokenFile} 2>/dev/null | head -c 5 >/dev/null; echo "\${PIPESTATUS[0]}"`],
      { env: { ...ws.env }, stdout: "pipe", stderr: "pipe" },
    );
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(out.trim()).toBe("1");
  });

  test("a plain `auto log | head` still ends quietly with 0", async () => {
    const id = fakeRunId("cafe0001");
    fake.runs.set(id, { run_id: id, job_name: "j", state: "succeeded", exit_code: 0, log: "z".repeat(3_000_000) + "\n" });
    const child = Bun.spawn(
      ["bash", "-c", `${process.execPath} ${CLI_MAIN} log cafe0001 --base-url ${fake.baseUrl} --token-file ${fake.tokenFile} 2>/dev/null | head -c 5 >/dev/null; echo "\${PIPESTATUS[0]}"`],
      { env: { ...ws.env }, stdout: "pipe", stderr: "pipe" },
    );
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(out.trim()).toBe("0");
  });
});

// ---------------------------------------------------------------------------

describe("hints are pasteable", () => {
  test("shellWord quotes what a shell would split", () => {
    expect(shellWord("plain-name_1.x")).toBe("plain-name_1.x");
    expect(shellWord("with space")).toBe("'with space'");
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });

  test("the skip messages quote the job name", () => {
    expect(skippedMessage("with space", "disabled")).toContain("`auto enable 'with space'`");
    expect(skippedMessage("with space", "paused")).toContain("`auto pause 'with space' off`");
    expect(skippedMessage("plain", "paused")).toContain("`auto pause plain off`");
  });

  test("`auto pause` prints a resume command that works for a name with a space", async () => {
    const r = await auto(["pause", "with space", "1h"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("`auto pause 'with space' off`");
  });
});

// ---------------------------------------------------------------------------

describe("bad global options are usage errors, not an absent supervisor", () => {
  test("a --base-url without a scheme is refused with a hint", async () => {
    expect(baseUrlProblem("127.0.0.1:17990")).toContain("http://");
    expect(baseUrlProblem("localhost:7777")).toContain("http://");
    expect(baseUrlProblem("http://127.0.0.1:7777")).toBeNull();
    expect(baseUrlProblem("https://auto.example")).toBeNull();
    expect(baseUrlProblem(undefined)).toBeNull();
    const r = await runAuto(ws, ["jobs", "--base-url", "127.0.0.1:17990"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must start with http://");
    expect(r.stderr).not.toContain("unreachable");
  });

  test("an option that takes a value and gets a command name (or nothing) says so", async () => {
    const commands = ["jobs", "runs", "run"];
    expect(missingOptionValue(["bun", "auto", "--token-file", "jobs"], commands)).toContain("'--token-file <path>' needs a value");
    expect(missingOptionValue(["bun", "auto", "--base-url"], commands)).toContain("'--base-url <url>' needs a value");
    expect(missingOptionValue(["bun", "auto", "--token-file", "/tmp/t", "jobs"], commands)).toBeNull();
    expect(missingOptionValue(["bun", "auto", "jobs", "--base-url=http://x"], commands)).toBeNull();
    const r = await runAuto(ws, ["--token-file", "jobs"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs a value");
    expect(r.stdout + r.stderr).not.toContain("Exit codes:"); // not the whole help
  });
});

// ---------------------------------------------------------------------------

describe("run references", () => {
  test("an empty reference is a friendly message without asking the API", async () => {
    const client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
    const r = await resolveRun(client, "");
    expect(r).toMatchObject({ ok: false, code: 1 });
    expect((r as { message: string }).message).toContain("not a run id");
    expect(fake.calls.length).toBe(0);
    const cli = await auto(["log", ""]);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain("not a run id");
    expect(cli.stderr).not.toContain("api error");
  });

  test("`auto log --json` of a run with no log still prints JSON and says why", async () => {
    const id = fakeRunId("5c1ab0de");
    fake.runs.set(id, { run_id: id, job_name: "j", state: "skipped", log: null });
    const r = await auto(["--json", "log", "5c1ab0de"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ run_id: id, state: "skipped", lines: [] });
  });
});

// ---------------------------------------------------------------------------

describe("auto init and auto config edit", () => {
  test("`init --json` lists the workspace directory once", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-polish-init-"));
    try {
      const target = join(home, "new-ws");
      const env = { ...ws.env, AUTO_HOME: target, AUTO_DATA_DIR: join(target, "data") };
      const first = JSON.parse((await runAuto({ env }, ["--json", "init"])).stdout);
      const again = JSON.parse((await runAuto({ env }, ["--json", "init"])).stdout);
      for (const list of [first.created, first.existing, again.existing]) {
        expect(new Set(list).size).toBe(list.length);
      }
      expect(first.created.filter((p: string) => p === target).length).toBe(1);
      expect(first.existing).not.toContain(target);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a missing editor is reported once, as the failure it is", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-polish-edit-"));
    try {
      const target = join(home, "ws");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "auto.config.ts"), "export default [];\n");
      const env = { ...ws.env, AUTO_HOME: target, AUTO_DATA_DIR: join(target, "data"), EDITOR: "definitely-not-an-editor-xyz", VISUAL: "" };
      const r = await runAuto({ env }, ["config", "edit"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("could not start the editor");
      expect(r.stderr).not.toContain("exited with code");
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("doctor's remedy for config warnings fits the warning", () => {
  test("a missing secret names it; a missing file of a disabled job points at the file", () => {
    expect(warningRemedy([{ code: "missing_secret", secret: "gh-secret" }])).toBe("run `auto secret set gh-secret`");
    expect(warningRemedy([{ code: "missing_secret", secret: "a" }, { code: "missing_secret", secret: "a" }, { code: "missing_secret", secret: "b" }])).toBe(
      "run `auto secret set a`; run `auto secret set b`",
    );
    const files = warningRemedy([{ code: "missing_file" }]);
    expect(files).toContain("missing worker or checker file");
    expect(files).not.toContain("secret");
    expect(warningRemedy([{ code: "missing_file" }, { code: "missing_secret", secret: "x" }])).toContain("auto secret set x");
    expect(warningRemedy([{ code: "something_new" }])).toContain("auto config status");
  });
});
