import { describe, expect, test } from "bun:test";
import { metaEntries } from "../ui/src/util/runMeta.ts";

describe("metaEntries", () => {
  test("manual reason", () => {
    expect(metaEntries({ reason: "manual via UI" })).toEqual([{ label: "Reason", value: "manual via UI", mono: false }]);
  });

  test("webhook delivery", () => {
    const e = metaEntries(
      {
        version: 1,
        receipt_id: "r-1",
        delivery_id: "d-9",
        body_digest: "abc",
        content_type: "application/json",
        byte_count: 2048,
        received_at: Date.UTC(2026, 0, 5, 0, 7, 9),
      },
      { timeZone: "UTC" },
    );
    const by = Object.fromEntries(e.map((x) => [x.label, x.value]));
    expect(by["Webhook delivery id"]).toBe("d-9");
    expect(by["Webhook receipt"]).toBe("r-1");
    expect(by["Payload size"]).toBe("2.0 KiB");
    expect(by["Received at"]).toBe("2026-01-05 00:07:09");
    expect(by["Content type"]).toBe("application/json");
    expect(e.find((x) => x.label.toLowerCase() === "version")).toBeUndefined();
  });

  test("cron fire time and a condition object", () => {
    const e = metaEntries({ fire_at: Date.UTC(2026, 5, 1, 12, 0, 0), condition: { n: 2 } }, { timeZone: "UTC" });
    expect(e[0]).toEqual({ label: "Scheduled for", value: "2026-06-01 12:00:00", mono: false });
    expect(e[1]).toEqual({ label: "Condition", value: '{"n":2}', mono: true });
  });

  test("unknown keys keep a readable label; empty and null values are dropped", () => {
    expect(metaEntries({ some_key: "x", empty: "", nothing: null })).toEqual([{ label: "Some key", value: "x", mono: true }]);
  });

  test("odd shapes do not throw", () => {
    expect(metaEntries(null)).toEqual([]);
    expect(metaEntries({})).toEqual([]);
    expect(metaEntries("plain")).toEqual([{ label: "Details", value: "plain", mono: false }]);
    expect(metaEntries([1, 2])[0]!.value).toBe("[1,2]");
  });
});
