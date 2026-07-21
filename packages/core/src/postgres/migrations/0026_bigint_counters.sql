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
*/
DO $$
BEGIN
  IF to_regclass('project.tasks') IS NOT NULL THEN
    ALTER TABLE project.tasks
      ALTER COLUMN token_usage_input_tokens TYPE bigint,
      ALTER COLUMN token_usage_output_tokens TYPE bigint,
      ALTER COLUMN token_usage_cached_tokens TYPE bigint,
      ALTER COLUMN token_usage_cache_write_tokens TYPE bigint,
      ALTER COLUMN token_usage_total_tokens TYPE bigint,
      ALTER COLUMN cumulative_active_ms TYPE bigint,
      ALTER COLUMN checkout_lease_epoch TYPE bigint;
  END IF;

  IF to_regclass('project.chat_token_usage') IS NOT NULL THEN
    ALTER TABLE project.chat_token_usage
      ALTER COLUMN input_tokens TYPE bigint,
      ALTER COLUMN output_tokens TYPE bigint,
      ALTER COLUMN cached_tokens TYPE bigint,
      ALTER COLUMN cache_write_tokens TYPE bigint,
      ALTER COLUMN total_tokens TYPE bigint;
  END IF;
END
$$;
