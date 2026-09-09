/*
FNXC:WorkflowResolvedColumns 2026-07-31-22:50:
THE OPEN-UNDO QUERY, on a RENAMED board.

`findOpenRevertTaskForSource` answers "is there an OPEN undo task for this source?" — the question
behind the dashboard's Undo affordance. It answers it by EXCLUDING the finished lanes, so a prior
undo attempt that already landed does not keep rendering as open.

WHY THIS FILE EXISTS. That exclusion must resolve the task workflow's Complete column; blinding it
back to `ne(column,"done")` left the whole 16-file lane-detector set green — no test
in `packages/core` reaches this method at all. The dashboard-side twin (`taskRevert.ts`, #3129) has
tests; the store-side query behind it did not.

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose complete lane is `shipped`, neither literal
matches, so a DONE undo task is never excluded and `findOpenRevertTaskForSource` keeps returning it.
The card shows an undo already in flight forever, and the real affordance is unreachable. Nothing
errors — the button is just permanently wrong.

DIFFERENTIAL. The same seeded rows are queried under two vocabularies whose traits are identical and
only the ids differ; `shipped` collides with no legacy id, so a surviving `'done'` cannot pass by
luck. The default-vocabulary cases are the control: they pass with or without the conversion.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";

const AT = "2026-06-15T12:00:00.000Z";

pgDescribe("findOpenRevertTaskForSource under a renamed board vocabulary", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_open_revert_lanes",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The builtin workflow with only its column ids renamed; traits are untouched. */
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
    ir.id = "custom:renamed-open-revert";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** A source task plus an undo task pointing at it, parked in `revertLane`. */
  async function seedRevertPair(revertLane: string): Promise<void> {
    const store = h.store();
    const adminDb = h.adminDb();
    for (const id of ["KB-SRC", "KB-REV"]) {
      await store.createTaskWithReservedId(
        { description: id, column: "todo" },
        { taskId: id, createdAt: AT, updatedAt: AT, applyDefaultWorkflowSteps: false },
      );
    }
    /* Seeded directly: `sourceMetadata.revertOf` is the join this query reads, and moveTask would
       reject a target column the default workflow does not declare. */
    await adminDb.execute(sql`
      UPDATE project.tasks
         SET "column" = ${revertLane}, source_metadata = ${JSON.stringify({ revertOf: "KB-SRC" })}::jsonb
       WHERE id = 'KB-REV'`);
    store.taskCache.delete("KB-REV");
  }

  it("default vocabulary: a FINISHED undo task is not reported as open", async () => {
    await seedRevertPair("done");

    expect(await h.store().findOpenRevertTaskForSource("KB-SRC")).toBeNull();
  });

  it("renamed vocabulary: an undo task in the RENAMED complete lane is not reported as open", async () => {
    await seedRenamedWorkflow();
    await seedRevertPair("shipped");

    expect(await h.store().findOpenRevertTaskForSource("KB-SRC")).toBeNull();
  });


  /*
  The paired positive. Excluding the finished lanes must not degrade into excluding everything — an
  undo that really IS open still has to be found, or the affordance breaks in the other direction
  and no undo is ever reported in flight.
  */
  it("renamed vocabulary: an undo task still in a WORKING lane IS reported as open", async () => {
    await seedRenamedWorkflow();
    await seedRevertPair("building");

    const open = await h.store().findOpenRevertTaskForSource("KB-SRC");
    expect(open?.id).toBe("KB-REV");
  });
});
