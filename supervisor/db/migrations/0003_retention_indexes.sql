-- Indexes for the retention sweeper (supervisor/retention.ts). Additive only.
--
-- runs_job_enqueued: per-job "newest N runs" cutoff and the oldest-first
-- candidate scan, both ordered by (enqueued_at, run_id) within one job.
-- webhook_deliveries_run: deleting a run makes SQLite look for child rows that
-- reference it; without this index that lookup scans the whole table per row.
-- condition_states_pending: same, for condition_states.pending_run_id.
CREATE INDEX IF NOT EXISTS runs_job_enqueued
  ON runs(job_id, enqueued_at, run_id);

CREATE INDEX IF NOT EXISTS webhook_deliveries_run
  ON webhook_deliveries(run_id) WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS condition_states_pending
  ON condition_states(pending_run_id) WHERE pending_run_id IS NOT NULL;
