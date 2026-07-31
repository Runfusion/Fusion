/*
FNXC:WorkflowResolvedColumns 2026-07-30-18:50 (per-workflow metrics read zero on a renamed board):

`aggregateWorkflowAnalytics` filtered in SQL on `t."column" = 'done'` and
`IN ('in-progress','in-review')`. On a board whose lanes are renamed those match nothing, so
`tasksCompleted`, `tasksInProgress` and `tasksInReview` all come back ZERO for every workflow while
the board is busy. Nothing errors.

WHY NO EXISTING CHECK SAW IT. The lifecycle census parses TypeScript comparisons; these ids live
inside SQL strings. The sweep that converted this file's TypeScript guards left the queries alone,
and the file scored as converted.

The cases are DIFFERENTIAL: the same seeded work aggregated under two vocabularies whose roles are
identical and only the ids differ. `shipped` and `checking` collide with no legacy id, so a surviving
`'done'` cannot pass by luck.

`tasksInReview` is asserted as well as `tasksCompleted` because the two queries take DIFFERENT
resolved sets — complete for one, wip+human-review for the other. Asserting only the completed count
would leave the second conversion unproven, which is the partial-supply shape this program keeps
re-finding.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateWorkflowAnalytics } from "../../workflow-analytics.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

const IN_RANGE = "2026-06-15T12:00:00.000Z";
const RANGE = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z" };

/*
The per-column trait map production supplies (`resolveColumnFlagsByName(store)` at the Command Center
route). The SQL fix decides WHICH rows come back; this map decides which bucket each row lands in via
`isWipColumnRole` / `isReviewColumnRole`. Both halves have to be right — omitting this map was my
first mistake here, and the renamed case failed even with the query fixed, which is exactly the
partial-conversion shape the note above warns about.
*/
const RENAMED_FLAGS = new Map<string, { countsTowardWip?: boolean; humanReview?: boolean; complete?: boolean }>([
  ["building", { countsTowardWip: true }],
  ["checking", { countsTowardWip: true, humanReview: true }],
  ["shipped", { complete: true }],
]);
const LEGACY_FLAGS = new Map<string, { countsTowardWip?: boolean; humanReview?: boolean; complete?: boolean }>([
  ["in-progress", { countsTowardWip: true }],
  ["in-review", { countsTowardWip: true, humanReview: true }],
  ["done", { complete: true }],
]);

pgDescribe("workflow analytics under a renamed board vocabulary", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workflow_analytics_lanes",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The builtin coding workflow with only its column ids renamed. */
  async function seedRenamedWorkflow(): Promise<void> {
    const RENAME: Record<string, string> = {
      todo: "drafting",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
    };
    const rename = (id: string | undefined) => (id && RENAME[id]) ?? id;
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    ir.id = "custom:renamed-workflow-analytics";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** One finished task and one sitting in the review lane. */
  async function seedWork(completeLane: string, reviewLane: string): Promise<void> {
    const store = h.store();
    const adminDb = h.adminDb();
    for (const [id, lane] of [["KB-DONE", completeLane], ["KB-REVIEW", reviewLane]] as const) {
      await store.createTaskWithReservedId(
        { description: id, column: "todo" },
        { taskId: id, createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
      );
      /* Seeded directly: the aggregator reads column_moved_at, and moveTask would stamp it with
         `now` rather than a date inside the query range. */
      await adminDb.execute(sql`
        UPDATE project.tasks
           SET "column" = ${lane}, column_moved_at = ${IN_RANGE}, updated_at = ${IN_RANGE}
         WHERE id = ${id}`);
      store.taskCache.delete(id);
    }
  }

  const run = (withStore: boolean, renamed = false) => aggregateWorkflowAnalytics(
    Object.assign(h.layer(), { projectId: "p1" }),
    { ...RANGE, columnFlagsByName: renamed ? RENAMED_FLAGS : LEGACY_FLAGS },
    withStore ? h.store() : undefined,
  );

  /* Control: the default vocabulary counts both. Passes before and after the fix, so a generally
     broken aggregator cannot hide behind the renamed case below. */
  it("default vocabulary: completed and in-review work are counted", async () => {
    await seedWork("done", "in-review");

    const wf = await run(true);

    expect(wf.totals.tasksCompleted).toBe(1);
    expect(wf.totals.tasksInReview).toBe(1);
  });

  /* The defect: before the fix both queries matched nothing on this board. */
  it("renamed vocabulary: completed and in-review work are counted", async () => {
    await seedRenamedWorkflow();
    await seedWork("shipped", "checking");

    const wf = await run(true, true);

    expect(wf.totals.tasksCompleted).toBe(1);
    expect(wf.totals.tasksInReview).toBe(1);
  });

  /*
  The paired negative: resolving real lanes must not degrade into "every column counts". A card still
  in the hold lane is neither completed nor in review — otherwise the fix trades an undercount for an
  overcount, which is harder to notice.
  */
  it("renamed vocabulary: a card in the HOLD lane counts as neither", async () => {
    await seedRenamedWorkflow();
    await seedWork("drafting", "drafting");

    const wf = await run(true, true);

    expect(wf.totals.tasksCompleted).toBe(0);
    expect(wf.totals.tasksInReview).toBe(0);
  });

  /* Omitting the store must keep the legacy answer, so an unconverted caller is byte-identical. */
  it("without a lane store, the legacy ids still answer", async () => {
    await seedWork("done", "in-review");

    const wf = await run(false);

    expect(wf.totals.tasksCompleted).toBe(1);
    expect(wf.totals.tasksInReview).toBe(1);
  });
});
