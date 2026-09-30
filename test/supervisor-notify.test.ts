import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify, notifyOnce } from "../supervisor/notify.ts";

let tmp: string;
let statePath: string;
const savedNotify = process.env.AUTO_NOTIFY;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "notify-test-"));
  statePath = join(tmp, "state", "notified.json");
  delete process.env.AUTO_NOTIFY;
});

afterEach(() => {
  if (savedNotify === undefined) delete process.env.AUTO_NOTIFY;
  else process.env.AUTO_NOTIFY = savedNotify;
  rmSync(tmp, { recursive: true, force: true });
});

function recorder() {
  const calls: string[][] = [];
  return { calls, run: async (cmd: string[]) => void calls.push(cmd) };
}

describe("notify", () => {
  test("uses terminal-notifier when it is on PATH", async () => {
    const r = recorder();
    await notify("T", "M", { run: r.run, which: (n) => (n === "terminal-notifier" ? "/opt/tn" : null), platform: "darwin" });
    expect(r.calls).toEqual([["/opt/tn", "-title", "T", "-message", "M"]]);
  });

  test("falls back to osascript on macOS, passing text as arguments, never in the script", async () => {
    const r = recorder();
    const nasty = 'x" & do shell script "touch /tmp/pwned" & "';
    await notify(nasty, nasty, { run: r.run, which: () => null, platform: "darwin" });
    expect(r.calls.length).toBe(1);
    const cmd = r.calls[0]!;
    expect(cmd[0]).toContain("osascript");
    const script = cmd.filter((_, i) => cmd[i - 1] === "-e").join("\n");
    expect(script).not.toContain("pwned");
    expect(cmd.slice(-2)).toEqual([nasty, nasty]);
  });

  test("does nothing elsewhere", async () => {
    const r = recorder();
    await notify("T", "M", { run: r.run, which: () => null, platform: "linux" });
    expect(r.calls).toEqual([]);
  });

  test("AUTO_NOTIFY=0 disables it", async () => {
    process.env.AUTO_NOTIFY = "0";
    const r = recorder();
    await notify("T", "M", { run: r.run, which: () => "/opt/tn", platform: "darwin" });
    expect(r.calls).toEqual([]);
  });

  test("never throws when the notifier fails", async () => {
    await expect(
      notify("T", "M", {
        run: async () => {
          throw new Error("spawn failed");
        },
        which: () => "/opt/tn",
        platform: "darwin",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("notifyOnce", () => {
  test("notifies once per distinct key per window and persists across calls", async () => {
    const r = recorder();
    const deps = { run: r.run, which: () => "/opt/tn", platform: "darwin" as const };
    const T0 = 1_000_000;
    expect(await notifyOnce("err-a", "T", "M", { statePath, now: T0, deps })).toBe(true);
    expect(await notifyOnce("err-a", "T", "M", { statePath, now: T0 + 60_000, deps })).toBe(false);
    expect(await notifyOnce("err-b", "T", "M", { statePath, now: T0 + 60_000, deps })).toBe(true);
    expect(r.calls.length).toBe(2);
    // After the 6 hour window the same error notifies again.
    const later = T0 + 6 * 60 * 60 * 1000 + 1;
    expect(await notifyOnce("err-a", "T", "M", { statePath, now: later, deps })).toBe(true);
    expect(r.calls.length).toBe(3);
  });

  test("the state file is small, private and never contains the message text", async () => {
    await notifyOnce("secret error text", "T", "M", { statePath, now: 1, deps: { run: async () => {}, which: () => null, platform: "linux" } });
    const raw = readFileSync(statePath, "utf8");
    expect(raw).not.toContain("secret error text");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, "state")).mode & 0o777).toBe(0o700);
  });

  test("survives a corrupt state file and reports false instead of throwing on an unwritable path", async () => {
    const deps = { run: async () => {}, which: () => null, platform: "linux" as const };
    expect(await notifyOnce("k", "T", "M", { statePath: "/dev/null/impossible/x.json", now: 1, deps })).toBe(false);
  });
});
