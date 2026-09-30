import { describe, expect, test } from "bun:test";
import { ApiError } from "../ui/src/util/errors.ts";
import { canForce, classifyRunFailure, refusalAfter, runAcceptedMessage } from "../ui/src/util/runNow.ts";

describe("classifyRunFailure", () => {
  test("409 conflict carries the running run", () => {
    const r = classifyRunFailure(new ApiError(409, { error: "conflict", running_run_id: "abc-123" }));
    expect(r).toEqual({ kind: "conflict", runningRunId: "abc-123" });
    expect(canForce(r)).toBe(true);
  });

  test("422 skipped carries the reason and the recorded run", () => {
    const r = classifyRunFailure(new ApiError(422, { error: "skipped", reason: "paused", run_id: "r1" }));
    expect(r).toMatchObject({ kind: "skipped", reason: "paused", runId: "r1" });
    expect(r.kind === "skipped" && r.label).toContain("paused");
    expect(canForce(r)).toBe(true);
  });

  test("a supervisor shutdown cannot be forced", () => {
    const r = classifyRunFailure(new ApiError(422, { error: "skipped", reason: "shutdown", run_id: "r1" }));
    expect(canForce(r)).toBe(false);
  });

  test("other errors become a sentence, and cannot be forced", () => {
    const r = classifyRunFailure(new ApiError(404, { error: "not_found" }));
    expect(r.kind).toBe("error");
    expect(canForce(r)).toBe(false);
    expect(classifyRunFailure(new ApiError(0, null))).toMatchObject({ kind: "error", message: expect.stringContaining("not running") });
    expect(classifyRunFailure(new Error("x")).kind).toBe("error");
  });

  test("a 409 with another code is not a conflict", () => {
    expect(classifyRunFailure(new ApiError(409, { error: "ambiguous_prefix" })).kind).toBe("error");
  });
});

describe("runAcceptedMessage", () => {
  test("started (200) and queued (202) read differently", () => {
    expect(runAcceptedMessage({ run_id: "01a0eee4-1c2d-7abc-8def-0123456789ab", status: 200 })).toBe("Started run 456789ab.");
    expect(runAcceptedMessage({ run_id: "x", status: 202, position: 2 })).toContain("position 2");
    expect(runAcceptedMessage({ run_id: "x", status: 202 })).toContain("Queued");
  });
});

describe("refusalAfter: a refusal describes the moment it was made", () => {
  const skipped = classifyRunFailure(new ApiError(422, { error: "skipped", reason: "disabled", run_id: "r1" }));
  const conflict = classifyRunFailure(new ApiError(409, { error: "conflict", running_run_id: "abc" }));
  const error = classifyRunFailure(new ApiError(0, null));

  test("a 'not started: disabled' note goes when the job's enabled or paused state changes", () => {
    expect(refusalAfter(skipped, "job-state-changed")).toBeNull();
    expect(refusalAfter(skipped, "connection-restored")).toBe(skipped);
  });

  test("a supervisor-down error note goes when the connection is back", () => {
    expect(error.kind).toBe("error");
    expect(refusalAfter(error, "connection-restored")).toBeNull();
    expect(refusalAfter(error, "job-state-changed")).toBe(error);
  });

  test("a conflict is left to its run finishing, and nothing stays nothing", () => {
    expect(refusalAfter(conflict, "job-state-changed")).toBe(conflict);
    expect(refusalAfter(conflict, "connection-restored")).toBe(conflict);
    expect(refusalAfter(null, "job-state-changed")).toBeNull();
  });
});
