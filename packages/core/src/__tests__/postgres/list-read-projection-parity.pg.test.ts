/**
 * FNXC:ListReadSearchVectorOmission 2026-10-09-20:07:
 * Live list reads were `SELECT *`, which shipped the stored `search_vector` tsvector to
 * Node on every board refresh. Measured on a live 24-project / 2 417-card instance that
 * column is 12.49 MB of 73.6 MB of live-row bytes — 17.0% of the payload, 5.0 KiB per
 * card, and ~90% of the read path's allocation sits in the row→Task decode this feeds.
 *
 * `search_vector` is a `tsvector GENERATED ALWAYS AS (...) STORED` search *predicate*
 * target (`@@`, `ts_rank`). It is not a `Task` field and no deserializer reads it, so it
 * is omitted from both live-list projections. These tests hold the two halves of that
 * claim:
 *
 *   1. SAFETY — every other task-table column still reaches the row, and the `Task` a
 *      caller assembles from a list read is field-for-field the `Task` a detail read
 *      assembles. A projection may not silently delete an observable field.
 *   2. EFFECT — the omitted column is genuinely absent from the transferred row, while
 *      full-text search still resolves through it.
 *
 * The omission set is written out literally below rather than imported from the module:
 * adding a column to it must be an edit a reviewer sees here, next to the assertion that
 * proves the omission is unobservable.
 */
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { Column, eq, is } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { readLiveTaskRows } from "../../task-store/async/async-persistence.js";
import type { TaskListReadField } from "../../task-store/async/async-persistence.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

/** The ONLY task-table columns a live list read may omit. See the header note. */
const OMITTED_FROM_LIST_READS = ["searchVector"] as const;

/** CamelCase TS property names of every real column on `project.tasks`. */
function taskColumnKeys(): string[] {
  return Object.entries(schema.project.tasks)
    .filter(([, value]) => is(value, Column))
    .map(([key]) => key);
}

pgTest("live list projections omit only the never-addressed columns", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_list_projection",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("the full-row and slim projections differ by `log` and nothing else", async () => {
    await h.store().createTaskWithReservedId(
      { description: "projection probe", title: "Projection probe", column: "todo" },
      { taskId: "FN-PROJ-1", applyDefaultWorkflowSteps: false },
    );

    const full = await readLiveTaskRows(h.layer(), {});
    const slim = await readLiveTaskRows(h.layer(), { excludeLog: true });
    expect(full).toHaveLength(1);
    expect(slim).toHaveLength(1);

    const fullKeys = Object.keys(full[0]!).sort();
    const slimKeys = Object.keys(slim[0]!).sort();
    const expectedFull = taskColumnKeys()
      .filter((key) => !OMITTED_FROM_LIST_READS.includes(key as (typeof OMITTED_FROM_LIST_READS)[number]))
      .sort();

    // SAFETY: the projection is the whole schema minus the explicit omission set…
    expect(fullKeys).toEqual(expectedFull);
    // …and `log` is the ONLY thing the slim mode additionally drops.
    expect(slimKeys).toEqual(expectedFull.filter((key) => key !== "log"));
  });

  it("a list row carries no searchVector yet full-text search still resolves", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      {
        description: "zebra-quinquesectional anchor text for fts",
        title: "Search anchor",
        column: "todo",
      },
      { taskId: "FN-PROJ-2", applyDefaultWorkflowSteps: false },
    );

    // EFFECT: the tsvector is not transferred…
    const rows = await readLiveTaskRows(h.layer(), {});
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain("searchVector");

    // …and yet the column still does its job, because it is a predicate target, not a value.
    const hits = await store.searchTasks("zebra-quinquesectional", { limit: 10 });
    expect(hits.map((task) => task.id)).toContain("FN-PROJ-2");
  });

  it("a list read assembles the same Task a detail read does, field for field", async () => {
    const store = h.store();
    const created = await store.createTaskWithReservedId(
      {
        description: "rich card with every column family populated",
        title: "Rich card",
        column: "in-review",
        status: "awaiting-user-review",
        priority: "high",
        size: "M",
        branch: "fusion/projection",
        branchWriteOrigin: "operator",
        worktree: "/tmp/projection-worktree",
        summary: "a completion summary",
        dependencies: [],
        customFields: { owner: "operator" },
      },
      { taskId: "FN-PROJ-3", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask("FN-PROJ-3", {
      log: [
        { timestamp: created.updatedAt, action: "[timing] step finished in 42ms", outcome: "Implement" },
      ] as never,
    });
    await store.updateTask("FN-PROJ-3", {
      workflowStepResults: [
        {
          id: "step-1",
          stepIndex: 0,
          stepName: "Implement",
          status: "approved",
          verdict: "APPROVE",
          output: "shipped",
          startedAt: created.createdAt,
          completedAt: created.updatedAt,
        },
      ] as never,
    });

    // The invariant a projection must not break lives at the ROW level: every column the
    // list read is allowed to fetch arrives exactly as the full row does. Comparing the
    // assembled `Task` would be the wrong subject — list and detail reads differ there on
    // purpose (the detail read re-reads PROMPT.md for `prompt`/`steps`, and derived stall
    // signals carry a wall-clock `observedAt`).
    const [listed] = await readLiveTaskRows(h.layer(), {});
    const [fullRow] = await h.layer().db
      .select()
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "FN-PROJ-3"));
    expect(listed).toBeDefined();
    expect(fullRow).toBeDefined();

    for (const [key, value] of Object.entries(fullRow!)) {
      if (key === "searchVector") continue;
      expect(listed![key], `column ${key} lost by the list projection`).toEqual(value);
    }

    // The omitted column is populated, so omitting it is a real saving rather than a no-op…
    expect(String(fullRow!.searchVector).length).toBeGreaterThan(0);
    // …and it is the only thing the row loses.
    expect(Object.keys(listed!)).not.toContain("searchVector");

    // The heavy jsonb families are genuinely populated, so the equality above compared
    // real payloads rather than two empty columns agreeing by accident.
    const detailed = await store.getTask("FN-PROJ-3");
    expect(detailed!.log.length).toBeGreaterThan(0);
    expect(detailed!.workflowStepResults?.length).toBeGreaterThan(0);
  });

  /*
  FNXC:ListReadFieldDeclaration 2026-10-25-23:39 (RUFU-627):
  A declared read must be a strict SUBSET of this row, field-for-field, and the undeclared row must
  stay the whole schema minus `searchVector`. The SAFETY half of that is this matrix: for every member
  of the closed union, the read that declares it gets that member's columns back EXACTLY as the full
  row has them, and gets none of any other member's. The narrow columns are asserted in the same loop,
  because the claim is "subset", not "only these": identity, lane, and the write-time projections
  (`timing_total_ms`, `log_recent`) stay in every shape, and a declaration that quietly dropped one of
  them would otherwise look identical to a correct one at the Task level.

  The column sets are written out literally (like OMITTED_FROM_LIST_READS above) rather than imported
  from `TASK_LIST_READ_FIELD_COLUMNS`, so changing what a member owns is a review-visible edit here too
  — the same argument this file already makes for the omission set.
  */
  const DECLARED_FIELD_CASES: Array<{ field: TaskListReadField; columns: readonly string[] }> = [
    { field: "log", columns: ["log"] },
    { field: "description", columns: ["description"] },
    { field: "summary", columns: ["summary"] },
    { field: "steps", columns: ["steps"] },
    { field: "attachments", columns: ["attachments"] },
    { field: "workflowStepResults", columns: ["workflowStepResults"] },
    {
      field: "source",
      columns: [
        "sourceType",
        "sourceAgentId",
        "sourceRunId",
        "sourceSessionId",
        "sourceMessageId",
        "sourceParentTaskId",
        "sourceMetadata",
        "sourceIssueProvider",
        "sourceIssueRepository",
        "sourceIssueExternalIssueId",
        "sourceIssueNumber",
        "sourceIssueUrl",
        "sourceIssueClosedAt",
      ],
    },
  ];
  const ALWAYS_SELECTED_PROBE_COLUMNS = ["id", "column", "status", "createdAt", "queueBoost", "timingTotalMs", "logRecent", "dependencies"] as const;

  /** One card with EVERY declarable field populated, so no leg can pass on an empty column. */
  async function seedWideCard(taskId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "declared-field probe description body", title: "Wide card", column: "todo" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(taskId, {
      summary: "a persisted completion summary",
      steps: [{ index: 0, heading: "Step 1: Probe", description: "Body", status: "pending" }] as never,
      log: [{ timestamp: new Date().toISOString(), action: "execution.started" }] as never,
      workflowStepResults: [{ id: "step-1", stepIndex: 0, stepName: "Implement", status: "approved", verdict: "APPROVE", output: "shipped" }] as never,
    });
    // `attachments` and the `source*` columns are not reachable through `updateTask`, so the fixture
    // seeds them the way the store does: straight into the jsonb/text columns.
    await h.layer().db
      .update(schema.project.tasks)
      .set({
        attachments: [{ name: "probe.png", url: "/tmp/probe.png" }] as never,
        sourceType: "automation",
        sourceAgentId: "agent-probe",
        sourceRunId: "run-probe",
        sourceMetadata: { fileScope: ["packages/core/src/task-store/reads.ts"] } as never,
        sourceIssueProvider: "gitlab",
        sourceIssueRepository: "grp/app",
        sourceIssueExternalIssueId: "42",
        sourceIssueNumber: 42,
        sourceIssueUrl: "https://example.invalid/42",
      } as never)
      .where(eq(schema.project.tasks.id, taskId));
  }

  it("a declared field selects exactly its own columns and keeps every narrow column", async () => {
    await seedWideCard("FN-PROJ-4");
    const layer = h.layer();
    const [full] = await readLiveTaskRows(layer, {});
    expect(full).toBeDefined();

    // The fixture must be load-bearing: every declarable column is populated, so dropping one is a
    // real omission rather than an empty-value agreement.
    for (const { columns } of DECLARED_FIELD_CASES) {
      for (const column of columns) {
        expect(full![column], `fixture left ${column} empty`).not.toBeUndefined();
      }
    }

    for (const { field, columns } of DECLARED_FIELD_CASES) {
      const [row] = await readLiveTaskRows(layer, { fields: [field] });
      expect(row, `declared read for ${field} returned no row`).toBeDefined();
      for (const column of columns) {
        expect(row![column], `${field} did not return its own column ${column}`).toEqual(full![column]);
      }
      for (const other of DECLARED_FIELD_CASES) {
        if (other.field === field) continue;
        for (const column of other.columns) {
          expect(Object.keys(row!), `${field} dragged in ${column}`).not.toContain(column);
        }
      }
      for (const column of ALWAYS_SELECTED_PROBE_COLUMNS) {
        expect(Object.keys(row!), `${field} lost narrow column ${column}`).toContain(column);
      }
    }

    // Declaring EVERY member is the shape-declaration equivalence: the projection is the same set of
    // columns the undeclared read sends, so a declaration can only ever lose, never reshape.
    const allDeclared = await readLiveTaskRows(layer, { fields: DECLARED_FIELD_CASES.map((c) => c.field) });
    expect(Object.keys(allDeclared[0]!).sort()).toEqual(Object.keys(full!).sort());

    // And the narrowest declaration keeps the narrow columns while losing every wide one.
    const noneDeclared = await readLiveTaskRows(layer, { fields: [] });
    const wide = DECLARED_FIELD_CASES.flatMap((c) => [...c.columns]);
    for (const column of wide) expect(Object.keys(noneDeclared[0]!)).not.toContain(column);
    for (const column of ALWAYS_SELECTED_PROBE_COLUMNS) expect(Object.keys(noneDeclared[0]!)).toContain(column);
  });

  it("the Task a declared read assembles stops carrying the undeclared fields", async () => {
    await seedWideCard("FN-PROJ-5");
    const store = h.store();

    const undeclared = await store.listTasks({ includeArchived: false, startupMemo: false });
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]!.description).toContain("declared-field probe");
    expect(undeclared[0]!.summary).toBeDefined();
    expect(undeclared[0]!.attachments).toBeDefined();
    expect(undeclared[0]!.workflowStepResults?.length).toBeGreaterThan(0);
    expect(undeclared[0]!.log.length).toBeGreaterThan(0);
    expect(undeclared[0]!.sourceType).toBe("automation");

    /*
    Where `Task` forces a default, the observable claim is the DEFAULT plus the column's absence, which
    is why the SQL-level leg in `list-tasks-field-declaration.pg.test.ts` exists next to this one:
    `rowToTask` cannot tell "empty history" from "column not selected" (`log`/`steps` both become `[]`),
    and a caller that must know the difference has to look at the row it was handed, not the Task.
    */
    const declared = await store.listTasks({ includeArchived: false, startupMemo: false, fields: ["description"] });
    expect(declared).toHaveLength(1);
    expect(declared[0]!.description).toContain("declared-field probe");
    expect(declared[0]!.summary).toBeUndefined();
    expect(declared[0]!.attachments).toBeUndefined();
    expect(declared[0]!.workflowStepResults).toBeUndefined();
    expect(declared[0]!.sourceType).toBeUndefined();
    expect(declared[0]!.log).toEqual([]);
    expect(declared[0]!.steps).toEqual([]);
    // Narrow identity survives: the read is still addressable, still lane-placed, still orderable.
    expect(declared[0]!.id).toBe("FN-PROJ-5");
    expect(declared[0]!.column).toBe("todo");
    expect(declared[0]!.createdAt).toBe(undeclared[0]!.createdAt);
  });

  /*
  FNXC:ListReadFieldDeclaration 2026-10-25-23:39 (RUFU-627):
  `GET /tasks` (`register-task-workflow-routes.ts`) and `GET /tasks/page` are the two feeds the desktop
  board and the mobile board poll, and neither declares fields — the first passes an option bag that
  names `slim`/`excludeLog`/`compactBoardFeed` and never `fields`, the second goes through
  `listCurrentTasksPage`, whose options type has no `fields` at all. What a declared read could still
  have cost them is a SHARED cache: the projection cache and the in-flight/memo keys are module- and
  store-scoped, so a collision would have served a board feed a narrow row. This leg is that guard, in
  the order that makes it real — read the board shape, read a declared shape, read the board shape
  again — and the route bags are spelled literally so a change to them is a change here too.
  */
  it("a declared read cannot change what the board routes emit", async () => {
    await seedWideCard("FN-PROJ-6");
    const store = h.store();

    const getTasksBag = { slim: true, excludeLog: true, compactBoardFeed: true, includeArchived: false, startupMemo: false } as const;
    const before = await store.listTasks(getTasksBag);
    const declared = await store.listTasks({ slim: true, includeArchived: false, startupMemo: false, fields: ["description"] });
    const after = await store.listTasks(getTasksBag);

    expect(before).toHaveLength(1);
    expect(declared[0]!.workflowStepResults).toBeUndefined();
    expect(after).toEqual(before);
    // The board feed's own shape is unchanged too: compacted bodies, `log` blanked by `slim`, and the
    // description it renders — none of it moved because a different caller declared a narrower read.
    expect(after[0]!.description).toContain("declared-field probe");
    expect(after[0]!.log).toEqual([]);
    expect(after[0]!.summary).toBeUndefined();
    expect((after[0]!.workflowStepResults ?? []).length).toBeGreaterThan(0);

    /*
    `GET /tasks/page` reaches the store through `listCurrentTasksPage`, whose own option bag is
    `slim` + `excludeLog` + `compactBoardFeed` + `limit` + `sort` — it names no `fields` and its options
    type has no such member, so no declaration can reach it. Asserted rather than narrated, and against
    the shape the route actually ships (a slim, compacted board row): description present, `log` blanked
    by `slim`, `summary` dropped by the compaction, step identities kept.
    */
    const page = await store.listCurrentTasksPage({ limit: 10 });
    expect(page.tasks.map((task) => task.id)).toContain("FN-PROJ-6");
    const paged = page.tasks.find((task) => task.id === "FN-PROJ-6")!;
    expect(paged.description).toContain("declared-field probe");
    expect(paged.log).toEqual([]);
    expect(paged.summary).toBeUndefined();
    expect((paged.workflowStepResults ?? []).length).toBeGreaterThan(0);
    expect(paged.sourceType).toBe("automation");
  });
});
