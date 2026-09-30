import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEDUPE_WINDOW_MS } from "../supervisor/adapters/webhook.ts";
import { openDb } from "../supervisor/db/connection.ts";
import { runMigrations } from "../supervisor/db/migrate.ts";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_MIN_RUNS,
  formatSummary,
  parseRetentionEnv,
  planRetention,
  pruneOnce,
  startRetention,
  type PruneResult,
  type RetentionSettings,
} from "../supervisor/retention.ts";

const DAY = 86_400_000;
// Noon, local time, so date-directory maths is far from a day boundary.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

let tmp: string;
let dataDir: string;
let db: Database;
let seq = 0;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "retention-"));
  dataDir = join(tmp, "data");
  mkdirSync(dataDir, { recursive: true });
  db = openDb(join(dataDir, "automations.db"));
  await runMigrations(db);
  seq = 0;
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // some tests close it
  }
  // A test may have made a directory read-only.
  try {
    for (const dir of readdirSyncDeep(tmp)) chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  rmSync(tmp, { recursive: true, force: true });
});

function readdirSyncDeep(root: string): string[] {
  const out = [root];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...readdirSyncDeep(join(root, e.name)));
  }
  return out;
}

const uuid = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const settings = (days: number, minRuns: number): RetentionSettings => ({ days, minRuns });
const ago = (days: number): number => NOW - days * DAY;

function addJob(name: string): string {
  const id = `job-${name}`;
  db.query(`INSERT INTO jobs (job_id, name, last_seen_in_config_at, created_at) VALUES (?, ?, 0, 0)`).run(id, name);
  return id;
}

function logPathFor(runId: string, enqueuedAt: number): string {
  const d = new Date(enqueuedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `runs/${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}/${runId}.log`;
}

function writeFile(rel: string, bytes = 100, mtime?: number): string {
  const abs = join(dataDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "x".repeat(bytes));
  if (mtime !== undefined) utimesSync(abs, mtime / 1000, mtime / 1000);
  return abs;
}

type RunSpec = { job: string; state?: string; enqueued: number; log?: boolean | string; bytes?: number; id?: string };

/** Insert a run (and by default a real log file for it). Returns run_id. */
function addRun(spec: RunSpec): string {
  const id = spec.id ?? uuid(++seq);
  let logPath: string | null = null;
  if (spec.log !== false) {
    const state = spec.state ?? "succeeded";
    if (state !== "skipped" || spec.log) {
      logPath = typeof spec.log === "string" ? spec.log : logPathFor(id, spec.enqueued);
      if (typeof spec.log !== "string") writeFile(logPath, spec.bytes ?? 100, spec.enqueued);
    }
  }
  const state = spec.state ?? "succeeded";
  db.query(
    `INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at, finished_at, log_path)
     VALUES (?, ?, 'cron', ?, ?, ?, ?)`,
  ).run(id, spec.job, state, spec.enqueued, state === "queued" || state === "running" ? null : spec.enqueued + 1000, logPath);
  return id;
}

const runIds = (): string[] =>
  db.query<{ run_id: string }, []>(`SELECT run_id FROM runs ORDER BY run_id`).all().map((r) => r.run_id);
const hasRun = (id: string): boolean => runIds().includes(id);

async function prune(s: RetentionSettings, extra: { dryRun?: boolean; batchSize?: number; shouldStop?: () => boolean } = {}): Promise<PruneResult> {
  return pruneOnce(db, dataDir, { now: NOW, settings: s, ...extra });
}

// ---------------------------------------------------------------------------

describe("settings and plan", () => {
  test("defaults are 90 days and 25 runs", () => {
    expect(parseRetentionEnv({})).toEqual({ days: 90, minRuns: 25 });
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(DEFAULT_RETENTION_MIN_RUNS).toBe(25);
  });

  test("reads both env vars and accepts 0", () => {
    expect(parseRetentionEnv({ AUTO_RETENTION_DAYS: "30", AUTO_RETENTION_MIN_RUNS: "5" })).toEqual({ days: 30, minRuns: 5 });
    expect(parseRetentionEnv({ AUTO_RETENTION_DAYS: "0", AUTO_RETENTION_MIN_RUNS: "0" })).toEqual({ days: 0, minRuns: 0 });
  });

  test("bad values fall back to the defaults and warn", () => {
    const warnings: string[] = [];
    const parsed = parseRetentionEnv(
      { AUTO_RETENTION_DAYS: "-3", AUTO_RETENTION_MIN_RUNS: "lots" },
      (m) => warnings.push(m),
    );
    expect(parsed).toEqual({ days: 90, minRuns: 25 });
    expect(warnings).toHaveLength(2);
    expect(parseRetentionEnv({ AUTO_RETENTION_DAYS: "1.5" }, () => {}).days).toBe(90);
    expect(parseRetentionEnv({ AUTO_RETENTION_DAYS: "" }, () => {}).days).toBe(90);
  });

  test("cutoffs: skipped is min(days, 14), receipts max(days, 7), orphans days", () => {
    const p = planRetention(settings(90, 25), NOW);
    expect(p.enabled).toBe(true);
    expect(p.runCutoff).toBe(ago(90));
    expect(p.skippedCutoff).toBe(ago(14));
    expect(p.deliveryCutoff).toBe(ago(90));
    expect(p.orphanCutoff).toBe(ago(90));

    const short = planRetention(settings(3, 25), NOW);
    expect(short.runCutoff).toBe(ago(3));
    expect(short.skippedCutoff).toBe(ago(3));
    expect(short.deliveryCutoff).toBe(ago(7));
  });

  test("receipts are never pruned inside the dedupe window", () => {
    for (const days of [1, 7, 90]) {
      const p = planRetention(settings(days, 25), NOW);
      expect(p.deliveryCutoff).toBeLessThanOrEqual(NOW - DEDUPE_WINDOW_MS);
    }
  });

  test("days=0 disables everything", () => {
    const p = planRetention(settings(0, 25), NOW);
    expect(p.enabled).toBe(false);
    expect(p.runCutoff).toBe(-Infinity);
  });

  test("the summary line reads '[retention] removed N runs, M log files, ... freed X MB'", () => {
    const result: PruneResult = {
      dryRun: false, enabled: true, runs: 12, skippedRuns: 4, webhookDeliveries: 3, runLogFiles: 6, payloadFiles: 1,
      orphanLogFiles: 2, orphanPayloadFiles: 1, emptyDirs: 5, bytesFreed: 3 * 1024 * 1024, errors: 0, durationMs: 9,
    };
    expect(formatSummary(result)).toBe(
      "[retention] removed 12 runs (4 skipped), 8 log files, 3 webhook deliveries, 2 payload files, 5 empty dirs, freed 3.0 MB (9 ms)",
    );
    expect(formatSummary({ ...result, dryRun: true })).toContain("dry run, would remove 12 runs");
  });
});

describe("run pruning", () => {
  test("age boundary: a run exactly at the cutoff stays, one millisecond older goes", async () => {
    const job = addJob("a");
    const atCutoff = addRun({ job, enqueued: ago(30) });
    const older = addRun({ job, enqueued: ago(30) - 1 });
    const newer = addRun({ job, enqueued: ago(30) + 1 });
    const r = await prune(settings(30, 0));
    expect(r.runs).toBe(1);
    expect(hasRun(older)).toBe(false);
    expect(hasRun(atCutoff)).toBe(true);
    expect(hasRun(newer)).toBe(true);
  });

  test("every terminal state is pruned; queued and running are never touched", async () => {
    const job = addJob("a");
    const terminal = ["succeeded", "failed", "timed_out", "killed", "cancelled"].map((state) =>
      addRun({ job, state, enqueued: ago(200) }),
    );
    const queued = addRun({ job, state: "queued", enqueued: ago(500) });
    const running = addRun({ job, state: "running", enqueued: ago(500) });
    const r = await prune(settings(30, 0));
    expect(r.runs).toBe(5);
    for (const id of terminal) expect(hasRun(id)).toBe(false);
    expect(hasRun(queued)).toBe(true);
    expect(hasRun(running)).toBe(true);
  });

  test("keeps the newest N real runs per job however old", async () => {
    const a = addJob("a");
    const b = addJob("b");
    const aRuns: string[] = [];
    for (let i = 0; i < 30; i++) aRuns.push(addRun({ job: a, enqueued: ago(400) + i * 1000 }));
    const bRuns: string[] = [];
    for (let i = 0; i < 10; i++) bRuns.push(addRun({ job: b, enqueued: ago(400) + i * 1000 }));
    const r = await prune(settings(90, 25));
    expect(r.runs).toBe(5);
    expect(runIds().filter((id) => aRuns.includes(id))).toEqual(aRuns.slice(5).sort());
    // b has fewer runs than the floor: all stay.
    expect(runIds().filter((id) => bRuns.includes(id))).toHaveLength(10);
  });

  test("the floor counts only runs that are not queued/running/skipped", async () => {
    const job = addJob("a");
    const old: string[] = [];
    for (let i = 0; i < 4; i++) old.push(addRun({ job, enqueued: ago(300) + i * 1000 }));
    // Newer rows that must not use up floor slots.
    for (let i = 0; i < 5; i++) addRun({ job, state: "skipped", enqueued: ago(200) + i });
    addRun({ job, state: "running", enqueued: ago(100) });
    const r = await prune(settings(90, 3));
    // Floor = newest 3 real runs of the 4 old ones; only the oldest goes.
    expect(r.runs - r.skippedRuns).toBe(1);
    expect(hasRun(old[0]!)).toBe(false);
    expect(old.slice(1).every(hasRun)).toBe(true);
  });

  test("runs sharing an enqueue time are ranked by run_id, so the floor is exact", async () => {
    const job = addJob("a");
    const ids = [1, 2, 3, 4, 5, 6].map((n) => addRun({ job, enqueued: ago(200), id: uuid(n) }));
    const r = await prune(settings(90, 2));
    expect(r.runs).toBe(4);
    expect(runIds()).toEqual([ids[4]!, ids[5]!]);
  });

  test("recent runs are kept even when a job has far more than N", async () => {
    const job = addJob("a");
    const recent: string[] = [];
    for (let i = 0; i < 40; i++) recent.push(addRun({ job, enqueued: ago(5) + i * 1000 }));
    const r = await prune(settings(90, 25));
    expect(r.runs).toBe(0);
    expect(runIds()).toHaveLength(40);
  });

  test("skipped runs expire after min(days, 14) days with no floor", async () => {
    const job = addJob("a");
    const real = addRun({ job, enqueued: ago(200) });
    const oldSkipped = addRun({ job, state: "skipped", enqueued: ago(15) });
    const freshSkipped = addRun({ job, state: "skipped", enqueued: ago(13) });
    const r = await prune(settings(90, 25));
    expect(r.skippedRuns).toBe(1);
    expect(r.runs).toBe(1);
    expect(hasRun(oldSkipped)).toBe(false);
    expect(hasRun(freshSkipped)).toBe(true);
    expect(hasRun(real)).toBe(true);

    // With a short horizon the skipped horizon follows it.
    const r2 = await prune(settings(10, 25));
    expect(r2.skippedRuns).toBe(1);
    expect(hasRun(freshSkipped)).toBe(false);
    expect(hasRun(real)).toBe(true);
  });

  test("a job that only ever skipped loses its old rows and keeps none artificially", async () => {
    const job = addJob("a");
    for (let i = 0; i < 30; i++) addRun({ job, state: "skipped", enqueued: ago(30) + i });
    const r = await prune(settings(90, 25));
    expect(r.skippedRuns).toBe(30);
    expect(runIds()).toEqual([]);
  });

  test("a run a condition trigger still names as pending is kept", async () => {
    const job = addJob("a");
    db.query(
      `INSERT INTO triggers (trigger_id, job_id, kind, config_json, last_seen_in_config_at, updated_at, created_at)
       VALUES ('a:cond', ?, 'cron', '{}', 0, 0, 0)`,
    ).run(job);
    const pending = addRun({ job, enqueued: ago(200) });
    const other = addRun({ job, enqueued: ago(200) + 1 });
    db.query(`INSERT INTO condition_states (trigger_id, pending_run_id, updated_at) VALUES ('a:cond', ?, 0)`).run(pending);
    const r = await prune(settings(30, 0));
    expect(r.runs).toBe(1);
    expect(hasRun(pending)).toBe(true);
    expect(hasRun(other)).toBe(false);
  });

  test("a receipt that names a pruned run keeps its history and loses only the link", async () => {
    const job = addJob("a");
    addTrigger(job, "a:hook");
    const run = addRun({ job, enqueued: ago(3) });
    addDelivery({ id: uuid(9001), trigger: "a:hook", receivedAt: ago(3), runId: run });
    await prune(settings(1, 0));
    expect(hasRun(run)).toBe(false);
    const row = db.query<{ run_id: string | null }, []>(`SELECT run_id FROM webhook_deliveries`).get();
    expect(row).toEqual({ run_id: null });
  });
});

describe("files go together with rows", () => {
  test("the log file, the row and the empty date directories are all removed", async () => {
    const job = addJob("a");
    const old = addRun({ job, enqueued: ago(200), bytes: 2048 });
    const keep = addRun({ job, enqueued: ago(1) });
    const oldLog = join(dataDir, logPathFor(old, ago(200)));
    const keepLog = join(dataDir, logPathFor(keep, ago(1)));
    expect(existsSync(oldLog)).toBe(true);

    const r = await prune(settings(90, 0));
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(keepLog)).toBe(true);
    expect(hasRun(old)).toBe(false);
    expect(r.runLogFiles).toBe(1);
    expect(r.bytesFreed).toBe(2048);
    // The old date directory chain is gone; the runs root and today's chain stay.
    expect(existsSync(dirname(oldLog))).toBe(false);
    expect(existsSync(join(dataDir, "runs"))).toBe(true);
    expect(existsSync(dirname(keepLog))).toBe(true);
    expect(r.emptyDirs).toBeGreaterThanOrEqual(1);
  });

  test("a non-empty date directory is left alone, and so are recent empty ones", async () => {
    const job = addJob("a");
    const stay = addRun({ job, enqueued: ago(200) });
    // Same day, another run that is kept (floor) -> directory stays non-empty.
    const kept = addRun({ job, enqueued: ago(200) + 5000 });
    const newestDir = join(dataDir, "runs", "2026", "06", "14"); // yesterday
    mkdirSync(newestDir, { recursive: true });
    const r = await prune(settings(90, 1));
    expect(hasRun(stay)).toBe(false);
    expect(hasRun(kept)).toBe(true);
    expect(existsSync(dirname(join(dataDir, logPathFor(kept, ago(200)))))).toBe(true);
    expect(existsSync(newestDir)).toBe(true);
    expect(r.errors).toBe(0);
  });

  test("a run without a log (null log_path) is removed cleanly", async () => {
    const job = addJob("a");
    addRun({ job, enqueued: ago(200), log: false });
    const r = await prune(settings(30, 0));
    expect(r.runs).toBe(1);
    expect(r.runLogFiles).toBe(0);
  });

  test("a log_path outside runs/ is never touched (the row still goes)", async () => {
    const job = addJob("a");
    const outside = writeFile("../outside.log", 10);
    const inData = writeFile("automations-notes.txt", 10);
    addRun({ job, enqueued: ago(200), log: "../outside.log" });
    addRun({ job, enqueued: ago(200) + 1, log: "automations-notes.txt" });
    addRun({ job, enqueued: ago(200) + 2, log: "/etc/hosts" });
    const r = await prune(settings(30, 0));
    expect(r.runs).toBe(3);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(inData)).toBe(true);
    expect(existsSync("/etc/hosts")).toBe(true);
    expect(r.runLogFiles).toBe(0);
  });

  test("a symlinked log is not followed", async () => {
    const job = addJob("a");
    const target = join(tmp, "precious.txt");
    writeFileSync(target, "keep me");
    const id = uuid(500);
    const rel = logPathFor(id, ago(200));
    mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
    symlinkSync(target, join(dataDir, rel));
    addRun({ job, enqueued: ago(200), id, log: rel });
    // A symlinked directory in the chain, too.
    const linkDir = join(dataDir, "runs", "linked");
    symlinkSync(tmp, linkDir);
    writeFileSync(join(tmp, "via-dir.log"), "keep me too");
    addRun({ job, enqueued: ago(200) + 1, log: "runs/linked/via-dir.log" });

    await prune(settings(30, 0));
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(tmp, "via-dir.log"))).toBe(true);
    expect(runIds()).toEqual([]);
  });

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  test.skipIf(asRoot)("if the log cannot be removed the row is kept and the sweep terminates", async () => {
    const job = addJob("a");
    const stuck = addRun({ job, enqueued: ago(200) });
    const fine = addRun({ job, enqueued: ago(201), log: false });
    chmodSync(dirname(join(dataDir, logPathFor(stuck, ago(200)))), 0o500);
    const r = await prune(settings(30, 0), { batchSize: 1 });
    expect(hasRun(stuck)).toBe(true); // no row without its file being handled
    expect(hasRun(fine)).toBe(false);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(r.runs).toBe(1);
  });

  test("a row whose log was already removed is finished off by the next sweep", async () => {
    const job = addJob("a");
    const id = addRun({ job, enqueued: ago(200) });
    rmSync(join(dataDir, logPathFor(id, ago(200))));
    const r = await prune(settings(30, 0));
    expect(hasRun(id)).toBe(false);
    expect(r.errors).toBe(0);
  });
});

describe("dry run", () => {
  test("reports exactly what a real sweep removes and deletes nothing", async () => {
    const a = addJob("a");
    addTrigger(a, "a:hook");
    for (let i = 0; i < 12; i++) addRun({ job: a, enqueued: ago(300) + i * 1000, bytes: 1000 });
    for (let i = 0; i < 5; i++) addRun({ job: a, state: "skipped", enqueued: ago(40) + i });
    addRun({ job: a, state: "running", enqueued: ago(300) });
    const payload = writeFile("payloads/keep-me.payload", 50, ago(200));
    addDelivery({ id: uuid(9100), trigger: "a:hook", receivedAt: ago(200), payload: "payloads/" + uuid(9100) + ".payload" });
    writeFile("payloads/" + uuid(9100) + ".payload", 70, ago(200));
    const orphan = writeFile(`runs/2025/01/02/${uuid(9200)}.log`, 300, ago(300));

    const rowsBefore = runIds();
    const filesBefore = readdirSyncDeep(dataDir);
    const dry = await prune(settings(90, 5), { dryRun: true, batchSize: 3 });
    expect(dry.dryRun).toBe(true);
    expect(runIds()).toEqual(rowsBefore);
    expect(readdirSyncDeep(dataDir)).toEqual(filesBefore);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(payload)).toBe(true);
    expect(db.query(`SELECT 1 FROM webhook_deliveries`).all()).toHaveLength(1);
    expect(dry.runs).toBe(12 - 5 + 5);
    expect(dry.orphanLogFiles).toBe(1);
    expect(dry.webhookDeliveries).toBe(1);
    expect(dry.payloadFiles).toBe(1);

    const real = await prune(settings(90, 5), { batchSize: 3 });
    // Directory counts differ by design: a dry run leaves the files, so nothing is empty yet.
    expect({ ...real, dryRun: true, durationMs: 0, emptyDirs: 0 }).toEqual({ ...dry, durationMs: 0, emptyDirs: 0 });
    expect(runIds()).not.toEqual(rowsBefore);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("AUTO_RETENTION_DAYS=0", () => {
  test("keeps everything: rows, logs, receipts, orphans and directories", async () => {
    const job = addJob("a");
    addTrigger(job, "a:hook");
    addRun({ job, enqueued: ago(5000) });
    addRun({ job, state: "skipped", enqueued: ago(5000) });
    addDelivery({ id: uuid(9300), trigger: "a:hook", receivedAt: ago(5000) });
    const orphan = writeFile(`runs/2001/01/01/${uuid(9301)}.log`, 10, ago(5000));
    const payload = writeFile(`payloads/${uuid(9302)}.payload`, 10, ago(5000));
    mkdirSync(join(dataDir, "runs", "2001", "02", "03"), { recursive: true });
    const before = readdirSyncDeep(dataDir);

    const r = await prune(settings(0, 25));
    expect(r.enabled).toBe(false);
    expect(runIds()).toHaveLength(2);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(payload)).toBe(true);
    expect(readdirSyncDeep(dataDir)).toEqual(before);
    expect(db.query(`SELECT 1 FROM webhook_deliveries`).all()).toHaveLength(1);
  });

  test("the scheduler does not start a timer", async () => {
    const lines: string[] = [];
    const handle = startRetention({
      db,
      dataDir,
      env: { AUTO_RETENTION_DAYS: "0" },
      firstSweepDelayMs: 1,
      log: (l) => lines.push(l),
    });
    await Bun.sleep(30);
    expect(lines).toEqual(["[retention] disabled (AUTO_RETENTION_DAYS=0): nothing removed"]);
    await handle.stop();
  });
});

describe("webhook deliveries and payloads", () => {
  test("receipts older than max(days, 7) go with their kept payload; younger ones stay", async () => {
    const job = addJob("a");
    addTrigger(job, "a:hook");
    const oldId = uuid(9400);
    const youngId = uuid(9401);
    const oldFile = writeFile(`payloads/${oldId}.payload`, 500);
    const youngFile = writeFile(`payloads/${youngId}.payload`, 500);
    addDelivery({ id: oldId, trigger: "a:hook", receivedAt: ago(8), payload: `payloads/${oldId}.payload` });
    addDelivery({ id: youngId, trigger: "a:hook", receivedAt: ago(6), payload: `payloads/${youngId}.payload` });
    // days=1 -> horizon is still 7 days for receipts.
    const r = await prune(settings(1, 25));
    expect(r.webhookDeliveries).toBe(1);
    expect(r.payloadFiles).toBe(1);
    expect(r.bytesFreed).toBe(500);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(youngFile)).toBe(true);
    expect(db.query<{ receipt_id: string }, []>(`SELECT receipt_id FROM webhook_deliveries`).all()).toEqual([
      { receipt_id: youngId },
    ]);
  });

  test("a receipt inside the 5-minute dedupe window is never removed", async () => {
    const job = addJob("a");
    addTrigger(job, "a:hook");
    addDelivery({ id: uuid(9410), trigger: "a:hook", receivedAt: NOW - DEDUPE_WINDOW_MS + 1000 });
    addDelivery({ id: uuid(9411), trigger: "a:hook", receivedAt: NOW - 60_000 });
    const r = await prune(settings(1, 0));
    expect(r.webhookDeliveries).toBe(0);
    expect(db.query(`SELECT 1 FROM webhook_deliveries`).all()).toHaveLength(2);
  });

  test("a receipt for a run that is still active is kept, however old", async () => {
    const job = addJob("a");
    addTrigger(job, "a:hook");
    const running = addRun({ job, state: "running", enqueued: ago(30) });
    addDelivery({ id: uuid(9420), trigger: "a:hook", receivedAt: ago(30), runId: running });
    const r = await prune(settings(1, 0));
    expect(r.webhookDeliveries).toBe(0);
  });

  test("orphan payload files: removed only past the horizon and only when no receipt or active run uses them", async () => {
    const job = addJob("a");
    addTrigger(job, "a:hook");
    const orphanOld = writeFile(`payloads/${uuid(9430)}.payload`, 10, ago(100));
    const orphanEphemeral = writeFile(`payloads/ephemeral/${uuid(9431)}.payload`, 10, ago(100));
    const orphanYoung = writeFile(`payloads/${uuid(9432)}.payload`, 10, ago(10));
    const referenced = writeFile(`payloads/${uuid(9433)}.payload`, 10, ago(100));
    addDelivery({ id: uuid(9433), trigger: "a:hook", receivedAt: ago(1), payload: `payloads/${uuid(9433)}.payload` });
    const activeId = uuid(9434);
    const activeFile = writeFile(`payloads/ephemeral/${activeId}.payload`, 10, ago(100));
    db.query(
      `INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at, trigger_meta)
       VALUES (?, ?, 'webhook', 'running', ?, ?)`,
    ).run(uuid(9435), job, ago(100), JSON.stringify({ receipt_id: activeId }));
    const unrelated = writeFile("payloads/notes.txt", 10, ago(100));

    const r = await prune(settings(90, 25));
    expect(r.orphanPayloadFiles).toBe(2);
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(orphanEphemeral)).toBe(false);
    expect(existsSync(orphanYoung)).toBe(true);
    expect(existsSync(referenced)).toBe(true);
    expect(existsSync(activeFile)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});

describe("orphan run logs", () => {
  test("a log with no row is removed once older than the horizon; others stay", async () => {
    const job = addJob("a");
    const live = addRun({ job, enqueued: ago(1) });
    const liveLog = join(dataDir, logPathFor(live, ago(1)));
    const orphanOld = writeFile(`runs/2026/01/01/${uuid(9500)}.log`, 400, ago(160));
    const orphanYoung = writeFile(`runs/2026/06/10/${uuid(9501)}.log`, 400, ago(5));
    // Old file whose row still exists (running): kept.
    const runningId = uuid(9502);
    const runningLog = writeFile(`runs/2026/01/02/${runningId}.log`, 10, ago(160));
    addRun({ job, state: "running", enqueued: ago(160), id: runningId, log: `runs/2026/01/02/${runningId}.log` });
    const stranger = writeFile("runs/2026/01/01/README.txt", 10, ago(160));

    const r = await prune(settings(90, 25));
    expect(r.orphanLogFiles).toBe(1);
    expect(r.bytesFreed).toBe(400);
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(orphanYoung)).toBe(true);
    expect(existsSync(liveLog)).toBe(true);
    expect(existsSync(runningLog)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
  });
});

describe("batching", () => {
  test("terminates and yields to the event loop between batches", async () => {
    const job = addJob("a");
    for (let i = 0; i < 120; i++) addRun({ job, enqueued: ago(300) + i * 1000, log: false });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const r = await prune(settings(30, 10), { batchSize: 7 });
      expect(r.runs).toBe(110);
    } finally {
      clearInterval(timer);
    }
    expect(runIds()).toHaveLength(10);
    // 110 rows in batches of 7 -> 16 yields; the loop must have got some turns.
    expect(ticks).toBeGreaterThan(0);
  });

  test("a dry run with tiny batches terminates too", async () => {
    const job = addJob("a");
    for (let i = 0; i < 25; i++) addRun({ job, enqueued: ago(300) + i * 1000, log: false });
    const r = await prune(settings(30, 0), { dryRun: true, batchSize: 1 });
    expect(r.runs).toBe(25);
    expect(runIds()).toHaveLength(25);
  });

  test("shouldStop ends the sweep at a batch boundary", async () => {
    const job = addJob("a");
    for (let i = 0; i < 30; i++) addRun({ job, enqueued: ago(300) + i * 1000, log: false });
    // Ask to stop once at least two batches are gone.
    const r = await prune(settings(30, 0), { batchSize: 5, shouldStop: () => runIds().length <= 20 });
    expect(r.runs).toBe(10);
    expect(runIds()).toHaveLength(20);
  });

  test("never throws: a closed database is counted as an error", async () => {
    const job = addJob("a");
    addRun({ job, enqueued: ago(300), log: false });
    db.close();
    const r = await prune(settings(30, 0));
    expect(r.errors).toBeGreaterThan(0);
  });

  test("tolerates a busy database: another connection writes runs while the sweep works", async () => {
    const job = addJob("a");
    for (let i = 0; i < 80; i++) addRun({ job, enqueued: ago(300) + i * 1000, log: false });
    const other = new Database(join(dataDir, "automations.db"));
    other.run("PRAGMA busy_timeout = 5000;");
    const added: string[] = [];
    let n = 0;
    const writer = setInterval(() => {
      const id = uuid(70_000 + n++);
      other.query(
        `INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at) VALUES (?, ?, 'cron', 'running', ?)`,
      ).run(id, job, NOW);
      added.push(id);
      if (added.length > 1) {
        other.query(`UPDATE runs SET state = 'succeeded', finished_at = ? WHERE run_id = ?`).run(NOW, added[added.length - 2]!);
      }
    }, 1);
    let r: PruneResult;
    try {
      r = await prune(settings(30, 0), { batchSize: 2 });
    } finally {
      clearInterval(writer);
      other.close();
    }
    expect(r.errors).toBe(0);
    expect(r.runs).toBe(80);
    expect(added.length).toBeGreaterThan(0);
    // Everything the writer added is still there.
    expect(runIds().filter((id) => added.includes(id))).toHaveLength(added.length);
  });
});

describe("scheduler", () => {
  test("sweeps after the first delay, logs one summary line, and stop() ends it", async () => {
    const job = addJob("a");
    addRun({ job, enqueued: Date.now() - 400 * DAY, log: false });
    const lines: string[] = [];
    const handle = startRetention({
      db,
      dataDir,
      env: { AUTO_RETENTION_DAYS: "30", AUTO_RETENTION_MIN_RUNS: "0" },
      firstSweepDelayMs: 20,
      intervalMs: 30,
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual([]);
    await Bun.sleep(150);
    await handle.stop();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/^\[retention\] removed 1 runs, 0 log files, 0 webhook deliveries, 0 payload files, \d+ empty dirs, freed 0\.0 MB \(\d+ ms\)$/);
    expect(runIds()).toEqual([]);
    const count = lines.length;
    await Bun.sleep(80);
    expect(lines.length).toBe(count); // no sweep after stop()
  });

  test("stop() before the first sweep cancels it", async () => {
    const lines: string[] = [];
    const handle = startRetention({ db, dataDir, env: {}, firstSweepDelayMs: 20, log: (l) => lines.push(l) });
    await handle.stop();
    await Bun.sleep(60);
    expect(lines).toEqual([]);
    await handle.stop(); // idempotent
  });

  test("stop() waits for a sweep in flight, which stops at the next batch", async () => {
    const job = addJob("a");
    for (let i = 0; i < 400; i++) addRun({ job, enqueued: ago(300) + i * 1000, log: false });
    const handle = startRetention({
      db,
      dataDir,
      env: { AUTO_RETENTION_DAYS: "30", AUTO_RETENTION_MIN_RUNS: "0" },
      firstSweepDelayMs: 10_000,
      batchSize: 2,
      log: () => {},
    });
    const sweeping = handle.pruneOnce();
    // Let the first batches run, then stop mid-sweep.
    while (runIds().length === 400) await new Promise((done) => setTimeout(done, 0));
    await handle.stop();
    const result = await sweeping;
    expect(result.runs).toBeGreaterThan(0);
    expect(result.runs).toBeLessThan(400);
    // Nothing was left mid-write.
    expect(db.query(`SELECT count(*) AS n FROM runs`).get()).toEqual({ n: 400 - result.runs });
  });

  test("concurrent pruneOnce calls share one sweep; a dry run reports without deleting", async () => {
    const job = addJob("a");
    for (let i = 0; i < 20; i++) addRun({ job, enqueued: Date.now() - 300 * DAY + i * 1000, log: false });
    const handle = startRetention({
      db,
      dataDir,
      env: { AUTO_RETENTION_DAYS: "30", AUTO_RETENTION_MIN_RUNS: "0" },
      firstSweepDelayMs: 10_000,
      log: () => {},
    });
    const dry = await handle.pruneOnce({ dryRun: true });
    expect(dry.runs).toBe(20);
    expect(runIds()).toHaveLength(20);
    const [a, b] = await Promise.all([handle.pruneOnce(), handle.pruneOnce()]);
    expect(a).toBe(b);
    expect(a.runs).toBe(20);
    await handle.stop();
  });
});

describe("migration 0003", () => {
  test("upgrades a database that has only 0001 and 0002, keeps its data, adds the indexes", async () => {
    const path = join(tmp, "old.db");
    const old = new Database(path);
    old.run("PRAGMA foreign_keys = ON;");
    const dir = join(import.meta.dir, "..", "supervisor", "db", "migrations");
    for (const [version, file] of [["0001", "0001_init.sql"], ["0002", "0002_conditions_webhooks.sql"]] as const) {
      old.run(await Bun.file(join(dir, file)).text());
      old.query(`INSERT INTO schema_migrations VALUES (?, ?, 0)`).run(version, file);
    }
    old.run(`INSERT INTO jobs (job_id, name, last_seen_in_config_at, created_at) VALUES ('j', 'j', 0, 0)`);
    old.run(`INSERT INTO runs (run_id, job_id, trigger_kind, state, enqueued_at) VALUES ('r1', 'j', 'cron', 'succeeded', 5)`);
    const applied = await runMigrations(old);
    expect(applied.applied).toContain("0003");
    expect(old.query(`SELECT run_id FROM runs`).all()).toEqual([{ run_id: "r1" }]);
    const indexes = old
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["runs_job_enqueued", "webhook_deliveries_run", "condition_states_pending"]));
    expect((await runMigrations(old)).applied).toEqual([]);
    old.close();
  });

  test("the sweeper's queries use the new indexes", () => {
    const plan = (sql: string): string =>
      db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join("\n");
    expect(
      plan(`SELECT enqueued_at, run_id FROM runs WHERE job_id = 'j' AND state NOT IN ('queued','running','skipped')
            ORDER BY enqueued_at DESC, run_id DESC LIMIT 1 OFFSET 24`),
    ).toContain("runs_job_enqueued");
    expect(
      plan(`SELECT run_id FROM runs WHERE job_id = 'j' AND state = 'skipped' AND enqueued_at < 5
            AND (enqueued_at, run_id) > (1, '') ORDER BY enqueued_at, run_id LIMIT 10`),
    ).toContain("runs_job_enqueued");
    expect(plan(`UPDATE webhook_deliveries SET run_id = NULL WHERE run_id = 'x'`)).toContain("webhook_deliveries_run");
  });
});

// -- helpers that need the schema ---------------------------------------------

function addTrigger(job: string, id: string): void {
  db.query(
    `INSERT INTO triggers (trigger_id, job_id, kind, config_json, last_seen_in_config_at, updated_at, created_at)
     VALUES (?, ?, 'webhook', '{}', 0, 0, 0)`,
  ).run(id, job);
}

function addDelivery(d: { id: string; trigger: string; receivedAt: number; runId?: string | null; payload?: string | null }): void {
  db.query(
    `INSERT INTO webhook_deliveries (receipt_id, trigger_id, dedupe_key, body_digest, received_at, disposition, run_id, payload_path)
     VALUES (?, ?, ?, 'digest', ?, 'started', ?, ?)`,
  ).run(d.id, d.trigger, `key-${d.id}`, d.receivedAt, d.runId ?? null, d.payload ?? null);
}
