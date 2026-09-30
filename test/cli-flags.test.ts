import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIVE_PORT, makeWorkspace, runAuto, ROOT } from "./cli-harness.ts";

const ws = makeWorkspace(1);
// process.on("exit") never runs under `bun test`, which leaked a temp dir per run.
afterAll(() => ws.cleanup());

const version = (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string }).version;

describe("version and help", () => {
  test("-V and --version print the package version and exit 0", async () => {
    for (const flag of ["-V", "--version"]) {
      const r = await runAuto(ws, [flag]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(version);
    }
  });

  test("bare `auto` prints the command list on stdout and exits 0", async () => {
    const r = await runAuto(ws, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: auto");
  });

  test("--help groups commands under Setup, Jobs, Runs, Service and Diagnostics", async () => {
    const r = await runAuto(ws, ["--help"]);
    expect(r.code).toBe(0);
    const headings = ["Setup:", "Jobs:", "Runs:", "Service:", "Diagnostics:"].map((h) => r.stdout.indexOf(h));
    expect(headings.every((i) => i >= 0)).toBe(true);
    // in that order
    expect([...headings].sort((a, b) => a - b)).toEqual(headings);
    const group = (name: string, next: string | null): string =>
      r.stdout.slice(r.stdout.indexOf(name), next ? r.stdout.indexOf(next) : undefined);
    expect(group("Service:", "Diagnostics:")).toMatch(/\btoken\b/);
    expect(group("Service:", "Diagnostics:")).toMatch(/\bsvc\b/);
    expect(group("Jobs:", "Runs:")).toMatch(/\bjobs\b/);
    expect(group("Runs:", "Service:")).toMatch(/\bcancel\b/);
    expect(group("Diagnostics:", null)).toMatch(/\bdoctor\b/);
    expect(r.stdout).toContain("Exit codes:");
  });

  test("no stale wording anywhere in the help", async () => {
    const paths = [
      [],
      ["jobs"], ["job"], ["run"], ["runs"], ["log"], ["last"], ["cancel"], ["enable"], ["disable"], ["pause"],
      ["trigger"], ["trigger", "enable"], ["trigger", "disable"],
      ["config"], ["config", "check"], ["config", "status"], ["config", "reload"], ["config", "edit"],
      ["secret"], ["secret", "list"], ["secret", "set"], ["secret", "remove"],
      ["svc"], ["svc", "install"], ["svc", "uninstall"], ["svc", "start"], ["svc", "stop"], ["svc", "restart"], ["svc", "tail"],
      ["token"], ["token", "rotate"], ["data"], ["data", "wipe"],
      ["init"], ["create"], ["install"], ["ui"], ["doctor"], ["version"],
    ];
    for (const path of paths) {
      const r = await runAuto(ws, [...path, "--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toMatch(/phase[- ]?\d|wave \d|alias for \/api|placeholder/i);
      // every command line in a command list carries a description
      if (path.length > 0) {
        const lines = r.stdout.split("\n");
        expect(lines[0]).toStartWith("Usage: auto");
        expect(lines[2]?.trim().length ?? 0).toBeGreaterThan(8);
      }
    }
  });

  test("every subcommand of a group has a one-line description", async () => {
    for (const group of ["svc", "secret", "trigger", "config", "token", "data"]) {
      const r = await runAuto(ws, [group, "--help"]);
      const cmds = r.stdout.split("Commands:")[1]!.split("\n").filter((l) => /^ {2}\S/.test(l) && !l.includes("help [command]"));
      expect(cmds.length).toBeGreaterThan(0);
      for (const line of cmds) {
        // "  name <arg>   description": the description column must not be empty
        expect(line.replace(/^ {2}\S+( <[^>]+>)?\s*/, "").trim().length).toBeGreaterThan(5);
      }
    }
  });

  test("svc install is described as the same operation as install", async () => {
    const svc = await runAuto(ws, ["svc", "--help"]);
    expect(svc.stdout).toMatch(/install\s+same as `auto install`/);
    const install = await runAuto(ws, ["install", "--help"]);
    expect(install.stdout).toContain("auto svc install");
  });

  test("trigger help shows a real example id", async () => {
    const r = await runAuto(ws, ["trigger", "enable", "--help"]);
    expect(r.stdout).toContain("job-name:trigger-id");
    expect(r.stdout).toContain("auto trigger enable hello-world:morning");
  });
});

describe("flags", () => {
  test("--force belongs to `auto run` only", async () => {
    expect((await runAuto(ws, ["run", "--help"])).stdout).toContain("--force");
    expect((await runAuto(ws, ["--help"])).stdout).not.toMatch(/^\s+(-f, )?--force/m);
    for (const args of [
      ["cancel", "abcdef12", "--force"],
      ["-f", "jobs"],
      ["data", "wipe", "--force"],
      ["secret", "remove", "x", "--force"],
    ]) {
      const r = await runAuto(ws, args);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/unknown option/);
    }
  });

  test("-y/--yes is a global flag", async () => {
    expect((await runAuto(ws, ["--help"])).stdout).toMatch(/-y, --yes/);
    // accepted before or after the command; fails later for lack of a supervisor, not for a usage error
    for (const args of [["-y", "jobs"], ["jobs", "--yes"]]) {
      const r = await runAuto(ws, args);
      expect(r.code).toBe(3);
    }
  });

  test("--no-color is accepted", async () => {
    const r = await runAuto(ws, ["--no-color", "version", "--json"]);
    expect(r.code).toBe(0);
  });

  test("unknown command is a usage error (exit 2) with a suggestion", async () => {
    const r = await runAuto(ws, ["jbos"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("jobs");
  });

  test("a command group without its subcommand is a usage error; asking for help is not", async () => {
    expect((await runAuto(ws, ["svc"])).code).toBe(2);
    expect((await runAuto(ws, ["secret"])).code).toBe(2);
    const help = await runAuto(ws, ["help", "svc"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: auto svc");
  });

  test("missing argument is a usage error", async () => {
    expect((await runAuto(ws, ["log"])).code).toBe(2);
    expect((await runAuto(ws, ["job"])).code).toBe(2);
  });

  test("bad numbers are usage errors and never contact the supervisor", async () => {
    const r = await runAuto(ws, ["runs", "--limit", "abc"]);
    expect(r.code).toBe(2);
    expect((await runAuto(ws, ["pause", "x", "banana"])).code).toBe(2);
    expect((await runAuto(ws, ["pause", "x", "0s"])).code).toBe(2);
  });

  test("a missing --token-file names the path, not the supervisor", async () => {
    // A supervisor that answers /healthz but leaves no token: the token is needed next.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      const r = await runAuto(ws, [
        "jobs",
        "--base-url",
        `http://127.0.0.1:${server.port}`,
        "--token-file",
        resolve(ws.data, "no-such-token"),
      ]);
      expect(r.code).toBe(1);
      // The user named the file, so the advice is about the path, not about starting the supervisor.
      expect(r.stderr).toContain("cannot read an API token from");
      expect(r.stderr).toContain("--token-file");
      expect(r.stderr).not.toContain("auto svc install && auto svc start");
    } finally {
      server.stop(true);
    }
  });

  test("a missing default token still says the supervisor has not started yet", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      const r = await runAuto(ws, ["jobs", "--base-url", `http://127.0.0.1:${server.port}`]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("supervisor has not started yet: run `auto install`");
    } finally {
      server.stop(true);
    }
  });

  test("an unreachable supervisor says how to start it", async () => {
    const r = await runAuto(ws, ["jobs", "--base-url", "http://127.0.0.1:1"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("supervisor unreachable at http://127.0.0.1:1");
    expect(r.stderr).toContain("auto install");
  });

  test("the test port is not the default 7777", () => {
    expect(LIVE_PORT).not.toBe(7777);
  });
});
