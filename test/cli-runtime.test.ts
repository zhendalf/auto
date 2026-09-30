import { afterEach, describe, expect, test } from "bun:test";
import {
  colorEnabled,
  confirm,
  fmtAgo,
  fmtDuration,
  fmtIn,
  fmtSpan,
  fmtTime,
  fmtTimeMinutes,
  padRight,
  plural,
  renderTable,
  setGlobals,
  shortRunId,
} from "../cli/runtime.ts";
import { bunVersionAtLeast } from "../cli/commands/init.ts";
import { formatJobsTable, jobStateLabel, lastRunLabel, nextRunAt, nextRunLabel, triggerSummary } from "../cli/commands/jobs.ts";
import { looksLikeRunRef } from "../cli/run-ref.ts";
import { parseDuration } from "../cli/commands/pause.ts";
import { editorCommand, parseCheckSummary } from "../cli/commands/config.ts";
import type { Job } from "../cli/client.ts";

afterEach(() => setGlobals({ yes: false, noColor: false, json: false }));

describe("shortRunId", () => {
  test("is the LAST 8 hex digits: the first 8 of a UUIDv7 are timestamp bits", () => {
    expect(shortRunId("01a0eea2-1234-7abc-8def-0123456789ab")).toBe("456789ab");
    // Two runs a few seconds apart share their first 8 digits but not their short id.
    const a = "01a0eea2-1111-7000-8000-00000000aaaa";
    const b = "01a0eea2-2222-7000-8000-00000000bbbb";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    expect(shortRunId(a)).not.toBe(shortRunId(b));
  });

  test("tolerates ids without hyphens and short input", () => {
    expect(shortRunId("0123456789abcdef0123456789abcdef")).toBe("89abcdef");
    expect(shortRunId("abc")).toBe("abc");
  });

  test("run references need at least 6 hex digits", () => {
    expect(looksLikeRunRef("456789ab")).toBe(true);
    expect(looksLikeRunRef("01a0eea2-1234")).toBe(true);
    expect(looksLikeRunRef("abc12")).toBe(false);
    expect(looksLikeRunRef("hello-world")).toBe(false);
    expect(looksLikeRunRef("%%%%%%%%")).toBe(false);
  });
});

describe("formatting", () => {
  test("fmtSpan is exact: 90 minutes is 1h30m, never 2h", () => {
    expect(fmtSpan(90 * 60_000)).toBe("1h30m");
    expect(fmtSpan(2 * 3_600_000)).toBe("2h");
    expect(fmtSpan(60_000)).toBe("1m");
    expect(fmtSpan(90_000)).toBe("1m30s");
    expect(fmtSpan(600_000)).toBe("10m");
    expect(fmtSpan(500)).toBe("500ms");
    expect(fmtSpan(1500)).toBe("1s500ms");
    expect(fmtSpan(86_400_000 + 3_600_000)).toBe("1d1h");
    expect(fmtSpan(0)).toBe("0s");
  });

  test("fmtDuration", () => {
    expect(fmtDuration(null)).toBe("-");
    expect(fmtDuration(12)).toBe("12ms");
    expect(fmtDuration(13_400)).toBe("13s");
    expect(fmtDuration(83_000)).toBe("1m23s");
    expect(fmtDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h05m");
  });

  test("relative times", () => {
    const now = Date.UTC(2026, 8, 29, 12, 0, 0);
    expect(fmtIn(now + 40_000, now)).toBe("in 40s");
    expect(fmtIn(now + 12 * 60_000, now)).toBe("in 12m");
    expect(fmtIn(now + 3 * 3_600_000 + 20 * 60_000, now)).toBe("in 3h20m");
    expect(fmtIn(now + 2 * 86_400_000 + 4 * 3_600_000, now)).toBe("in 2d4h");
    expect(fmtAgo(now - 3_600_000, now)).toBe("1h ago");
    expect(fmtAgo(now - 100, now)).toBe("just now");
    expect(fmtAgo(null)).toBe("-");
    expect(fmtTimeMinutes(now)).toHaveLength(16);
    expect(fmtTime(null)).toBe("-");
  });

  test("plural", () => {
    expect(plural(1, "run")).toBe("1 run");
    expect(plural(0, "run")).toBe("0 runs");
    expect(plural(2, "trigger")).toBe("2 triggers");
  });

  test("renderTable aligns columns and paints after padding", () => {
    const out = renderTable<{ a: string; b: string }>(
      [
        { header: "A", cell: (r) => r.a },
        { header: "B", cell: (r) => r.b, paint: (_r, p) => `<${p}>` },
      ],
      [
        { a: "x", b: "1" },
        { a: "longer", b: "22" },
      ],
    );
    expect(out.split("\n")).toEqual(["A       B", "x       <1 >", "longer  <22>"]);
    expect(padRight("ab", 4)).toBe("ab  ");
  });

  test("parseDuration understands compound durations", () => {
    expect(parseDuration("2h30m")).toBe(9_000_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(() => parseDuration("5")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
  });

  test("editorCommand splits $EDITOR into command and arguments", () => {
    expect(editorCommand({ EDITOR: "code --wait" })).toEqual(["code", "--wait"]);
    expect(editorCommand({ VISUAL: "nano", EDITOR: "vi" })).toEqual(["nano"]);
    expect(editorCommand({})).toEqual(["vi"]);
  });

  test("editorCommand keeps a path with spaces whole: quoted, escaped, or an existing unquoted file", () => {
    const vscode = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    expect(editorCommand({ EDITOR: `'${vscode}' --wait` })).toEqual([vscode, "--wait"]);
    expect(editorCommand({ EDITOR: `"${vscode}" --wait` })).toEqual([vscode, "--wait"]);
    expect(editorCommand({ EDITOR: "/My\\ Tools/ed --new-window" })).toEqual(["/My Tools/ed", "--new-window"]);
    // The unquoted form (what people type into their shell profile) is recognized when that file exists.
    expect(editorCommand({ EDITOR: `${vscode} --wait` }, (p) => p === vscode)).toEqual([vscode, "--wait"]);
    expect(editorCommand({ EDITOR: vscode }, (p) => p === vscode)).toEqual([vscode]);
    // ...and otherwise splits on spaces as before.
    expect(editorCommand({ EDITOR: "code --wait --new-window" }, () => false)).toEqual(["code", "--wait", "--new-window"]);
    expect(editorCommand({ EDITOR: "   " })).toEqual(["vi"]);
  });

  test("parseCheckSummary reads the counts from the supervisor's --check line", () => {
    expect(
      parseCheckSummary("OK config=valid jobs=3 triggers=5 migrations_pending=2 (0001, 0002) [DB ok; 2 pending migrations]\n"),
    ).toEqual({ jobs: 3, triggers: 5, migrationsPending: 2 });
    expect(parseCheckSummary("something else")).toBeNull();
  });

  test("bunVersionAtLeast", () => {
    expect(bunVersionAtLeast("1.4.2", "1.3.0")).toBe(true);
    expect(bunVersionAtLeast("1.3.0", "1.3.0")).toBe(true);
    expect(bunVersionAtLeast("1.2.9", "1.3.0")).toBe(false);
    expect(bunVersionAtLeast("0.8.1", "1.3.0")).toBe(false);
    expect(bunVersionAtLeast("2.0.0", "1.3.0")).toBe(true);
  });
});

describe("color", () => {
  const withEnv = (value: string | undefined, fn: () => void): void => {
    const before = process.env.NO_COLOR;
    if (value === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = value;
    try {
      fn();
    } finally {
      if (before === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = before;
    }
  };

  test("NO_COLOR and --no-color switch color off, whatever the terminal", () => {
    const tty = { isTTY: true };
    withEnv(undefined, () => {
      expect(colorEnabled(tty)).toBe(true);
      expect(colorEnabled({ isTTY: false })).toBe(false);
      expect(colorEnabled({})).toBe(false);
    });
    withEnv("1", () => expect(colorEnabled(tty)).toBe(false));
    // An empty NO_COLOR does not count (https://no-color.org).
    withEnv("", () => expect(colorEnabled(tty)).toBe(true));
    setGlobals({ noColor: true });
    withEnv(undefined, () => expect(colorEnabled(tty)).toBe(false));
  });
});

describe("confirm", () => {
  test("-y answers yes without a terminal", async () => {
    setGlobals({ yes: true });
    expect(await confirm("sure?")).toBe(true);
  });

  test("without -y and without a terminal it reports that nobody can be asked", async () => {
    setGlobals({ yes: false });
    const tty = process.stdin as { isTTY?: boolean };
    const before = tty.isTTY;
    tty.isTTY = false;
    try {
      expect(await confirm("sure?")).toBeNull();
    } finally {
      tty.isTTY = before;
    }
  });
});

describe("job list formatting", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const job = (over: Partial<Job>): Job => ({
    id: "j",
    name: "j",
    description: null,
    enabled: true,
    paused_until: null,
    archived_at: null,
    reentrancy: "drop",
    queueDepth: 1,
    timeoutMs: 60_000,
    killGraceMs: 10_000,
    triggers: [],
    last_run: null,
    ...over,
  });

  test("state: enabled, disabled, paused, running", () => {
    expect(jobStateLabel(job({}), now)).toBe("enabled");
    expect(jobStateLabel(job({ enabled: false }), now)).toBe("disabled");
    expect(jobStateLabel(job({ config_enabled: false }), now)).toBe("disabled (config)");
    expect(jobStateLabel(job({ paused_until: now + 60_000 }), now)).toStartWith("paused until ");
    expect(jobStateLabel(job({ paused_until: now - 1 }), now)).toBe("enabled");
    expect(jobStateLabel(job({ active_run: { run_id: "r", state: "running", started_at: now } }), now)).toBe("running");
    expect(jobStateLabel(job({ active_run: { run_id: "r", state: "queued", started_at: null } }), now)).toBe("queued");
    expect(
      jobStateLabel(job({ enabled: false, active_run: { run_id: "r", state: "running", started_at: now } }), now),
    ).toBe("running (disabled)");
  });

  test("triggers show (off) for disabled ones; next run is the earliest cron fire", () => {
    const j = job({
      triggers: [
        { trigger_id: "j:a", kind: "cron", enabled: true, next_run_at: now + 7_200_000 },
        { trigger_id: "j:b", kind: "cron", enabled: true, next_run_at: now + 3_600_000 },
        { trigger_id: "j:c", kind: "webhook", enabled: false },
      ],
    });
    expect(triggerSummary(j)).toBe("cron,cron,webhook(off)");
    expect(nextRunAt(j)).toBe(now + 3_600_000);
    expect(nextRunLabel(j, now)).toEndWith("(in 1h)");
    expect(nextRunLabel(job({}), now)).toBe("-");
    expect(triggerSummary(job({}))).toBe("-");
  });

  test("last run reads as state plus age", () => {
    expect(lastRunLabel(job({ last_run: { run_id: "r", state: "failed", finished_at: now - 3_600_000 } }), now)).toBe("failed 1h ago");
    expect(lastRunLabel(job({}), now)).toBe("-");
  });

  test("the table has NAME, STATE, TRIGGERS, LAST RUN and NEXT RUN columns", () => {
    const table = formatJobsTable(
      [
        job({
          name: "alpha",
          triggers: [{ trigger_id: "alpha:m", kind: "cron", enabled: true, next_run_at: now + 600_000 }],
          last_run: { run_id: "r", state: "succeeded", finished_at: now - 60_000 },
        }),
        job({ name: "beta-longer", enabled: false }),
      ],
      now,
    );
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^NAME\s+STATE\s+TRIGGERS\s+LAST RUN\s+NEXT RUN$/);
    expect(lines[1]).toContain("alpha");
    expect(lines[1]).toContain("succeeded 1m ago");
    expect(lines[1]).toContain("(in 10m)");
    expect(lines[2]).toContain("disabled");
  });
});
