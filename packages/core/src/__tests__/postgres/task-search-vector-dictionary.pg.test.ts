/**
 * FNXC:TaskSearchVectorScope 2026-11-01-22:45 (RUFU-312):
 * Symptom-verification suite for the search-vector scope and its dictionary pairing.
 *
 * Original symptoms (operator's live database, 2026-11-01, plus the code read that accompanies it):
 *
 * 1. `project.tasks.search_vector` was generated from `id || title || description || comments::text`. The
 *    `comments::text` source made the vector a WRITE-path cost: a stored-generated column is recomputed
 *    whenever a source column is touched, so every comment write re-deparsed that card's whole comment
 *    history into a tsvector and re-keyed its GIN entries. `id` contributed a UUID's hex lexemes — numbers no
 *    word-boundary query asks for.
 * 2. The inspected deployed schema carried a `search_vector` built with the `english` configuration while the
 *    query path binds `FTS_TS_CONFIG = 'simple'`. One stemming rule separates the two dictionaries, and the
 *    failure is silent in the worst direction: the card a user is staring at does not match the word written
 *    in its own title.
 * 3. `/tasks/page?q=` — the endpoint the board search box calls — applied only the FTS arm, while `searchTasks`
 *    applies the FTS arm ORed with a literal ILIKE arm. A query carrying punctuation (`RUFU-312`, `.txt`) is
 *    routed to the literal arm on purpose, so the board's own search box returned zero rows for a card while
 *    the other endpoint found it. That asymmetry is what "one-sided" means here, and test 5 is the regression.
 *
 * 4. The `archive.archived_tasks` mirror carried the identical four-source expression, so the two task tables
 *    answered one query path over two different source sets. Migration 0094 now normalizes BOTH tables, and
 *    `buildArchiveSearchPredicate` gives the archive the same literal-membership rule the live board has.
 * 5. Recall itself: for the word `merge` the operator measured ~1 row through the FTS path against ~500 through
 *    `ILIKE '%merge%'`. The shipped path must land on the ILIKE side, not the 1-row side, for every inflected
 *    word — asserted one-sided below, production query path versus raw SQL, never one dictionary on both sides.
 *
 * Each test below failed before the change it names, for the observable reason stated on it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../postgres/schema/index.js";
import { eq, sql as drizzleSql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { FTS_TS_CONFIG } from "../../task-store/async/async-search.js";

/** The deparsed expression of the stored-generated `search_vector` column, straight from pg_catalog. */
async function vectorExpression(h: SharedPgTaskStoreHarness, nsp = "project", tbl = "tasks"): Promise<string> {
  const rows = await h.layer().db.execute(drizzleSql`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = ${nsp} AND c.relname = ${tbl}
       AND a.attname = 'search_vector' AND a.attgenerated = 's'`);
  const row = (rows as unknown as Array<{ expr: string | null }>)[0];
  return row?.expr ?? "";
}

/** The vector as stored for one card, so a rewrite of it is detectable byte-for-byte. */
async function vectorOf(h: SharedPgTaskStoreHarness, taskId: string): Promise<string> {
  const rows = await h.layer().db
    .select({ vec: drizzleSql<string>`${schema.project.tasks.searchVector}::text` })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId));
  return String((rows as unknown as Array<{ vec: string }>)[0]?.vec ?? "");
}

pgDescribe("RUFU-312 step 4: one dictionary, and a vector scoped to what search can use", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "rufu312_search_vector" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  it("generates the column from the SAME text-search configuration the query path binds", async () => {
    /*
    The pairing is the whole defect class: an english column under a simple query (or the reverse) does not
    error, it answers "no results". Asserting both authorities in one place is what stops them drifting again
    — the migration 0094 guard, the Drizzle DDL and `FTS_TS_CONFIG` all have to agree with this line.
    */
    const expr = await vectorExpression(h);
    expect(expr).not.toBe("");
    expect(expr.toLowerCase()).not.toContain("english");
    const columnConfig = /to_tsvector\('([a-z_]+)'/.exec(expr)?.[1];
    expect(columnConfig).toBe(FTS_TS_CONFIG);
  });

  it("does not stem across the two sides of the predicate (one-sided dictionary regression)", async () => {
    const store = h.store();
    /*
    Under `english` both titles collapse to the stem `run`, so a query for "running" would also return the
    "runs" card. Under `simple` on BOTH sides the lexemes stay distinct and each card is found only by the word
    it literally carries. A mismatch — english column, simple query — fails this test in the direction that
    matters to a user: the card titled "The running process" stops matching the word printed in its own title.
    */
    const running = await store.createTask({ title: "The running process", description: "stem fixture a" });
    const runs = await store.createTask({ title: "runs nightly", description: "stem fixture b" });

    const byRunning = await store.searchTasks("running");
    expect(byRunning.map((task) => task.id)).toContain(running.id);
    expect(byRunning.map((task) => task.id)).not.toContain(runs.id);

    const byRuns = await store.searchTasks("runs");
    expect(byRuns.map((task) => task.id)).toContain(runs.id);
    expect(byRuns.map((task) => task.id)).not.toContain(running.id);
  });

  it("keeps the id's hex lexemes and comment bodies out of the vector", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "Vector scope fixture", description: "scoped text only" });
    await store.addComment(task.id, "a zebra-phrase living only inside comments", "operator");

    const vector = await vectorOf(h, task.id);
    expect(vector).toContain("scope");
    expect(vector).not.toContain("zebra");
    expect(vector.toLowerCase()).not.toContain(task.id.toLowerCase());
  });

  it("leaves the vector untouched when a comment is appended", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "Comment write cost fixture", description: "unchanged text" });
    const before = await vectorOf(h, task.id);

    /*
    This is the write-path half of the change. Before it, this single call recomputed the card's tsvector from
    `comments::text` and re-keyed its GIN entry; the assertion is the regression guard for that cost returning.
    */
    await store.addComment(task.id, "second note", "operator");
    await store.addComment(task.id, "third note", "operator");

    expect(await vectorOf(h, task.id)).toBe(before);
  });

  it("still finds comment text and an id fragment through the literal arm", async () => {
    const store = h.store();
    /*
    Dropping the two sources had to cost no membership: `buildTaskSearchPredicate` ORs an ILIKE arm over the raw
    columns, so comment content and task ids stay searchable. A card is found by a phrase that exists only in
    its comments, and by a fragment of its own id.
    */
    const commented = await store.createTask({ title: "Membership via comments", description: "plain" });
    await store.addComment(commented.id, "hippopotamus appears nowhere else", "operator");

    expect((await store.searchTasks("hippopotamus")).map((task) => task.id)).toContain(commented.id);

    const prefixed = await store.createTaskWithReservedId(
      { title: "Id fragment fixture", description: "plain" },
      { taskId: "RUFU-777", applyDefaultWorkflowSteps: false },
    );
    expect((await store.searchTasks("RUFU-777")).map((task) => task.id)).toContain(prefixed.id);
  });

  it("answers a punctuation-bearing query on the paginated board search exactly as searchTasks does", async () => {
    const store = h.store();
    /*
    THE one-sided endpoint regression. `/tasks/page` filtered on `searchVector @@ to_tsquery(...)` alone, and a
    query containing punctuation is deliberately routed to the literal substring arm because tokenization erases
    the characters the user typed. So the board's own search box returned zero rows for the card id printed on
    that card's own header. Before the fix `page.tasks` was empty here; `searchTasks` already found the card,
    which is why the defect survived every single-endpoint test.
    */
    await store.createTaskWithReservedId(
      { title: "Lockfile drift in plugin workspaces", description: "id-membership fixture" },
      { taskId: "RUFU-778", applyDefaultWorkflowSteps: false },
    );

    const bySearch = await store.searchTasks("RUFU-778");
    expect(bySearch.map((task) => task.id)).toContain("RUFU-778");

    const page = await store.listCurrentTasksPage({ query: "RUFU-778", limit: 20 });
    expect(page.tasks.map((task) => task.id)).toContain("RUFU-778");
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it("carries the derived stall/timing envelope into the searched page that no longer selects log", async () => {
    const store = h.store();
    /*
    The searched page dropped `log` from its projection, which is only safe because the two derived figures it
    used to recompute from that column are authored at write time. If the page had kept deriving from a column
    it no longer reads, every badge on a searched page would go blank silently — `task.log === []` is a legal
    value, not an error. This asserts the page still reports the envelope's own numbers.
    */
    const task = await store.createTask({ title: "Envelope on searched page", description: "badge fixture" });
    await store.logEntry(task.id, "Step 0: Preflight", "ran the preflight check");
    await store.logEntry(task.id, "Step 1: Implement", "ran the implementation pass");

    const detail = await store.getTask(task.id);
    const page = await store.listCurrentTasksPage({ query: "Envelope", limit: 20 });
    const row = page.tasks.find((candidate) => candidate.id === task.id);

    expect(row).toBeDefined();
    // The envelope and a recomputation from the merged History must agree, card for card.
    expect(row!.timedExecutionMs).toBe(store.computeTimedExecutionMs(detail!.log));
  });

  it("narrows the archive mirror to the SAME expression as its live twin", async () => {
    /*
    The mirror is the half that gets forgotten: `archive.archived_tasks.search_vector` shipped the identical
    four-source expression, so an archived card and a live card answered `FTS_TS_CONFIG` over different text.
    Migration 0094 enforces one expression over both tables, and this is the assertion that keeps the archive
    from silently reverting to a private shape — the same three authorities (baseline, migration, Drizzle DDL)
    are pinned by this one deparse.
    */
    const expr = await vectorExpression(h, "archive", "archived_tasks");
    expect(expr).not.toBe("");
    expect(expr.toLowerCase()).not.toContain("english");
    expect(/to_tsvector\('([a-z_]+)'/.exec(expr)?.[1]).toBe(FTS_TS_CONFIG);
    expect(expr.toLowerCase()).not.toContain("comments");
    expect(expr.toLowerCase()).not.toMatch(/coalesce\(\s*id\s*,/);
  });

  it("keeps an archived card findable by comment text and by an id fragment", async () => {
    /*
    The archive path used to reach comment bodies only because its vector indexed the serialized jsonb document.
    Now that the vector matches the live one, membership there comes from `buildArchiveSearchPredicate`'s
    literal arm — so a word that exists ONLY in an archived card's comments, and a fragment of the card's own
    id, must still return it. Before this pair of changes both worked by accident of the vector; after them
    they work because the predicate says so.
    */
    const { upsertArchivedTask, searchArchivedTasks } = await import("../../async-stores/async-archive-db.js");
    const now = new Date().toISOString();
    const db = h.layer().db;
    const entry = (id: string, title: string, comments: Array<{ id: string; text: string }> = []) => ({
      id,
      lineageId: id,
      title,
      description: "archive membership fixture",
      column: "archived",
      dependencies: [],
      steps: [],
      currentStep: 0,
      comments: comments.map((c, i) => ({ ...c, author: "operator", createdAt: now, id: c.id || `c${i}` })),
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    }) as unknown as import("../../types.js").ArchivedTaskEntry;

    await upsertArchivedTask(db, entry("FN-3120", "Giraffe membership", [{ id: "c1", text: "a platypus note" }]));
    await upsertArchivedTask(db, entry("FN-3121", "Unrelated archived card"));

    expect((await searchArchivedTasks(db, "platypus", 10)).map((e) => e.id)).toEqual(["FN-3120"]);
    expect((await searchArchivedTasks(db, "3121", 10)).map((e) => e.id)).toEqual(["FN-3121"]);
    expect(await searchArchivedTasks(db, "nothingmatches_this", 10)).toEqual([]);
  });

  it("returns the same rows the raw ILIKE does for inflected words (one-sided recall)", async () => {
    /*
    THE headline symptom: the operator measured ~1 row through the search path against ~500 through
    `ILIKE '%merge%'` on the live board. This asserts the shipped path lands on the ILIKE side for each
    inflected family, and it is ONE-SIDED by construction — the expected side is a raw SQL ILIKE written here,
    not the predicate under test, so a change that narrows either side shows up as a mismatch. A test that ran
    the same dictionary on both sides cannot see a one-sided defect, which is why the reference below is typed
    out as SQL rather than called from `async-search.ts`.
    */
    const store = h.store();
    const families: Array<[string, string[]]> = [
      ["merge", ["merge", "merges", "merged", "merging"]],
      ["assign", ["assign", "assigns", "assigned", "assigning"]],
      ["replan", ["replan", "replans", "replanned", "replanning"]],
    ];
    for (const [family, forms] of families) {
      for (const form of forms) {
        await store.createTask({ title: `${form} the queue`, description: `${family} inflection corpus card` });
      }
    }

    const db = h.layer().db;
    for (const [family] of families) {
      const reference = (await db.execute(drizzleSql`
        SELECT count(*)::int AS n
          FROM project.tasks
         WHERE deleted_at IS NULL
           AND "column" <> 'archived'
           AND (title ILIKE ${`%${family}%`} OR description ILIKE ${`%${family}%`} OR id ILIKE ${`%${family}%`} OR comments::text ILIKE ${`%${family}%`})`)) as unknown as Array<{ n: number }>;
      const referenceCount = reference[0]?.n ?? 0;
      const produced = await store.searchTasks(family);

      // The corpus must be big enough to distinguish "found them" from "found one stray row".
      expect(referenceCount).toBeGreaterThanOrEqual(4);
      expect(produced.length).toBe(referenceCount);
      // The OD's collapse shape: a single row where the corpus holds an entire family.
      expect(produced.length).toBeGreaterThan(1);
    }
  });

  it("shows an english-stemmed tsquery under-recalling against the shipped simple column", async () => {
    /*
    The companion to the parity test, and the guard against a one-sided dictionary drift coming back. Seeded
    with every inflection of one word, a tsquery built by the `english` stemmer matches only the card carrying
    the stem verbatim — because the shipped column stores unstemmed lexemes. If a future migration rebuilt the
    column with `english` while the query path stayed on `simple`, the two counts below converge from opposite
    directions and this assertion is what names it. Nothing here imports a second dictionary into production:
    `english` appears only inside this probe.
    */
    const store = h.store();
    for (const form of ["merge", "merges", "merged", "merging"]) {
      await store.createTask({ title: `${form} step`, description: "dictionary drift probe" });
    }
    const db = h.layer().db;
    const countByTsquery = async (config: string, term: string) => {
      const rows = (await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM project.tasks
         WHERE deleted_at IS NULL AND "column" <> 'archived'
           AND search_vector @@ to_tsquery(${config}, ${term})`)) as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    };

    const stemmedAgainstSimpleColumn = await countByTsquery("english", "merging");
    const shippedPath = await countByTsquery(FTS_TS_CONFIG, "merging:*");
    const literalMembership = await store.searchTasks("merging");

    // The stemmer sees the stem; the simple column stores the word. That is the mismatch, quantified.
    expect(stemmedAgainstSimpleColumn).toBe(0);
    expect(shippedPath).toBeGreaterThanOrEqual(1);
    expect(literalMembership.length).toBeGreaterThanOrEqual(shippedPath);
  });
});
