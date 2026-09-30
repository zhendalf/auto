CREATE TABLE condition_states (
  trigger_id                    TEXT PRIMARY KEY REFERENCES triggers(trigger_id),
  state_json                    TEXT,
  pending_run_id                TEXT REFERENCES runs(run_id),
  pending_state_json            TEXT,
  evaluation_count              INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at             INTEGER,
  last_fired_at                 INTEGER,
  consecutive_failures          INTEGER NOT NULL DEFAULT 0,
  last_error                    TEXT,
  updated_at                    INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  receipt_id                    TEXT PRIMARY KEY,
  trigger_id                   TEXT NOT NULL REFERENCES triggers(trigger_id),
  dedupe_key                   TEXT NOT NULL,
  delivery_id                  TEXT,
  body_digest                  TEXT NOT NULL,
  received_at                  INTEGER NOT NULL,
  disposition                 TEXT NOT NULL,
  run_id                       TEXT REFERENCES runs(run_id),
  payload_path                 TEXT,
  error                        TEXT,
  UNIQUE(trigger_id, dedupe_key)
);

CREATE INDEX webhook_deliveries_received
  ON webhook_deliveries(received_at DESC);
