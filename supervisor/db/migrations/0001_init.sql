CREATE TABLE jobs (
  job_id                 TEXT    PRIMARY KEY,
  name                   TEXT    NOT NULL UNIQUE,
  enabled                INTEGER NOT NULL DEFAULT 1,
  paused_until           INTEGER,
  archived_at            INTEGER,
  last_seen_in_config_at INTEGER NOT NULL,
  created_at             INTEGER NOT NULL
);

CREATE TABLE triggers (
  trigger_id             TEXT    PRIMARY KEY,
  job_id                 TEXT    NOT NULL REFERENCES jobs(job_id),
  kind                   TEXT    NOT NULL,
  config_json            TEXT    NOT NULL,
  enabled                INTEGER NOT NULL DEFAULT 1,
  last_seen_in_config_at INTEGER NOT NULL,
  archived_at            INTEGER,
  updated_at             INTEGER NOT NULL,
  created_at             INTEGER NOT NULL
);

CREATE TABLE runs (
  run_id                 TEXT    PRIMARY KEY,
  job_id                 TEXT    NOT NULL REFERENCES jobs(job_id),
  trigger_id             TEXT             REFERENCES triggers(trigger_id),
  trigger_kind           TEXT    NOT NULL,
  state                  TEXT    NOT NULL,
  skip_reason            TEXT,
  enqueued_at            INTEGER NOT NULL,
  started_at             INTEGER,
  finished_at            INTEGER,
  exit_code              INTEGER,
  signal                 TEXT,
  trigger_meta           TEXT,
  log_path               TEXT,
  payload_path           TEXT,
  pid                    INTEGER,
  cwd                    TEXT,
  worker_path            TEXT,
  definition_hash        TEXT
);

CREATE INDEX runs_job_started ON runs(job_id, started_at DESC);
CREATE INDEX runs_state_unfinished ON runs(state) WHERE state IN ('queued','running');

CREATE TABLE schema_migrations (
  version    TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);
