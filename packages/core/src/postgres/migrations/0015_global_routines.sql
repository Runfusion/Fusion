-- FNXC:PostgresSchema 2026-07-16-15:00: global backup schedules belong to the shared cluster, not a project partition.
CREATE TABLE IF NOT EXISTS central.global_routines (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  agent_id text NOT NULL DEFAULT '',
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL,
  command text,
  enabled integer NOT NULL DEFAULT 1,
  last_run_at text,
  last_run_result jsonb,
  next_run_at text,
  run_count integer NOT NULL DEFAULT 0,
  run_history jsonb NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_routines_next_run_at ON central.global_routines(next_run_at);
