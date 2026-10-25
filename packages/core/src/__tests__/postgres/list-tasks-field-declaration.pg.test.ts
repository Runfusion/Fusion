/**
 * FNXC:ListReadFieldDeclaration 2026-10-25-23:39 (RUFU-627):
 * A board read parses ~240 KB of heap per card against ~30 KB of stored row, and 1.327 GiB of the
 * production process's still-live samples sat in this path (`FNXC:MemoryDiagnosis` in
 * `task-store/reads.ts`). Most of what it paid for was text no consumer renders, so a caller may now
 * declare the wide fields it reads. These tests pin the four things that could make that mechanism a
 * lie:
 *
 *   1. IT IS COLUMN-LEVEL. The claim must be about the SQL that leaves the process. A projection that
 *      selected everything and deleted keys client-side would pass every row-shape test in this repo
 *      and save nothing, because the transfer and the jsonb decode are the bill — and for `log` the
 *      stored bytes are TOAST-compressed, so the ONLY place its cost can be avoided is the SELECT.
 *   2. ABSENT MEANS TODAY. An undeclared read sends the pre-existing projection object, by reference.
 *   3. DECLARATIONS DO NOT COLLIDE. Two overlapping reads with different declared sets must not share
 *      one fetch, and the same set spelled differently must. The same rule already guards `derive`,
 *      `includeDeleted`, and (after this file's third leg) `slim` / `compactBoardFeed` / `excludeLog`,
 *      which the in-flight map inherited from the memo's key set without needing it.
 *   4. A DECLARATION ALSO SUPPRESSES ENRICHMENT. `slim` re-parses PROMPT.md for every card with empty
 *      persisted `steps`; doing that for a field the caller said it does not read trades a dropped
 *      column for one file read per card.
 */
import { afterEach, beforeEach, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { listReadShapeKey } from "../../task-store/reads.js";
import {
  readLiveTaskRows,
  resolveLiveTaskRowProjection,
  normalizeTaskListReadFields,
  TASK_READ_PROJECTION,
  TASK_SLIM_PROJECTION,
} from "../../task-store/async/async-persistence.js";
import * as schema from "../../postgres/schema/index.js";
import { resetReadAttributionForTests, snapshotReadAttribution } from "../../task-store/read-attribution.js";

const pgTest = pgDescribe;

/** Underlying list reads actually performed, as the production attribution seam counts them. */
function listReadCalls(): number {
  return snapshotReadAttribution().listTasks.calls;
}

pgTest("listTasks declared field sets (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_field_declaration",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    resetReadAttributionForTests();
  });
  afterEach(async () => {
    resetReadAttributionForTests();
    await h.afterEach();
  });

  /**
   * One card whose heavy columns are all populated, plus a PROMPT.md with authored step headings so a
   * steps-from-PROMPT.md sync has something to resolve (leg 4 needs a parse that COULD happen).
   */
  async function seedHeavyCard(taskId: string, logEntries = 400): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `RUFU-627 field-declaration probe ${taskId}`, column: "in-progress" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    const timestamp = new Date().toISOString();
    await store.updateTask(taskId, {
      summary: "a summary long enough to matter for the compaction arithmetic",
      log: Array.from({ length: logEntries }, (_, i) => ({
        timestamp,
        action: `[timing] step ${i} finished in 12ms`,
        outcome: "Implement",
      })) as never,
      workflowStepResults: [{
        id: "step-1", stepIndex: 0, stepName: "Implement", status: "approved", verdict: "APPROVE",
        output: "a reviewer body of real length ".repeat(40),
      }] as never,
    });
    const dir = store.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PROMPT.md"),
      `# ${taskId}\n\n## Original Description\n\nProbe card.\n\n### Step 1: Read the probe\n\nBody.\n\n### Step 2: Write the answer\n\nBody.\n`,
      "utf-8",
    );
  }

  it("the two shapes differ in the columns the SQL selects", async () => {
    await seedHeavyCard("RUFU-6301");
    const layer = h.layer();
    const tasksTable = schema.project.tasks;

    const wideSql = layer.db.select(resolveLiveTaskRowProjection(undefined)).from(tasksTable).toSQL().sql;
    const declaredSql = layer.db
      .select(resolveLiveTaskRowProjection({ fields: ["description"] }))
      .from(tasksTable)
      .toSQL().sql;

    // Drizzle quotes every identifier, so `"log"` cannot be matched by `"log_recent"` — the quoted form
    // is what makes this a column claim rather than a substring accident (the same trick RUFU-615 used).
    expect(wideSql).toContain('"description"');
    expect(declaredSql).toContain('"description"');
    for (const column of ['"log"', '"summary"', '"steps"', '"attachments"', '"workflow_step_results"', '"source_metadata"']) {
      expect(wideSql, `the undeclared read stopped selecting ${column}`).toContain(column);
      expect(declaredSql, `the declared read still selects ${column}`).not.toContain(column);
    }
    // Narrow columns are not declarable and must survive the narrowest declaration: the derived
    // log-substitute figures and the queue order both live there.
    for (const column of ['"timing_total_ms"', '"log_recent"', '"queue_boost"', '"column"', '"dependencies"']) {
      expect(declaredSql).toContain(column);
    }

    /*
    The reader must actually USE the projection this test rendered — a locally-rendered SQL string proves
    nothing on its own. `readLiveTaskRows` returns rows keyed by exactly the selected columns, so the
    returned key set IS the executed column set; comparing it to the rendered projection closes the loop.
    */
    const [wideRow] = await readLiveTaskRows(layer, {});
    const [declaredRow] = await readLiveTaskRows(layer, { fields: ["description"] });
    expect(Object.keys(declaredRow!).sort()).toEqual(
      Object.keys(resolveLiveTaskRowProjection({ fields: ["description"] })).sort(),
    );
    expect(Object.keys(wideRow!).sort()).toEqual(Object.keys(TASK_READ_PROJECTION).sort());

    /*
    TOAST is why this leg exists. `log` and `workflow_step_results` are jsonb whose large values are
    stored out of line and COMPRESSED (`pg_column_size` reports the stored size), while the client
    receives and parses the uncompressed text (`octet_length(...::text)`). So the stored figure is the
    floor and the decoded figure is what the read path pays — and a client-side strip would still pay
    all of it. The only place either cost can be avoided is the SELECT.
    */
    const [sizes] = await h.adminSql()<Array<{ log_bytes: number; log_raw_bytes: number; wfr_raw_bytes: number }>>`
      select pg_column_size(log) as log_bytes,
             octet_length(log::text) as log_raw_bytes,
             octet_length(workflow_step_results::text) as wfr_raw_bytes
        from project.tasks where id = 'RUFU-6301'
    `;
    expect(Number(sizes!.log_bytes)).toBeGreaterThan(0);
    expect(Number(sizes!.log_raw_bytes)).toBeGreaterThan(4096);
    expect(Number(sizes!.wfr_raw_bytes)).toBeGreaterThan(512);
    const wideBytes = Buffer.byteLength(JSON.stringify(wideRow));
    const declaredBytes = Buffer.byteLength(JSON.stringify(declaredRow));
    expect(declaredBytes).toBeLessThan(wideBytes / 2);
  });

  it("an undeclared read sends the pre-existing projection objects, by reference", () => {
    /*
    `toBe` (identity) rather than an equality of key sets: the guarantee the whole card rests on is that
    a caller which declares nothing cannot observe a different read. Object identity is the strongest
    form of that available without a wire capture, and it also pins that the cache above cannot hand an
    undeclared caller a derived projection.
    */
    expect(resolveLiveTaskRowProjection(undefined)).toBe(TASK_READ_PROJECTION);
    expect(resolveLiveTaskRowProjection({})).toBe(TASK_READ_PROJECTION);
    expect(resolveLiveTaskRowProjection({ excludeLog: true })).toBe(TASK_SLIM_PROJECTION);
    // Any other option (lane filter, forensic flag, pagination) is not a projection dimension.
    expect(resolveLiveTaskRowProjection({ includeDeleted: true, column: "todo", limit: 5 })).toBe(TASK_READ_PROJECTION);

    // `excludeLog` still wins over a declaration that names `log`: the transfer decision was already
    // made, and a flag meaning "my read-set" must not buy the column back.
    expect(Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: ["log", "description"] })))
      .not.toContain("log");
    expect(Object.keys(resolveLiveTaskRowProjection({ fields: ["log", "description"] }))).toContain("log");

    // Same declared set, different spelling, one cached object — and `[]` is NOT the same spelling as
    // absent, which is how "declared nothing" could otherwise be served the whole board.
    expect(resolveLiveTaskRowProjection({ fields: ["description", "summary"] }))
      .toBe(resolveLiveTaskRowProjection({ fields: ["summary", "description", "description"] }));
    expect(resolveLiveTaskRowProjection({ fields: [] })).not.toBe(TASK_READ_PROJECTION);
    expect(normalizeTaskListReadFields(undefined)).toBe("wide");
    expect(normalizeTaskListReadFields([])).toBe("none");
    expect(normalizeTaskListReadFields(["steps", "log"])).toBe(normalizeTaskListReadFields(["log", "steps"]));
  });

  it("never coalesces two reads that declared different fields, and does coalesce one declaration spelled twice", async () => {
    await seedHeavyCard("RUFU-6302");
    const store = h.store();

    const [a, b] = await Promise.all([
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false, fields: ["description"] }),
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false, fields: ["description", "workflowStepResults"] }),
    ]);
    expect(listReadCalls()).toBe(2);
    // The wrong-payload half: without the key dimension both callers would have received one row, and
    // the loser would have silently lacked a field it asked for.
    expect(a[0]!.workflowStepResults).toBeUndefined();
    expect((b[0]!.workflowStepResults ?? []).length).toBeGreaterThan(0);

    resetReadAttributionForTests();
    const [c, d, e] = await Promise.all([
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false, fields: ["description", "summary"] }),
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false, fields: ["summary", "description"] }),
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false, fields: ["description", "summary"] }),
    ]);
    expect(listReadCalls()).toBe(1);
    expect(c).toBe(d);
    expect(c).toBe(e);

    resetReadAttributionForTests();
    const [declared, undeclared] = await Promise.all([
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false, fields: ["description"] }),
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false }),
    ]);
    expect(listReadCalls()).toBe(2);
    expect(undeclared[0]!.log.length).toBeGreaterThan(0);
    expect(declared[0]!.log).toEqual([]);
  });

  /*
  FNXC:ListReadShapeDimensions 2026-10-25-23:39 (RUFU-627):
  The gap `fields` would have inherited, found while adding the dimension and fixed in the same change.
  The in-flight map coalesces slim and full rows alike, but it keyed them with the MEMO's key, whose
  dimensions were sufficient only because the memo's gate (`!isWatching && slim`) pins `slim` and never
  sees `compactBoardFeed`. So overlapping `{slim: true}` and `{slim: false}` reads shared one promise,
  and the joiner whose shape the starter did not request received the other's row — a `slim: false`
  joiner of a `slim: true` fetch got `log: []` plus a `timedExecutionMs` it never asked for. These legs
  are the wrong-payload guards for the three dimensions the map needed and did not have.
  */
  it("keeps slim, full, and compacted feeds as separate coalescing shapes", async () => {
    await seedHeavyCard("RUFU-6303");
    const store = h.store();

    const [slim, full] = await Promise.all([
      store.listTasks({ slim: true, includeArchived: false, startupMemo: false }),
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false }),
    ]);
    expect(listReadCalls()).toBe(2);
    expect(slim).not.toBe(full);
    expect(slim[0]!.log).toEqual([]);
    expect(full[0]!.log.length).toBeGreaterThan(0);

    resetReadAttributionForTests();
    const [compact, wide] = await Promise.all([
      store.listTasks({ slim: false, compactBoardFeed: true, includeArchived: false, startupMemo: false }),
      store.listTasks({ slim: false, includeArchived: false, startupMemo: false }),
    ]);
    expect(listReadCalls()).toBe(2);
    expect(compact[0]!.summary).toBeUndefined();
    expect(wide[0]!.summary).toBeDefined();

    resetReadAttributionForTests();
    const [logFree, logFull] = await Promise.all([
      store.listTasks({ slim: false, derive: false, excludeLog: true, includeArchived: false, startupMemo: false }),
      store.listTasks({ slim: false, derive: false, includeArchived: false, startupMemo: false }),
    ]);
    expect(listReadCalls()).toBe(2);
    expect(logFree[0]!.log).toEqual([]);
    expect(logFull[0]!.log.length).toBeGreaterThan(0);

    // The pre-existing dimensions still differ, and one shape spelled twice still agrees with itself.
    expect(listReadShapeKey({ slim: true })).not.toBe(listReadShapeKey({ slim: false }));
    expect(listReadShapeKey({ slim: false, fields: ["description"] })).not.toBe(listReadShapeKey({ slim: false }));
    expect(listReadShapeKey({ slim: false, fields: ["steps", "log"] }))
      .toBe(listReadShapeKey({ slim: false, fields: ["log", "steps"] }));
  });

  it("does not parse PROMPT.md for a slim read that did not declare steps", async () => {
    await seedHeavyCard("RUFU-6304");
    const store = h.store();

    // Precondition: the persisted `steps` is empty and PROMPT.md resolves, so the control's parse count
    // can only be explained by the steps-from-PROMPT.md sync. Read the raw column, not `getTask`, which
    // syncs the same way (the technique `list-tasks-derive-optout.pg.test.ts` already uses).
    const [persisted] = await h.adminSql()<Array<{ steps: unknown }>>`
      select steps from project.tasks where id = 'RUFU-6304'
    `;
    expect(persisted!.steps ?? []).toEqual([]);
    const authored = await store.parseStepsFromPrompt("RUFU-6304");
    expect(authored.length).toBeGreaterThan(0);

    let parses = 0;
    const original = store.parseStepsFromPrompt.bind(store);
    store.parseStepsFromPrompt = async (taskId) => {
      parses += 1;
      return original(taskId);
    };

    const control = await store.listTasks({ slim: true, derive: false, excludeLog: true, startupMemo: false });
    expect(parses).toBeGreaterThan(0);
    expect(control[0]!.steps.length).toBeGreaterThan(0);

    parses = 0;
    const declared = await store.listTasks({
      slim: true,
      derive: false,
      excludeLog: true,
      startupMemo: false,
      fields: ["description"],
    });
    expect(parses).toBe(0);
    expect(declared[0]!.steps).toEqual([]);
    expect(declared[0]!.description).toContain("field-declaration probe");

    // Declaring `steps` restores the sync, so the suppression is driven by the declaration and not by
    // `slim` having grown an opinion.
    parses = 0;
    const withSteps = await store.listTasks({
      slim: true,
      derive: false,
      excludeLog: true,
      startupMemo: false,
      fields: ["description", "steps"],
    });
    expect(parses).toBe(1);
    expect(withSteps[0]!.steps).toEqual(authored);
  });
});
