-- Durable wait state for gates and agent stage-complete callbacks.
CREATE TABLE gates (
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'gate' | 'stage-complete'
  status TEXT NOT NULL,          -- 'waiting' | 'resolved' | 'rejected'
  payload TEXT,                  -- JSON — resolution value or rejection reason
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  PRIMARY KEY (instance_id, stage_id, kind)
);

CREATE INDEX idx_gates_status ON gates(status);
CREATE INDEX idx_gates_instance ON gates(instance_id);

-- Scheduled timers that must survive server restart (e.g., gate timeouts).
CREATE TABLE scheduled_timers (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'gate-timeout' | 'retry-backoff' | etc.
  fire_at TEXT NOT NULL,         -- ISO timestamp
  payload TEXT,                  -- JSON — context for the timer callback
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_scheduled_timers_fire_at ON scheduled_timers(fire_at);
CREATE INDEX idx_scheduled_timers_instance ON scheduled_timers(instance_id);
