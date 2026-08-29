/*
FNXC:WorkflowLifecycleColumns 2026-07-31-18:00 (fleet — a whole CLASS of conversions is inert):

THE CLAIM, PROVEN HERE RATHER THAN ARGUED: `resolveTaskWorkflowIrSync` returns the DEFAULT workflow
IR for every task in production, no matter which workflow the task is actually bound to.

`getTaskWorkflowSelectionImpl` returns `undefined` unconditionally — it is a PostgreSQL-cutover stub
(`workflow-definitions.ts:505`, "Backend mode cannot synchronously read PostgreSQL, so return
undefined and let the sync reader fall back to its default"). Every sync IR read therefore takes the
`!workflowId` branch.

WHY THIS MATTERS MORE THAN AN UNCONVERTED LITERAL. A guard written as

    resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(id))?.hold

READS as converted. It resolves an IR, it asks for a trait, the census counts it as progress, and it
is wrong for every custom workflow — silently, because the return type is non-optional so no caller
can detect the substitution. A plain `=== "todo"` is at least honest about being a literal.

Ten call sites currently resolve this way (five in `packages/core/src/task-store/`, five in
`scheduler.ts` via `resolveTaskParkedColumnsSync`). This test does not fix them: it pins the
FACT they depend on, so the next person to write "convert it with the sync resolver" has a failing
assertion to read instead of a plausible-looking guard.

If a future change makes the sync path authoritative, this test SHOULD fail — that is the signal to
revisit those ten sites, not to delete the assertion.

FNXC:TestQuarantine 2026-08-10-09:16:
FN-8928 removed this file from the PostgreSQL merge gate after FN-8912 observed its setup hook
exceed the inherited 15s budget in the loaded lane. The non-blocking core suite retains this
regression proof. `PgTestTemplateDb 2026-07-19-17:20` and `PgTestWorkerCap 2026-07-18-18:00`
already mitigate this mode; this disposition does not alter the harness, assertions, or budgets.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { resolveLifecycleColumns } from "../../workflows/workflow-lifecycle-traits.js";

pgDescribe("resolveTaskWorkflowIrSync ignores a task's real workflow (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sync_ir_default",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A workflow with NO legacy column ids at all, so a default-IR answer is unmistakable. */
  async function seedRenamedWorkflow(): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: "Renamed",
      kind: "workflow",
      ir: {
        version: "v2",
        id: "custom:sync-ir-probe",
        nodes: [
          { id: "start", kind: "start", column: "drafting" },
          { id: "gate", kind: "merge-gate", column: "checking", config: { gate: "auto-merge" } },
          { id: "end", kind: "end", column: "shipped" },
        ],
        edges: [{ from: "start", to: "gate" }, { from: "gate", to: "end" }],
        columns: [
          { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "checking", label: "Checking", traits: [{ trait: "human-review" }, { trait: "merge" }] },
          { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
        ],
      },
    } as never);
    return (created as { id: string }).id;
  }

  it("returns the DEFAULT lifecycle for a task bound to a renamed workflow", async () => {
    const store = h.store();
    const workflowId = await seedRenamedWorkflow();
    const task = await store.createTask({ title: "probe", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);

    /*
    Prove the binding actually landed, or the assertion below is vacuous — it would pass just as well
    if the selection were never written, which is the failure mode that would make this test lie.
    */
    const authoritative = await store.getTaskWorkflowSelectionAsync(task.id);
    expect(authoritative?.workflowId, "the ASYNC reader must see the binding").toBe(workflowId);

    const syncLifecycle = resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(task.id));

    /* The task is bound to a board whose hold lane is `drafting`. The sync reader says `todo`. */
    expect(syncLifecycle?.hold).toBe("todo");
    expect(syncLifecycle?.hold).not.toBe("drafting");
    expect(syncLifecycle?.review).not.toBe("checking");
    expect(syncLifecycle?.complete).not.toBe("shipped");
  });

  /*
  The contrast that makes the first case actionable: the ASYNC resolver on the same task, in the same
  transaction, gets it right. So the fix for any of the ten sites is always "reach the async
  resolver", never "resolve it synchronously and hope".
  */
  it("the ASYNC resolver on the same task returns the task's real lifecycle", async () => {
    const store = h.store();
    const workflowId = await seedRenamedWorkflow();
    const task = await store.createTask({ title: "probe", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);

    const { resolveTaskLifecycleColumns } = await import("../../workflows/workflow-lifecycle-traits.js");
    const asyncLifecycle = await resolveTaskLifecycleColumns(store as never, task.id);

    expect(asyncLifecycle?.hold).toBe("drafting");
    expect(asyncLifecycle?.review).toBe("checking");
    expect(asyncLifecycle?.complete).toBe("shipped");
  });

  /*
  And the reason it happens, pinned directly so the diagnosis does not have to be re-derived from
  behaviour: the sync selection reader is a stub that always answers "no selection".
  */
  it("the sync selection reader returns undefined even when a selection exists", async () => {
    const store = h.store();
    const workflowId = await seedRenamedWorkflow();
    const task = await store.createTask({ title: "probe", description: "t", column: "todo" });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);

    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    expect((await store.getTaskWorkflowSelectionAsync(task.id))?.workflowId).toBe(workflowId);
  });
});
