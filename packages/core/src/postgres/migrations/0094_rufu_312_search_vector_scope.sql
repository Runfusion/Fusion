/*
FNXC:TaskSearchVectorScope 2026-11-01-22:30 (RUFU-312):
The task search vector stops indexing text that the search path cannot use and the write path pays for.

Measured on the operator's live database 2026-11-01: `project.tasks.search_vector` was generated from
`id || title || description || comments::text`. Two of those four sources were pure cost:

1. `id` — a UUID deparsed into hex/numeric lexemes that no word-boundary query asks for, while every card
   contributes them to the GIN. Task-id lookup is served by the literal substring arm of
   `buildTaskSearchPredicate`, which matches the raw `id` column, so the lexemes bought nothing.
2. `comments::text` — the expensive one. `comments` is a jsonb document that review and comment writes append
   to, and PostgreSQL recomputes a stored-generated column whenever a source column is touched, so EVERY
   comment write re-deparsed that card's whole comment history into a tsvector and re-keyed its GIN entries,
   on the hottest write path a card has. Comment text stays findable because `buildTaskSearchPredicate` ORs an
   ILIKE arm over the raw `comments::text`: row membership is unchanged, only lexical ranking over comment
   bodies is lost, and neither search surface ranks by it (the board page orders by a createdAt/id keyset,
   `searchTasks` ranks `ts_rank` over title/description text).

The same inspection found a second, quieter defect: a deployed board whose generated column was built with the
`english` configuration while `FTS_TS_CONFIG` (task-store/async/async-search.ts) queries `simple`. The two
dictionaries differ by one stemming rule, so the mismatch does not error — it matches nothing. This migration
therefore normalizes the column to the canonical `simple` expression whatever it currently is, and
`__tests__/postgres/task-search-vector-dictionary.pg.test.ts` pins the pairing on both sides.

FNXC:TaskSearchVectorScope 2026-11-01-20:30 (RUFU-312 step 6): the ARCHIVE mirror joins the same contract.
`archive.archived_tasks.search_vector` carried the identical four-source expression, so leaving it alone would
have shipped two task tables whose vectors index different text under the same query path — the archive arm of
the board answers a word the live arm cannot match, and `searchArchivedTasks` now shares
`buildArchiveSearchPredicate`, whose literal arm is what keeps id and comment text findable once the vector
drops them. The write-cost argument does not apply there (an archive row is an append-only snapshot no comment
edit touches), but the GIN junk and the dictionary-pairing argument both do. One canonical expression is
therefore enforced over BOTH tables by the loop below — a second copy of this block for the archive is a second
block that can drift, so the tables are data in a `VALUES` list and the expression exists once.

Why DROP + re-ADD rather than an in-place expression change: PostgreSQL offers no `ALTER COLUMN ... SET
EXPRESSION` for generated columns (the grammar rejects it on the 16.x server this project runs), so the only
supported rewrite is to drop the column and add it back — and dropping a column drops the indexes on it, which
is why the existing index definitions are captured and replayed below instead of being hardcoded, so a database
whose index carries a different name or access method is repaired rather than renamed.

OPERATIONAL NOTE: PostgreSQL must recompute a stored-generated column when its expression changes, so this
statement rewrites every row of `project.tasks` once, every row of `archive.archived_tasks` once, and rebuilds
the GIN entries for each. The guard below skips the rewrite entirely on a table that already carries the
canonical expression, which includes every table that ran this migration before. Heap space the old expression
produced is NOT reclaimed here: `VACUUM FULL` / `pg_repack` take an exclusive lock and stay operator-decided
maintenance (docs/storage.md), never an automatic action.
*/

DO $$
DECLARE
  target record;
  rel text;
  expr text;
  idx_def text;
  idx_defs text[];
  has_sources boolean;
BEGIN
  /*
  Both tables that carry a task search vector, with the index name a table that never had one still needs.
  Carrying them as rows is what keeps the canonical expression below single-sourced.
  */
  FOR target IN
    SELECT * FROM (VALUES
      ('project', 'tasks', 'idxTasksSearchVector'),
      ('archive', 'archived_tasks', 'idxArchivedTasksSearchVector')
    ) AS v(nsp, tbl, fallback_idx)
  LOOP
    rel := format('%I.%I', target.nsp, target.tbl);

    /*
    A database without this table has no search vector to repair. Partial schemas exist mid-bootstrap and in
    this project's own absent-relation drift fixtures, and any statement naming the table would turn
    `ensureSchemaApplied` into a boot failure for a shape that is simply not migrated yet.
    */
    IF to_regclass(rel) IS NULL THEN
      CONTINUE;
    END IF;

    /*
    Both write paths below name `title` and `description`, so both need them to exist. Partial shapes do occur —
    this project's own automation-isolation and drift fixtures create a stub table to test ledger upgrades, and a
    generated column cannot be defined over columns a fixture never made. Absent sources are not a search vector
    needing repair; they are a table that is not the task table yet.
    */
    SELECT count(*) = 2
      INTO has_sources
      FROM pg_attribute
     WHERE attrelid = rel::regclass
       AND attname IN ('title', 'description')
       AND NOT attisdropped;

    IF NOT has_sources THEN
      CONTINUE;
    END IF;

    /*
    The catalog read is pg_catalog, not information_schema: `information_schema.generated_columns` does not exist
    on the PostgreSQL 16 build this project's CI and the operator's host run, and a probe that raises inside
    `ensureSchemaApplied` fails every boot and every pg test. `attgenerated = 's'` is the stored-generated flag
    and `pg_get_expr` deparses the expression that view would have shown.
    */
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO expr
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = rel::regclass
       AND a.attname = 'search_vector'
       AND a.attgenerated = 's';

    IF expr IS NULL THEN
      /*
      Either no such column, or a plain (non-generated) one — a shape `ADD COLUMN` cannot be applied over, so it
      is dropped first. Creating the column plus the index here is what a reader needs either way: every search
      path assumes a `search_vector` and a GIN over it exist.
      */
      IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = rel::regclass
           AND attname = 'search_vector'
           AND NOT attisdropped
      ) THEN
        EXECUTE format('ALTER TABLE %s DROP COLUMN search_vector', rel);
      END IF;

      EXECUTE format($ddl$ALTER TABLE %s ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
      ) STORED$ddl$, rel);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s USING gin (search_vector)', target.fallback_idx, rel);
      CONTINUE;
    END IF;

    /*
    The shapes worth rewriting are exactly two: a column that still indexes comment bodies or the id, and a
    column built with a dictionary other than the one the query path binds. This predicate is deliberately the
    same test `schema-applier.ts` uses to decide whether to re-run this file, so the two cannot disagree about
    what "canonical" means — a disagreement would rewrite the tables on every boot. Comparing against a literal
    deparse of the target expression was the first draft and is not safe: PostgreSQL's deparse text (casts,
    parentheses, casing) is not ours to promise.
    */
    IF NOT (position('comments' in expr) > 0
            OR position('COALESCE(id' in expr) > 0
            OR position('coalesce(id' in expr) > 0
            OR expr ILIKE '%english%') THEN
      CONTINUE;
    END IF;

    /*
    Captured before the drop, as executable definitions: `pg_get_indexdef` emits a complete `CREATE INDEX`
    statement, so replaying it restores the same name, access method and storage parameters. An expression index
    or a differently-named index on this column therefore survives the repair.
    */
    SELECT array_agg(pg_get_indexdef(c.oid))
      INTO idx_defs
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = rel::regclass
       AND a.attname = 'search_vector';

    EXECUTE format('ALTER TABLE %s DROP COLUMN search_vector', rel);

    EXECUTE format($ddl$ALTER TABLE %s ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED$ddl$, rel);

    IF idx_defs IS NULL OR cardinality(idx_defs) = 0 THEN
      -- Nothing indexed this column before: create the index every reader assumes exists.
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s USING gin (search_vector)', target.fallback_idx, rel);
    ELSE
      FOREACH idx_def IN ARRAY idx_defs LOOP
        EXECUTE idx_def;
      END LOOP;
    END IF;
  END LOOP;
END
$$;
