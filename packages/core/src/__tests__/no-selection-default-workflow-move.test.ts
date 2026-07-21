import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../__test-utils__/pg-test-harness.js";
import { serializeWorkflowIr } from "../workflow-ir.js";
import { resolveWorkflowIrForTask } from "../workflow-ir-resolver.js";
import {
  BUILTIN_WORKFLOWS,
  DEFAULT_WORKFLOW_ID,
  getBuiltinWorkflow,
  resolveDefaultWorkflowIr,
} from "../builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";

/*
FNXC:WorkflowBuiltins 2026-07-19-10:40:
Regression for the flag-ON "workflow move policy preflight is stale" throw on a
task with NO `task_workflow_selection` row.

Root cause: two independent implementations of the same no-selection default.
`prepareWorkflowMovePolicyPreflightImpl` resolved it through the builtin catalog
(`builtin:coding` -> BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR) while
`resolveTaskWorkflowIrForMove` used the raw legacy `BUILTIN_CODING_WORKFLOW_IR`
constant (which the catalog now publishes as `builtin:legacy-coding`). The two
IRs serialize differently, so the signature the preflight stamped never matched
the one the move re-derived and every such move was rejected as stale.

Fix: one authority — `resolveDefaultWorkflowIr()` — shared by the async move
resolver, the sync resolver, and `workflow-ir-resolver`'s `defaultCodingWorkflowIr`.

Surface enumeration (invariant: EVERY no-selection default resolution yields the
same IR, and a no-selection move is not rejected):
 - the shared helper resolves the CATALOG `builtin:coding` entry, not the legacy constant;
 - the public async resolver (`resolveWorkflowIrForTask`) agrees with the helper for a
   task whose selection row is absent;
 - a real store move on a task with the selection row cleared succeeds (the throw's surface);
 - the whole default column trail (triage -> todo -> in-progress) stays walkable, not just
   the first hop that happened to reproduce.
*/
describe("no-selection default workflow IR (single authority)", () => {
  it("resolves the catalog builtin:coding entry, not the legacy coding IR", () => {
    const catalog = getBuiltinWorkflow(DEFAULT_WORKFLOW_ID);
    expect(catalog).toBeDefined();
    expect(serializeWorkflowIr(resolveDefaultWorkflowIr())).toBe(
      serializeWorkflowIr(catalog!.ir as never),
    );
  });

  it("does not resolve to the legacy BUILTIN_CODING_WORKFLOW_IR constant", () => {
    // Guards the exact drift: the legacy constant is `builtin:legacy-coding`, a
    // DIFFERENT catalog entry. If these ever serialize the same the test is inert.
    const legacyEntry = BUILTIN_WORKFLOWS.find((wf) => wf.ir === BUILTIN_CODING_WORKFLOW_IR);
    expect(legacyEntry?.id).toBe("builtin:legacy-coding");
    expect(serializeWorkflowIr(resolveDefaultWorkflowIr())).not.toBe(
      serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR),
    );
  });

  it("agrees with the public async resolver when a task has no selection", async () => {
    const store = {
      getTaskWorkflowSelection: () => undefined,
      getTaskWorkflowSelectionAsync: async () => undefined,
      getWorkflowDefinition: async () => undefined,
    };
    const resolved = await resolveWorkflowIrForTask(store, "FN-NO-SELECTION");
    expect(serializeWorkflowIr(resolved)).toBe(serializeWorkflowIr(resolveDefaultWorkflowIr()));
  });
});

pgDescribe("moves on a task with no workflow-selection row", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_no_selection_move" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("moves through the default column trail without a stale-preflight rejection", async () => {
    const store = harness.store();
    // The stale-preflight comparison only runs on the flag-ON workflow path.
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const task = await store.createTask({ description: "no selection row" });
    await store.clearTaskWorkflowSelection(task.id);
    expect(await store.getTaskWorkflowSelectionAsync(task.id)).toBeUndefined();

    const toTodo = await store.moveTask(task.id, "todo", { moveSource: "user" });
    expect(toTodo.column).toBe("todo");

    const toInProgress = await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    expect(toInProgress.column).toBe("in-progress");
  });
});
