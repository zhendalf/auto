import { describe, expect, test } from "bun:test";
import { invalidateForEvent } from "../ui/src/api/invalidate.ts";

function run(name: string): string[] {
  const keys: string[] = [];
  invalidateForEvent(
    {
      invalidateQueries: (filters?: { queryKey?: readonly unknown[] }) => {
        keys.push(String(filters?.queryKey?.[0]));
        return Promise.resolve();
      },
    },
    name,
  );
  return keys;
}

describe("event to cache invalidation", () => {
  // Events carry job_id only, so caches keyed by job name must be dropped by prefix.
  for (const ev of ["run.queued", "run.started", "run.finished", "run.skipped"]) {
    test(`${ev} refreshes the job list, every job page, runs and the run record`, () => {
      const keys = run(ev);
      expect(keys).toContain("jobs");
      expect(keys).toContain("job");
      expect(keys).toContain("runs");
      expect(keys).toContain("run");
    });
  }

  for (const ev of ["config.reloaded", "config.error"]) {
    test(`${ev} refreshes jobs, per-job queries, runs and the status`, () => {
      const keys = run(ev);
      expect(keys).toContain("jobs");
      expect(keys).toContain("job");
      expect(keys).toContain("runs");
      expect(keys).toContain("config-status");
    });
  }

  test("leaving degraded mode refreshes the status and jobs", () => {
    const keys = run("degraded.exited");
    expect(keys).toContain("config-status");
    expect(keys).toContain("jobs");
  });

  test("names the supervisor never emits are not handled", () => {
    // db.error and degraded.entered were once part of the contract but nothing sends them.
    for (const ev of ["db.error", "degraded.entered"]) expect(run(ev)).toEqual([]);
  });

  test("unknown events change nothing", () => {
    expect(run("something.else")).toEqual([]);
  });
});
