import { describe, expect, test } from "bun:test";
import { configIssue, summaryLine } from "../ui/src/util/configIssue.ts";

const ok = { ok: true, loadedAt: 1, lastError: null, jobs: 1, triggers: 1, degraded: { active: false, reason: null } };

describe("configIssue", () => {
  test("healthy config has no issue", () => {
    expect(configIssue(ok)).toBeNull();
    expect(configIssue(undefined)).toBeNull();
  });

  test("degraded shows the reason as kind: message", () => {
    const issue = configIssue({
      ...ok,
      ok: false,
      degraded: { active: true, reason: { kind: "config_error", message: "bad config" } },
    });
    expect(issue).toMatchObject({ mode: "degraded", kind: "config_error", message: "bad config" });
  });

  test("a rejected reload keeps the previous config running", () => {
    const issue = configIssue({ ...ok, ok: false, lastError: { at: 5, message: "oops" } });
    expect(issue).toMatchObject({ mode: "reload", message: "oops", at: 5 });
  });

  test("degraded without a reason still says so", () => {
    const issue = configIssue({ ...ok, degraded: { active: true, reason: null } });
    expect(issue?.mode).toBe("degraded");
    expect(issue?.message).toContain("degraded");
  });
});

describe("summaryLine", () => {
  test("joins an introductory line with the first problem", () => {
    expect(summaryLine('Config validation failed:\n  - job "fast": bad cron\n  - job "b": x')).toBe(
      'Config validation failed: job "fast": bad cron',
    );
  });
  test("single lines pass through", () => {
    expect(summaryLine("plain message")).toBe("plain message");
    expect(summaryLine("")).toBe("");
  });
});
