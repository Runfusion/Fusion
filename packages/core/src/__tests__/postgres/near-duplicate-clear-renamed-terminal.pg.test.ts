/*
FNXC:WorkflowResolvedColumns 2026-07-30-03:20 (duplicate markers never cleared on a renamed board):

`clearNearDuplicateReferencesTo` runs whenever a canonical task is completed or deleted,
and clears the `nearDuplicateOf` markers pointing at it. It first asks
`isNearDuplicateCanonicalInactive` whether the canonical really is finished — a safety check, so a
live canonical's markers are not cleared out from under an operator.

That check was called WITHOUT the canonical's resolved column flags, so it fell back to the legacy
`done` id. On a board whose Complete lane is named anything else, a canonical that had
just been completed read as still ACTIVE, the guard early-returned, and the markers were never
cleared. The flagged duplicates stayed parked behind a user decision that could never arrive.

THE DIRECTION IS THE POINT, and I had it backwards in my first report of this seam. The failure is
NOT "markers cleared against a live canonical" — the legacy fallback errs toward "still active", so
the failure is markers that are never cleared at all. `isNearDuplicateCanonicalInactive`'s own note
says exactly this: it exists so a FINISHED canonical stops holding a flag open.

Five of the predicate's six production call sites already resolved flags. This one did not, and it is
the one that runs on every Complete transition.

The cases are DIFFERENTIAL: the same clear against two vocabularies whose roles are identical and
only the ids differ. `shipped` collides with no legacy literal, so a surviving `"done"` cannot pass
by luck.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

pgDescribe("near-duplicate markers clear when the canonical reaches a RENAMED terminal column", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_neardup_renamed",
    projectId: "project-near-duplicate-renamed-complete",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The builtin coding workflow with only its column ids renamed. */
  async function seedRenamedWorkflow(): Promise<string> {
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
    ir.id = "custom:renamed-terminal-neardup";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    /* Prove the rename landed, or a surviving "done" literal would pass by accident. */
    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");

    const created = await h.store().createWorkflowDefinition({
      name: "Renamed Terminal (near-duplicate)",
      kind: "workflow",
      ir,
    } as never);
    return (created as { id: string }).id;
  }

  /** A duplicate task carrying a `nearDuplicateOf` marker pointing at `canonicalId`. */
  async function seedDuplicateOf(canonicalId: string, workflowId?: string): Promise<string> {
    const store = h.store();
    const duplicate = await store.createTask({
      title: "the duplicate",
      description: "test",
      column: "todo",
    });
    if (workflowId) await store.writeTaskWorkflowSelection(duplicate.id, workflowId, []);
    /* `updateTask` does not persist `sourceMetadata`, so the marker is seeded directly — the same
       approach the sibling PG suites use for store-stamped fields. Seeding only; every assertion
       below still reads back through the real `getTask` path. */
    await h
      .adminDb()
      .update(schema.project.tasks)
      /* jsonb: pass the OBJECT. Stringifying stores a JSON scalar, and the clear query's
         `source_metadata->>'nearDuplicateOf'` then matches nothing — the fixture reads back fine
         through getTask (which parses either shape), so this would have looked seeded while the
         production query could never find it. */
      .set({ sourceMetadata: { nearDuplicateOf: canonicalId, nearDuplicateScore: 0.9 } })
      .where(eq(schema.project.tasks.id, duplicate.id));
    store.taskCache.delete(duplicate.id);

    /* Prove the marker is actually present; "it was cleared" is vacuous otherwise. */
    const seeded = await store.getTask(duplicate.id);
    expect((seeded.sourceMetadata as { nearDuplicateOf?: string })?.nearDuplicateOf).toBe(canonicalId);
    return duplicate.id;
  }

  async function markerStillSet(taskId: string): Promise<boolean> {
    const store = h.store();
    store.taskCache.delete(taskId);
    const after = await store.getTask(taskId);
    return (after.sourceMetadata as { nearDuplicateOf?: string })?.nearDuplicateOf !== undefined;
  }

  /* Control: under the default vocabulary the marker clears. Passes before and after the fix, so a
     generally broken clear path cannot hide behind the renamed case. */
  it("default vocabulary: completing the canonical clears the duplicate's marker", async () => {
    const canonical = await h.store().createTask({ title: "canonical", description: "t", column: "todo" });
    const duplicate = await seedDuplicateOf(canonical.id);

    await h.store().clearNearDuplicateReferencesTo(canonical.id, {
      column: "done" as never,
      reason: "completed",
    });

    expect(await markerStillSet(duplicate)).toBe(false);
  });

  /*
  The defect. Before the fix the guard read `shipped` as "still active" via the legacy ids, returned
  early, and left the marker in place forever.
  */
  it("renamed vocabulary: completing the canonical clears the duplicate's marker", async () => {
    const wf = await seedRenamedWorkflow();
    const store = h.store();
    const canonical = await store.createTask({ title: "canonical", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(canonical.id, wf, []);
    const duplicate = await seedDuplicateOf(canonical.id, wf);

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-04:25 (#2823 review — greptile, and it was right):

    DRIVEN THROUGH THE REAL COMPLETION MOVE, not by handing the consumer a column.

    Supplying `column: "shipped"` by hand proved the consumer resolves flags correctly — and hid the
    fact that nothing in production ever gives it that value. `moveTaskInternal` gates on the RESOLVED
    complete lane and then passed the literal `column: "done"`, so the consumer asked "is `done`
    terminal on this board?", got no, and left every marker in place. The fix was inert through the
    only path that reaches it.

    Moving the card is the whole point: it exercises the gate, the argument, and the consumer together,
    which is the only arrangement that could have caught this.
    */
    /* Adjacency is derived from the graph, so the card walks its board rather than jumping. */
    for (const lane of ["drafting", "building", "checking", "shipped"]) {
      await store.moveTask(canonical.id, lane as never, { bypassGuards: true } as never);
    }

    expect(await markerStillSet(duplicate)).toBe(false);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-04:45 (#2823 review — what driving production actually showed):

  THE CASE THAT SEPARATES THE ARGUMENT FROM THE ACCIDENT.

  Driving the real completion move (the case above) does NOT distinguish the hardcoded `column:
  "done"` from the resolved `toColumn`, and I checked by mutating both call sites: the suite stayed
  green. The reason is that the consumer looks the passed column up in the canonical's IR, finds
  nothing for `done` on a renamed board, and falls through to the LEGACY predicate — where `done` is
  terminal. Right outcome, wrong reason.

  It stops being an accident on a board that DECLARES a `done` column without the complete trait. The
  literal then resolves real flags, learns `done` is not terminal here, early-returns, and strands
  every duplicate marker. `toColumn` names the lane the card actually reached and is unaffected.

  This is the only shape under which the argument is load-bearing, which is why it exists.
  */
  it("clears the marker on a board that declares a NON-TERMINAL column named `done`", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "done-is-not-complete",
      ir: {
        version: "v2",
        name: "done-is-not-complete",
        columns: [
          { id: "drafting", name: "Drafting", traits: [{ trait: "intake" }] },
          /* Declared, and deliberately NOT the complete lane. */
          { id: "done", name: "Done pile (not terminal)", traits: [] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "drafting" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
    const wf = (definition as unknown as { id: string }).id;
    const canonical = await store.createTask({ title: "canonical", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(canonical.id, wf, []);
    const duplicate = await seedDuplicateOf(canonical.id, wf);

    for (const lane of ["drafting", "done", "shipped"]) {
      await store.moveTask(canonical.id, lane as never, { bypassGuards: true } as never);
    }

    expect(await markerStillSet(duplicate)).toBe(false);
  });

  /*
  The paired negative, and the reason this is a supply fix rather than a deleted guard: a canonical
  that is still LIVE must keep its duplicates' markers. Resolving the real flags must not degrade
  into "every column is terminal", which would clear markers out from under an operator who has not
  made the duplicate decision yet.
  */
  it("renamed vocabulary: a canonical still in the WIP lane does NOT clear the marker", async () => {
    const wf = await seedRenamedWorkflow();
    const store = h.store();
    const canonical = await store.createTask({ title: "canonical", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(canonical.id, wf, []);
    const duplicate = await seedDuplicateOf(canonical.id, wf);

    await store.clearNearDuplicateReferencesTo(canonical.id, {
      column: "building" as never,
      reason: "not-really-finished",
    });

    expect(await markerStillSet(duplicate)).toBe(true);
  });

  /* Same negative under the default vocabulary, so the retention is not an artifact of the rename. */
  it("default vocabulary: a canonical still in the WIP lane does NOT clear the marker", async () => {
    const canonical = await h.store().createTask({ title: "canonical", description: "t", column: "todo" });
    const duplicate = await seedDuplicateOf(canonical.id);

    await h.store().clearNearDuplicateReferencesTo(canonical.id, {
      column: "in-progress" as never,
      reason: "not-really-finished",
    });

    expect(await markerStillSet(duplicate)).toBe(true);
  });

  /* A soft-deleted canonical is inactive regardless of column vocabulary — the deletedAt branch must
     keep working, since it is the one path that never consults column flags at all. */
  it("a soft-deleted canonical clears the marker under a renamed board", async () => {
    const wf = await seedRenamedWorkflow();
    const store = h.store();
    const canonical = await store.createTask({ title: "canonical", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(canonical.id, wf, []);
    const duplicate = await seedDuplicateOf(canonical.id, wf);

    await store.clearNearDuplicateReferencesTo(canonical.id, {
      column: "building" as never,
      deletedAt: new Date().toISOString(),
      reason: "deleted",
    });

    expect(await markerStillSet(duplicate)).toBe(false);
  });
});
