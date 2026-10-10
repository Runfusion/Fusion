/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
Adds the two write-time-maintained columns that let a board refresh stop reading `tasks.log`
(31.4 MB of 73.6 MB of live-row bytes, 42.7%, measured over 2 417 live rows).

`log` cannot simply be dropped from a list projection because five read-time derivations consume it.
A SQL-side derivation of those five signals was prototyped, proven equivalent, and REJECTED at
4.5-11.5 s of PostgreSQL CPU per full-board read: locating `[timing]` entries or the max timestamp
needs per-row jsonb expansion, and ANY per-row touch of `log` decompresses the whole column
(no-`log` baseline 0.2-0.35 s). What is NOT allowed here is therefore a read-side projection: the
functions below exist only to compute the columns ONCE, at backfill time. The steady-state writers are
`packages/core/src/task-store/task-log-projections.ts` (descriptors + every targeted log UPDATE).

`project.fusion_task_log_projections()` is a transliteration of that TypeScript module and is held
equal to it row-for-row by `packages/core/src/__tests__/postgres/task-log-projections.pg.test.ts`.
Change one, change the other, or the badge a card shows will depend on which path read it.
*/

ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS timing_total_ms double precision;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS log_recent jsonb;

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
The shared strict timestamp rule. `Date.parse` is implementation-defined, so neither implementation may
use it: only ISO-8601 with an explicit `Z`/`±HH:MM` offset parses, the calendar is validated (an
out-of-range date is unparseable, not rolled over), and the result is floor(microseconds / 1000).
Anything this returns NULL for is counted by the caller as unparseable, which is how the envelope
proves — or fails to prove — that it can answer a question.
*/
CREATE OR REPLACE FUNCTION project.fusion_task_log_ts_ms(p text)
RETURNS double precision
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  m     text[];
  v_y   int;
  v_mo  int;
  v_d   int;
  v_h   int;
  v_mi  int;
  v_s   int;
  v_dim int;
  v_off int;
  v_us  double precision;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(p, '^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$');
  IF m IS NULL THEN RETURN NULL; END IF;
  v_y := m[1]::int; v_mo := m[2]::int; v_d := m[3]::int;
  v_h := m[4]::int; v_mi := m[5]::int; v_s := m[6]::int;
  -- Year 0099 means 1900 to the JavaScript Date constructor and 99 to PostgreSQL, so both reject it.
  IF v_y < 1000 THEN RETURN NULL; END IF;
  IF v_mo < 1 OR v_mo > 12 THEN RETURN NULL; END IF;
  v_dim := CASE v_mo
             WHEN 2 THEN CASE WHEN (v_y % 4 = 0 AND v_y % 100 <> 0) OR v_y % 400 = 0 THEN 29 ELSE 28 END
             WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
             ELSE 31
           END;
  IF v_d < 1 OR v_d > v_dim THEN RETURN NULL; END IF;
  -- Leap seconds are rejected, not shifted: a one-second disagreement is worse than an unparseable entry.
  IF v_h > 23 OR v_mi > 59 OR v_s > 59 THEN RETURN NULL; END IF;
  IF m[8] = 'Z' THEN
    v_off := 0;
  ELSE
    IF substring(m[8] from 2 for 2)::int > 23 OR substring(m[8] from 5 for 2)::int > 59 THEN RETURN NULL; END IF;
    v_off := substring(m[8] from 2 for 2)::int * 60 + substring(m[8] from 5 for 2)::int;
    IF left(m[8], 1) = '-' THEN v_off := -v_off; END IF;
  END IF;
  -- Extra fractional digits truncate toward zero, matching the TypeScript side's microsecond floor.
  v_us := CASE WHEN m[7] IS NULL OR m[7] = '' THEN 0
               ELSE (rpad(left(m[7], 6), 6, '0'))::double precision END;
  -- `AT TIME ZONE 'UTC'` keeps the epoch independent of the session TimeZone; a bare extract would not.
  RETURN floor(extract(epoch FROM (make_timestamp(v_y, v_mo, v_d, v_h, v_mi, v_s) AT TIME ZONE 'UTC')) * 1000)
         - v_off * 60000
         + floor(v_us / 1000);
END
$fn$;

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
The stall-entry grammar. `matchesStallEntry` reads `In-review stall surfaced [<code>]: <reason>`, and
`position()` is 1-based where `indexOf()` is 0-based, so the guard is `<= 1` here and `<= 0` there.
*/
CREATE OR REPLACE FUNCTION project.fusion_task_stall_code(a text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_rest  text;
  v_close int;
BEGIN
  IF a IS NULL OR NOT starts_with(a, 'In-review stall surfaced [') THEN RETURN NULL; END IF;
  v_rest  := substring(a from length('In-review stall surfaced [') + 1);
  v_close := position(']' in v_rest);
  IF v_close <= 1 THEN RETURN NULL; END IF;
  RETURN substring(v_rest from 1 for v_close - 1);
END
$fn$;

CREATE OR REPLACE FUNCTION project.fusion_task_stall_reason(a text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_code text;
BEGIN
  v_code := project.fusion_task_stall_code(a);
  IF v_code IS NULL THEN RETURN NULL; END IF;
  RETURN substring(a from length('In-review stall surfaced [' || v_code || ']:') + 1);
END
$fn$;

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
The envelope, transliterated from `deriveTaskLogProjections`. Notes on the parts that must agree:
  * a non-object array element is SKIPPED (the TypeScript list is compacted first), which shifts the
    trailing-run walk away from raw array indices on purpose;
  * a jsonb-typed `string` log — one live row has one — derives the EMPTY envelope, because that is
    what `rowToTask` exposes to the readers;
  * the `[timing]` sum adds in log order (IEEE-754 addition is not associative, so order is part of
    the answer);
  * `strpos`/`starts_with` are used instead of LIKE so no character in a literal can act as a wildcard;
  * retained match timestamps are the newest `cap` by time, re-emitted in log-array order, because the
    detector's `firstMatchAt`/`lastMatchAt` are array-order values that reach the operator-visible reason.
*/
CREATE OR REPLACE FUNCTION project.fusion_task_log_projections(p_log jsonb)
RETURNS TABLE(timing_total_ms double precision, log_recent jsonb)
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_len        int := 0;
  v_i          int;
  v_e          jsonb;
  v_a          text;
  v_o          text;
  v_t          text;
  v_ts         double precision;
  v_timing     double precision := 0;
  v_num        double precision;
  v_match      text[];
  v_latest     text;
  v_latest_ms  double precision := '-infinity';
  v_surf       text;
  v_surf_ms    double precision := '-infinity';
  v_unparse    int := 0;
  v_re_ord     int[]  := '{}';
  v_re_ts      text[] := '{}';
  v_re_ms      double precision[] := '{}';
  v_in_ord     int[]  := '{}';
  v_in_ts      text[] := '{}';
  v_in_ms      double precision[] := '{}';
  v_re_json    jsonb;
  v_re_drop    double precision;
  v_in_json    jsonb;
  v_in_drop    double precision;
  v_tail_code  text;
  v_tail_first text;
  v_tail_reason text;
  v_tail_count int := 0;
  v_tail_at    text[] := '{}';
  v_code       text;
  v_ord        int := 0;
BEGIN
  IF p_log IS NULL OR jsonb_typeof(p_log) <> 'array' THEN
    RETURN QUERY SELECT 0::double precision, project.fusion_task_log_recent_empty();
    RETURN;
  END IF;

  v_len := jsonb_array_length(p_log);
  v_i := 0;
  WHILE v_i < v_len LOOP
    v_e := p_log -> v_i;
    IF v_e IS NULL OR jsonb_typeof(v_e) <> 'object' THEN
      v_i := v_i + 1;
      CONTINUE;
    END IF;
    v_a := CASE WHEN jsonb_typeof(v_e -> 'action')    = 'string' THEN v_e ->> 'action'    ELSE '' END;
    v_o := CASE WHEN jsonb_typeof(v_e -> 'outcome')   = 'string' THEN v_e ->> 'outcome'   ELSE '' END;
    v_t := CASE WHEN jsonb_typeof(v_e -> 'timestamp') = 'string' THEN v_e ->> 'timestamp' ELSE '' END;

    -- computeTimedExecutionMs, over the WHOLE log and never windowed.
    IF strpos(v_a, '[timing]') > 0 OR strpos(v_o, '[timing]') > 0 THEN
      v_match := regexp_match(v_a || E'\n' || v_o, '(\d+(?:\.\d+)?)ms\y', 'i');
      IF v_match IS NOT NULL THEN
        -- `isfinite()` is not portable across builds, and `Number.isFinite` is what the TypeScript side
        -- calls. A 400-digit run casts to infinity here and reads as Infinity there — both skip it.
        v_num := v_match[1]::double precision;
        IF v_num = v_num AND v_num <> 'infinity'::double precision AND v_num <> '-infinity'::double precision THEN
          v_timing := v_timing + v_num;
        END IF;
      END IF;
    END IF;

    v_ts := project.fusion_task_log_ts_ms(NULLIF(v_t, ''));
    IF v_ts IS NULL THEN
      v_unparse := v_unparse + 1;
      v_i := v_i + 1;
      CONTINUE;
    END IF;

    -- The two stalled-review heuristics are tested independently: one entry can match both.
    IF strpos(v_a, 'Auto-recovered: eligible in-review task re-enqueued for merge') > 0 THEN
      v_re_ord := v_re_ord || v_ord;
      v_re_ts  := v_re_ts  || v_t;
      v_re_ms  := v_re_ms  || v_ts;
    END IF;
    IF v_a  ~ $pat$Invalid transition: '[^']+' → '[^']+'$pat$
       OR v_o ~ $pat$Invalid transition: '[^']+' → '[^']+'$pat$ THEN
      v_in_ord := v_in_ord || v_ord;
      v_in_ts  := v_in_ts  || v_t;
      v_in_ms  := v_in_ms  || v_ts;
    END IF;

    IF v_ts > v_latest_ms THEN
      v_latest    := v_t;
      v_latest_ms := v_ts;
    END IF;
    IF starts_with(v_a, 'In-review stall surfaced [') AND v_ts > v_surf_ms THEN
      v_surf    := v_t;
      v_surf_ms := v_ts;
    END IF;

    v_ord := v_ord + 1;
    v_i   := v_i + 1;
  END LOOP;

  -- `ms DESC, ord ASC` is the same total order the TypeScript side sorts by, because two implementations
  -- that disagreed about which of two equal-timestamp entries survived would make the equivalence proof
  -- flake on data that has nothing wrong with it.
  SELECT jsonb_agg(x.t ORDER BY x.ord),
         (SELECT ms FROM unnest(v_re_ord, v_re_ms) AS u(ord, ms) ORDER BY ms DESC, ord ASC OFFSET 16 LIMIT 1)
    INTO v_re_json, v_re_drop
    FROM (SELECT ord, t, ms FROM unnest(v_re_ord, v_re_ts, v_re_ms) AS u(ord, t, ms)
           ORDER BY ms DESC, ord ASC LIMIT 16) x;
  SELECT jsonb_agg(x.t ORDER BY x.ord),
         (SELECT ms FROM unnest(v_in_ord, v_in_ms) AS u(ord, ms) ORDER BY ms DESC, ord ASC OFFSET 16 LIMIT 1)
    INTO v_in_json, v_in_drop
    FROM (SELECT ord, t, ms FROM unnest(v_in_ord, v_in_ts, v_in_ms) AS u(ord, t, ms)
           ORDER BY ms DESC, ord ASC LIMIT 16) x;

  -- The trailing identical-stall run, walked backwards from the end exactly as the reader does.
  v_tail_first := NULL;
  v_i := v_len - 1;
  WHILE v_i >= 0 LOOP
    v_e := p_log -> v_i;
    IF v_e IS NULL OR jsonb_typeof(v_e) <> 'object' THEN
      v_i := v_i - 1;
      CONTINUE;
    END IF;
    v_a := CASE WHEN jsonb_typeof(v_e -> 'action')    = 'string' THEN v_e ->> 'action'    ELSE '' END;
    v_t := CASE WHEN jsonb_typeof(v_e -> 'timestamp') = 'string' THEN v_e ->> 'timestamp' ELSE '' END;
    v_tail_first := v_a;
    EXIT;
  END LOOP;
  v_tail_code := project.fusion_task_stall_code(v_tail_first);
  IF v_tail_code IS NOT NULL THEN
    -- `btrim(x)` alone trims spaces only; the JavaScript side calls `.trim()`, so the ASCII set is explicit.
  v_tail_reason := btrim(COALESCE(project.fusion_task_stall_reason(v_tail_first), ''), E' \t\n\r\f\v');
    v_i := v_len - 1;
    WHILE v_i >= 0 LOOP
      v_e := p_log -> v_i;
      IF v_e IS NULL OR jsonb_typeof(v_e) <> 'object' THEN
        v_i := v_i - 1;
        CONTINUE;
      END IF;
      v_a := CASE WHEN jsonb_typeof(v_e -> 'action')    = 'string' THEN v_e ->> 'action'    ELSE '' END;
      v_t := CASE WHEN jsonb_typeof(v_e -> 'timestamp') = 'string' THEN v_e ->> 'timestamp' ELSE '' END;
      v_code := project.fusion_task_stall_code(v_a);
      IF v_code IS DISTINCT FROM v_tail_code THEN EXIT; END IF;
      IF btrim(COALESCE(project.fusion_task_stall_reason(v_a), ''), E' \t\n\r\f\v') <> v_tail_reason THEN EXIT; END IF;
      v_tail_count := v_tail_count + 1;
      IF coalesce(array_length(v_tail_at, 1), 0) < 16 THEN
        v_tail_at := v_tail_at || v_t;
      END IF;
      v_i := v_i - 1;
    END LOOP;
  END IF;

  RETURN QUERY SELECT
    v_timing,
    jsonb_build_object(
      'v', 1,
      'latestAt', v_latest,
      'stallSurfacedAt', v_surf,
      'unparseableCount', v_unparse,
      'reenqueueAt', coalesce(v_re_json, '[]'::jsonb),
      'reenqueueNewestDroppedAt', v_re_drop,
      'invalidTransitionAt', coalesce(v_in_json, '[]'::jsonb),
      'invalidTransitionNewestDroppedAt', v_in_drop,
      'tailCode', v_tail_code,
      'tailReason', CASE WHEN length(v_tail_reason) > 200 THEN left(v_tail_reason, 200) ELSE v_tail_reason END,
      'tailReasonTruncated', coalesce(length(v_tail_reason) > 200, false),
      'tailCount', v_tail_count,
      'tailAt', to_jsonb(v_tail_at),
      'tailTruncated', v_tail_count > 16
    );
END
$fn$;

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
The empty envelope, shared by the NULL/non-array branch and by the TypeScript `emptyTaskLogRecent()`.
*/
CREATE OR REPLACE FUNCTION project.fusion_task_log_recent_empty()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT jsonb_build_object(
    'v', 1,
    'latestAt', NULL,
    'stallSurfacedAt', NULL,
    'unparseableCount', 0,
    'reenqueueAt', '[]'::jsonb,
    'reenqueueNewestDroppedAt', NULL,
    'invalidTransitionAt', '[]'::jsonb,
    'invalidTransitionNewestDroppedAt', NULL,
    'tailCode', NULL,
    'tailReason', NULL,
    'tailReasonTruncated', false,
    'tailCount', 0,
    'tailAt', '[]'::jsonb,
    'tailTruncated', false
  )
$fn$;

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
ONE-TIME BACKFILL. A one-time seconds-cost is acceptable where a per-read cost was not — that is the
whole asymmetry this design rests on. Batched so an interrupted migration resumes from the rows whose
columns are still NULL, and it skips exactly the rows the live write seam refuses: soft-deleted rows
and the historical sentinel lane (`log` is read-only there, so a derived column must not be authored
for them — `task-log-write-refusal.ts` is the authority, and 'archived' is its SQL-parity sentinel).
*/
/*
FNXC:TaskLogProjections 2026-10-10-19:55 (RUFU-615):
The backfill runs as dynamic SQL behind a column-existence guard. The schema-applier upgrade fixtures
hand-build a partial historical `tasks` table that predates `log`, and a migration that reads a column
the upgrading database does not have must skip rather than fail the upgrade; `plpgsql` parses a
statement before it runs, so the only way to skip over a missing column is `EXECUTE`.
*/
DO $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'log'
  ) THEN
    RETURN;
  END IF;

  EXECUTE $q$DO $inner$
    DECLARE
      v_batch int := 500;
      v_found int;
    BEGIN
      LOOP
        WITH picked AS (
          -- `log` is carried out of the CTE because the LATERAL derivation below reads it; a derived column
          -- cannot be computed from a row the statement never selected.
          SELECT id, project_id, log
            FROM project.tasks
           WHERE timing_total_ms IS NULL
             AND log_recent IS NULL
             AND deleted_at IS NULL
             AND "column" IS DISTINCT FROM 'archived'
           ORDER BY project_id, id
           LIMIT v_batch
           FOR UPDATE SKIP LOCKED
        ), computed AS (
          SELECT p.id, p.project_id, f.timing_total_ms, f.log_recent
            FROM picked p
            -- A jsonb-typed `string` log is passed through untouched: the function's own
            -- `jsonb_typeof(p_log) <> 'array'` branch is what turns it into the empty envelope, which is the
            -- same answer `rowToTask` gives the readers. Neither implementation repairs the row.
            CROSS JOIN LATERAL project.fusion_task_log_projections(p.log) f
        )
        UPDATE project.tasks t
           SET timing_total_ms = c.timing_total_ms,
               log_recent      = c.log_recent
          FROM computed c
         WHERE t.id = c.id AND t.project_id = c.project_id;
        GET DIAGNOSTICS v_found = ROW_COUNT;
        EXIT WHEN v_found = 0;
      END LOOP;
    END
  $inner$;$q$;
END
$fn$;
