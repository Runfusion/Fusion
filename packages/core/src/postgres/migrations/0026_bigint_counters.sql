/*
FNXC:PostgresBigintCounters 2026-07-18-21:45:
SQLite INTEGER is a 1-8 byte signed integer (effectively int64), but the PostgreSQL
baseline mapped several open-ended counters to integer (int4). Real task data
contains values that exceed 2,147,483,647 (e.g. cached token counts and cumulative
active millisecond timers), which caused the SQLite-to-PostgreSQL migration to fail
with "value ... is out of range for type integer". Upgrade the affected columns to
bigint without changing nullability or defaults.

Affected columns:
  project.tasks.token_usage_input_tokens
  project.tasks.token_usage_output_tokens
  project.tasks.token_usage_cached_tokens
  project.tasks.token_usage_cache_write_tokens
  project.tasks.token_usage_total_tokens
  project.tasks.cumulative_active_ms
  project.tasks.checkout_lease_epoch
  project.chat_token_usage.input_tokens
  project.chat_token_usage.output_tokens
  project.chat_token_usage.cached_tokens
  project.chat_token_usage.cache_write_tokens
  project.chat_token_usage.total_tokens

FNXC:PostgresBigintCounters 2026-07-20-23:55:
Upgrade paths from early baselines may have project.tasks without the token_usage_*
columns yet (they land in later migrations). ALTER COLUMN fails hard if the column
is missing, so only widen columns that already exist. Fresh baselines already declare
bigint in SCHEMA_BASELINE DDL.

FNXC:PostgresBigintCounters 2026-07-22-03:15:
Per-column guards (not a single representative-column check) so a partial schema —
e.g. only token_usage_input_tokens present — never references a missing sibling and
aborts the schema-applier transaction.
*/
DO $$
BEGIN
  IF to_regclass('project.tasks') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'token_usage_input_tokens'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN token_usage_input_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'token_usage_output_tokens'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN token_usage_output_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'token_usage_cached_tokens'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN token_usage_cached_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'token_usage_cache_write_tokens'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN token_usage_cache_write_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'token_usage_total_tokens'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN token_usage_total_tokens TYPE bigint;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'cumulative_active_ms'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN cumulative_active_ms TYPE bigint;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'checkout_lease_epoch'
    ) THEN
      ALTER TABLE project.tasks ALTER COLUMN checkout_lease_epoch TYPE bigint;
    END IF;
  END IF;

  IF to_regclass('project.chat_token_usage') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'chat_token_usage' AND column_name = 'input_tokens'
    ) THEN
      ALTER TABLE project.chat_token_usage ALTER COLUMN input_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'chat_token_usage' AND column_name = 'output_tokens'
    ) THEN
      ALTER TABLE project.chat_token_usage ALTER COLUMN output_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'chat_token_usage' AND column_name = 'cached_tokens'
    ) THEN
      ALTER TABLE project.chat_token_usage ALTER COLUMN cached_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'chat_token_usage' AND column_name = 'cache_write_tokens'
    ) THEN
      ALTER TABLE project.chat_token_usage ALTER COLUMN cache_write_tokens TYPE bigint;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'chat_token_usage' AND column_name = 'total_tokens'
    ) THEN
      ALTER TABLE project.chat_token_usage ALTER COLUMN total_tokens TYPE bigint;
    END IF;
  END IF;
END
$$;
