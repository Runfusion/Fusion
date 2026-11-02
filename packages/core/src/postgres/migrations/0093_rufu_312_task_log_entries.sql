/*
FNXC:TaskLogSideTable 2026-11-01-17:25 (RUFU-312):
The task activity log stops living inside the row it describes.

Measured on the production board 2026-10-31: `project.tasks` heap 4 609 MB against 55 MB of live row
data, and the `log` jsonb column alone accounted for 25 MB of those live bytes (max single row 313 KB).
Every append therefore rewrote a ~28 KB row version, produced a fresh TOAST chunk for the grown array,
and re-maintained 16 indexes — the append path, not the readers, is what filled the heap.

This migration creates the append-only destination (`task_log_entries`), the small per-task envelope
rollup that replaces the write-time `tasks.timing_total_ms` / `tasks.log_recent` pairing for appends
(`task_log_rollup`), and the per-project backfill witness (`task_log_backfill_marker`). It then copies
every existing legacy array across, so the cutover has no data-loss window.

Nothing here reclaims the heap the old write path already produced: `VACUUM FULL` / `pg_repack` take an
exclusive lock and are an operator-decided maintenance window (docs/storage.md), never an automatic
action, and the legacy `tasks.log` column is dropped the same way. This migration only stops the bleeding.
*/

CREATE TABLE IF NOT EXISTS project.task_log_entries (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  task_id text NOT NULL,
  /*
  A global identity, not a per-task counter: per-task monotonicity follows from global monotonicity, and
  it needs no read-modify-write race to mint. `timestamp` cannot order two entries written in the same
  millisecond, and History rows visibly reorder when the tie-breaker is missing.
  */
  seq bigint GENERATED ALWAYS AS IDENTITY,
  action text NOT NULL,
  outcome text,
  timestamp text NOT NULL,
  run_context jsonb,
  dedupe_key text,
  PRIMARY KEY (project_id, task_id, seq),
  /*
  FNXC:TaskLogSideTable 2026-11-01-21:10 (RUFU-312):
  ON UPDATE CASCADE is not decorative. `rekeyFallbackProjectPartition` promotes a fallback partition by
  UPDATE-ing `project_id` on every project-scoped row, and it refuses the whole promotion
  (`unsafe-fk-update-graph`) when any child FK on a table holding rows simply lacks ON UPDATE. A child that
  inherits its parent's partition key therefore has to propagate it, exactly as the pre-existing
  `stale_review_callback_waiver_receipts` FK does. Without this clause the new table would make every
  fallback-partition promotion fail on every database that has ever run this migration.
  */
  FOREIGN KEY (project_id, task_id) REFERENCES project.tasks (project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);

/* Newest-first page scan (the History tab and the ≤1 000-entry hydration) and the dedupe-window probe. */
CREATE INDEX IF NOT EXISTS idx_task_log_entries_task_time
  ON project.task_log_entries (project_id, task_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_task_log_entries_dedupe
  ON project.task_log_entries (project_id, task_id, dedupe_key, seq DESC)
  WHERE dedupe_key IS NOT NULL;

/*
FNXC:TaskLogSideTable 2026-11-01-17:25 (RUFU-312):
Why a rollup table instead of keeping `tasks.timing_total_ms` / `tasks.log_recent` fresh: those two
columns are only correct because the writer that authored `log` authored them in the same UPDATE
(FNXC:TaskLogProjections, RUFU-615). A pure append has no such UPDATE, and issuing one to keep them warm
would restore the fat-row rewrite this migration exists to delete. The envelope is therefore authored
here — one small row per task — and `tasks.log_projection_at` below is the witness that decides which of
the two authors is current.
*/
CREATE TABLE IF NOT EXISTS project.task_log_rollup (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  task_id text NOT NULL,
  entry_count integer NOT NULL DEFAULT 0,
  timing_total_ms double precision NOT NULL DEFAULT 0,
  log_recent jsonb,
  computed_at text NOT NULL,
  PRIMARY KEY (project_id, task_id),
  FOREIGN KEY (project_id, task_id) REFERENCES project.tasks (project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS project.task_log_backfill_marker (
  project_id text PRIMARY KEY,
  backfilled_at text NOT NULL,
  copied_entry_count integer NOT NULL DEFAULT 0
);

/*
FNXC:TaskLogSideTable 2026-11-01-19:35 (RUFU-312):
Project ownership is not optional for a new `project` table: the steady-state boot audit fails the whole
schema apply ("Project-owned tables are missing required isolation") unless every relation in the schema
carries a `project_id` column, row-level security, FORCED row-level security, the `fusion_project_isolation`
policy, and the `fusion_assign_project_id` trigger. A History table is exactly the kind of table an
over-scoped read would leak across projects, so it inherits the same boundary as `tasks` rather than asking
for an exception.
*/
ALTER TABLE project.task_log_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_log_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_log_entries;
CREATE POLICY fusion_project_isolation ON project.task_log_entries
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_log_entries;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_log_entries
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.task_log_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_log_rollup FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_log_rollup;
CREATE POLICY fusion_project_isolation ON project.task_log_rollup
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_log_rollup;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_log_rollup
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.task_log_backfill_marker ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_log_backfill_marker FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_log_backfill_marker;
CREATE POLICY fusion_project_isolation ON project.task_log_backfill_marker
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_log_backfill_marker;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_log_backfill_marker
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

/*
FNXC:TaskLogSideTable 2026-11-01-17:25 (RUFU-312):
The compound-write author's own stamp, set by `withTaskLogProjections` at the same instant it authors the
derived columns. `updated_at` cannot serve as this witness: it is bumped by every unrelated field write,
and a status change that touched no log would then claim an envelope the log has not carried for hours.
*/
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS log_projection_at text;

/*
FNXC:TaskLogSideTable 2026-11-01-17:25 (RUFU-312):
ONE-TIME BACKFILL. Batched by task (200 per statement) so an interrupted migration resumes: a task that
already has side-table rows is skipped, which is also what makes a re-run after a partial apply a no-op.
The legacy array is copied in array order; non-object elements are skipped, matching what `rowToTask`
already refuses to hand a reader. The envelope rides RUFU-615's own SQL derivation function over the same
`log` value, so a backfilled task's rollup equals the `log_recent` column it already had rather than
restarting from an empty envelope.
*/
DO $fn$
DECLARE
  v_batch      int := 200;
  v_found      int;
  v_copied     bigint := 0;
  v_now        text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_has_log    boolean;
  v_has_derive boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'log'
  ) INTO v_has_log;
  IF NOT v_has_log THEN
    -- A database whose `tasks` predates `log` has nothing to copy; the marker is still written so the
    -- bounded boot catch-up knows this project was covered.
    RETURN;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'project' AND p.proname = 'fusion_task_log_projections'
  ) INTO v_has_derive;

  LOOP
    WITH picked AS (
      SELECT t.id, t.project_id, t.log
        FROM project.tasks t
       WHERE t.deleted_at IS NULL
         AND t.log IS NOT NULL
         AND jsonb_typeof(t.log) = 'array'
         AND jsonb_array_length(t.log) > 0
         AND NOT EXISTS (
           SELECT 1 FROM project.task_log_entries e
            WHERE e.project_id = t.project_id AND e.task_id = t.id
         )
       ORDER BY t.project_id, t.id
       LIMIT v_batch
       /*
       No row lock is taken here on purpose: PostgreSQL refuses `FOR UPDATE` inside a CTE, and the whole
       migration runs in one transaction under the store's migration advisory lock, so "locked by a live
       writer" cannot happen. Re-run safety comes from the NOT EXISTS probe, not from a lock.
       */
    ), copied AS (
      INSERT INTO project.task_log_entries (project_id, task_id, action, outcome, timestamp, run_context, dedupe_key)
      SELECT p.project_id, p.id,
             coalesce(elem ->> 'action', ''),
             CASE WHEN jsonb_typeof(elem -> 'outcome') = 'string' THEN elem ->> 'outcome' ELSE NULL END,
             coalesce(elem ->> 'timestamp', ''),
             CASE WHEN jsonb_typeof(elem -> 'runContext') = 'object' THEN elem -> 'runContext' ELSE NULL END,
             NULLIF(elem ->> 'dedupeKey', '')
        FROM picked p
        CROSS JOIN LATERAL jsonb_array_elements(p.log) WITH ORDINALITY AS x(elem, ord)
       WHERE jsonb_typeof(elem) = 'object'
       ORDER BY p.project_id, p.id, x.ord
      RETURNING 1
    )
    SELECT count(*) INTO v_found FROM copied;
    v_copied := v_copied + v_found;
    EXIT WHEN v_found = 0;
  END LOOP;

  /*
  The rollup pass derives from the legacy array directly rather than from the rows just copied: the
  derivation function is already RUFU-615's tested unit, it reads one value per task, and it keeps this
  migration's answer equal to the `log_recent` column a card already shows. Skipped entirely when the
  function is absent — a rollup is a cache of the log, and a missing cache costs a fallback read, never
  a failed upgrade.
  */
  IF v_has_derive THEN
    LOOP
      WITH picked AS (
        SELECT t.id, t.project_id, t.log
          FROM project.tasks t
         WHERE t.deleted_at IS NULL
           AND jsonb_typeof(t.log) = 'array'
           AND jsonb_array_length(t.log) > 0
           AND NOT EXISTS (
             SELECT 1 FROM project.task_log_rollup r
              WHERE r.project_id = t.project_id AND r.task_id = t.id
           )
         ORDER BY t.project_id, t.id
         LIMIT v_batch
      )
      INSERT INTO project.task_log_rollup (project_id, task_id, entry_count, timing_total_ms, log_recent, computed_at)
      SELECT p.project_id, p.id,
             (SELECT count(*) FROM project.task_log_entries e
               WHERE e.project_id = p.project_id AND e.task_id = p.id),
             f.timing_total_ms, f.log_recent, v_now
        FROM picked p
        CROSS JOIN LATERAL project.fusion_task_log_projections(p.log) f
      ON CONFLICT (project_id, task_id) DO NOTHING;
      GET DIAGNOSTICS v_found = ROW_COUNT;
      EXIT WHEN v_found = 0;
    END LOOP;
  END IF;

  /*
  Precedence seed: a row whose derived columns are already authored has an envelope that is current as of
  that write, so give it a stamp the reader can compare against. `updated_at` is the honest upper bound
  for a row nobody has appended to since the cutover; a later compound write re-stamps it exactly.
  */
  UPDATE project.tasks
     SET log_projection_at = coalesce(log_projection_at, updated_at)
   WHERE log_recent IS NOT NULL
     AND log_projection_at IS NULL;

  /*
  One marker per project that has any task, including projects whose arrays were empty. The boot
  catch-up reads this mark to decide whether legacy entries newer than the copy window may exist; "no
  mark" and "mark with zero copied entries" are different answers and the migration must not blur them.
  */
  INSERT INTO project.task_log_backfill_marker (project_id, backfilled_at, copied_entry_count)
  SELECT DISTINCT t.project_id, v_now, v_copied::int
    FROM project.tasks t
   WHERE t.project_id IS NOT NULL
  ON CONFLICT (project_id) DO NOTHING;
END
$fn$;
