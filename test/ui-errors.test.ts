import { describe, expect, test } from "bun:test";
import {
  ApiError,
  describeError,
  errorSentence,
  isClientError,
  isNotFound,
  isUnauthorized,
  isUnreachable,
  reasonLabel,
  shouldRetry,
  TOKEN_CHANGED_MESSAGE,
} from "../ui/src/util/errors.ts";

describe("classification", () => {
  test("401 is unauthorized, and only 401", () => {
    expect(isUnauthorized(new ApiError(401, { error: "unauthorized" }))).toBe(true);
    expect(isUnauthorized(new ApiError(403, null))).toBe(false);
    expect(isUnauthorized(new Error("x"))).toBe(false);
  });

  test("no response, gateway errors and the dev proxy's empty 500 mean the supervisor is unreachable", () => {
    expect(isUnreachable(new ApiError(0, null))).toBe(true);
    expect(isUnreachable(new ApiError(502, null))).toBe(true);
    expect(isUnreachable(new ApiError(504, null))).toBe(true);
    expect(isUnreachable(new ApiError(500, null))).toBe(true);
    expect(isUnreachable(new ApiError(500, { error: "internal_error" }))).toBe(false);
    expect(isUnreachable(new ApiError(404, null))).toBe(false);
  });

  test("a missing log is not a not-found page", () => {
    expect(isNotFound(new ApiError(404, { error: "not_found" }))).toBe(true);
    expect(isNotFound(new ApiError(404, { error: "no_log" }))).toBe(false);
  });

  test("never retry a 4xx; retry outages twice", () => {
    expect(isClientError(new ApiError(409, {}))).toBe(true);
    expect(isClientError(new ApiError(500, {}))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, {}))).toBe(false);
    expect(shouldRetry(0, new ApiError(401, {}))).toBe(false);
    expect(shouldRetry(0, new ApiError(0, null))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, {}))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, {}))).toBe(false);
  });
});

describe("describeError", () => {
  test("a 401 means the token changed and asks for a reload", () => {
    const d = describeError(new ApiError(401, { error: "unauthorized" }));
    expect(d.kind).toBe("unauthorized");
    expect(d.title).toBe("The API token changed");
    expect(d.message).toBe("Reload this page to pick up the new one.");
    expect(errorSentence(new ApiError(401, null))).toBe(TOKEN_CHANGED_MESSAGE);
    expect(TOKEN_CHANGED_MESSAGE).toBe("The API token changed. Reload this page to pick up the new one.");
  });

  test("unreachable points at install/start", () => {
    const d = describeError(new ApiError(0, null));
    expect(d.kind).toBe("unreachable");
    expect(d.title).toBe("Supervisor is not running");
    expect(d.message).toContain("auto install");
    expect(d.message).toContain("auto svc start");
  });

  test("already_finished includes the state the run ended in", () => {
    const d = describeError(new ApiError(409, { error: "already_finished", previous_state: "succeeded" }));
    expect(d.title).toBe("Run already finished");
    expect(d.message).toContain("succeeded");
    expect(d.code).toBe("already_finished");
  });

  test("skipped explains the reason", () => {
    const d = describeError(new ApiError(422, { error: "skipped", reason: "paused", run_id: "x" }));
    expect(d.message).toContain("paused");
  });

  test("config_invalid carries the details", () => {
    const d = describeError(new ApiError(400, { error: "config_invalid", details: "job \"x\": bad cron", stage: "load" }));
    expect(d.message).toContain("bad cron");
  });

  test("invalid_body carries the validation details", () => {
    const d = describeError(new ApiError(400, { error: "invalid_body", details: ["duration_ms too small"] }));
    expect(d.message).toContain("duration_ms too small");
  });

  test("an unknown code still says the status", () => {
    const d = describeError(new ApiError(418, { error: "teapot" }));
    expect(d.title).toContain("418");
    expect(d.message).toContain("teapot");
  });

  test("a 5xx with a body is a server error, not an outage", () => {
    const d = describeError(new ApiError(500, { error: "internal_error" }));
    expect(d.kind).toBe("server");
  });

  test("non-API errors pass their message through", () => {
    const d = describeError(new Error("boom"));
    expect(d.kind).toBe("unknown");
    expect(d.message).toBe("boom");
  });

  test("errorSentence joins title and message", () => {
    expect(errorSentence(new ApiError(409, { error: "already_finished", previous_state: "failed" }))).toBe(
      "Run already finished. It had already ended (failed).",
    );
  });
});

describe("reasonLabel", () => {
  test("known reasons read as words, unknown ones are de-snaked", () => {
    expect(reasonLabel("queue_full")).toContain("queue is full");
    expect(reasonLabel("supervisor_interrupted")).toContain("stopped unexpectedly");
    expect(reasonLabel("some_new_reason")).toBe("some new reason");
    expect(reasonLabel(null)).toBe("");
  });
});
