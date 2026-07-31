/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
THE LINEAGE-INTEGRITY GATE'S ARCHIVE READ, on a RENAMED board.

`findLiveLineageChildren` answers "does this parent still have LIVE children?" — the gate that
refuses to delete a parent while lineage descendants remain. An ARCHIVED child is filed away, not
live, so it must not hold the gate shut.

WHY THIS FILE EXISTS. The archive read was converted to
`resolveProjectColumnsForRoles(store, ["archived"])`, and blinding it back to the legacy id left the
whole 16-file lane-detector set green. `store.findLiveLineageChildren` is public and nothing in
`packages/core` exercises it against a renamed board.

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose archive lane is `vaulted`, an archived child is
not recognised as archived, so it still counts as live and `TaskHasLineageChildrenError` blocks the
parent's delete forever. The operator archived the child precisely to clear the way, and the gate
cannot see that they did. This is the renamed-board twin of the defect #3162 fixed.

DIFFERENTIAL. Same seeded rows under two vocabularies with identical traits; only the ids differ, and
`vaulted` collides with no legacy id. The default-vocabulary case is the control.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../builtin-coding-workflow-ir.js";

pgDescribe("findLiveLineageChildren under a renamed board vocabulary", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lineage_children_lanes",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedRenamedWorkflow(): Promise<void> {
    const RENAME: Record<string, string> = {
      todo: "drafting",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
      archived: "vaulted",
    };
    const rename = (id: string | undefined) => (id && RENAME[id]) ?? id;
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    ir.id = "custom:renamed-lineage";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("vaulted");
    expect(ids).not.toContain("archived");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** A parent plus one child linked by `source_parent_task_id`, the child parked in `childLane`. */
  async function seedLineagePair(childLane: string): Promise<void> {
    const store = h.store();
    for (const id of ["KB-PARENT", "KB-CHILD"]) {
      await store.createTaskWithReservedId(
        { description: id, column: "todo" },
        { taskId: id, applyDefaultWorkflowSteps: false },
      );
    }
    /* Seeded directly: moveTask would reject a target the default workflow does not declare. */
    await h.adminDb().execute(sql`
      UPDATE project.tasks
         SET "column" = ${childLane}, source_parent_task_id = 'KB-PARENT'
       WHERE id = 'KB-CHILD'`);
    store.taskCache.delete("KB-CHILD");
  }

  it("default vocabulary: an ARCHIVED child does not count as live", async () => {
    await seedLineagePair("archived");

    expect(await h.store().findLiveLineageChildren("KB-PARENT")).toEqual([]);
  });

  it("renamed vocabulary: a child in the RENAMED archive lane does not count as live", async () => {
    await seedRenamedWorkflow();
    await seedLineagePair("vaulted");

    expect(await h.store().findLiveLineageChildren("KB-PARENT")).toEqual([]);
  });

  /*
  The paired positive. Recognising the renamed archive lane must not degrade into "no child is ever
  live" — that would silently disable the lineage gate and let a parent be deleted out from under
  real descendants, which is worse than the bug being fixed.
  */
  it("renamed vocabulary: a WORKING child still counts as live", async () => {
    await seedRenamedWorkflow();
    await seedLineagePair("building");

    expect(await h.store().findLiveLineageChildren("KB-PARENT")).toEqual(["KB-CHILD"]);
  });
});
