import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { WorkflowRunStepInstance } from "../types.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/**
 * Step-inversion U4 (KTD-6/KTD-13): persistence groundwork for the foreach
 * step-instance region. Covers the workflow_run_step_instances CRUD trio
 * (save/load/clear) — upsert-on-conflict, per-run pruning, load ordering — plus
 * the raw tasks.customFields JSON round-trip through create/update/get.
 *
 * The CRUD trio mirrors workflow_run_branches: a `save` is an idempotent UPSERT
 * keyed by (taskId, runId, foreachNodeId, stepIndex); `load` returns the run's
 * rows ordered by stepIndex; `clear` prunes either everything-but-a-kept-run
 * (per-run prune) or, with no runId, every row for the task.
 */

describe("workflow_run_step_instances CRUD (U4, KTD-6)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  type StepInstanceStore = {
    saveWorkflowRunStepInstance(state: WorkflowRunStepInstance): void;
    loadWorkflowRunStepInstances(taskId: string, runId: string): WorkflowRunStepInstance[];
    clearWorkflowRunStepInstances(taskId: string, keepRunId?: string): void;
  };
  const sis = (): StepInstanceStore => store as unknown as StepInstanceStore;

  function rawCount(taskId: string): number {
    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_run_step_instances WHERE taskId = ?")
      .get(taskId) as { c: number };
    return row.c;
  }

  function makeInstance(overrides: Partial<WorkflowRunStepInstance> = {}): WorkflowRunStepInstance {
    return {
      taskId: "T-1",
      runId: "r1",
      foreachNodeId: "fe",
      stepIndex: 0,
      pinnedStepCount: 3,
      currentNodeId: "n1",
      status: "in-progress",
      baselineSha: "abc123",
      checkpointId: "ckpt-1",
      reworkCount: 0,
      branchName: null,
      integratedAt: null,
      updatedAt: "2026-06-04T00:00:00.000Z",
      ...overrides,
    };
  }

  it("round-trips a full instance row through save → load", async () => {
    const t = await store.createTask({ description: "stepped" });
    const inst = makeInstance({
      taskId: t.id,
      branchName: "step/0",
      integratedAt: "2026-06-04T01:00:00.000Z",
      status: "completed",
      reworkCount: 2,
    });
    sis().saveWorkflowRunStepInstance(inst);

    const [loaded] = sis().loadWorkflowRunStepInstances(t.id, "r1");
    expect(loaded.taskId).toBe(t.id);
    expect(loaded.runId).toBe("r1");
    expect(loaded.foreachNodeId).toBe("fe");
    expect(loaded.stepIndex).toBe(0);
    expect(loaded.pinnedStepCount).toBe(3);
    expect(loaded.currentNodeId).toBe("n1");
    expect(loaded.status).toBe("completed");
    expect(loaded.baselineSha).toBe("abc123");
    expect(loaded.checkpointId).toBe("ckpt-1");
    expect(loaded.reworkCount).toBe(2);
    expect(loaded.branchName).toBe("step/0");
    expect(loaded.integratedAt).toBe("2026-06-04T01:00:00.000Z");
    expect(typeof loaded.updatedAt).toBe("string");
  });

  it("save UPSERTS on (taskId, runId, foreachNodeId, stepIndex) conflict", async () => {
    const t = await store.createTask({ description: "upsert" });
    sis().saveWorkflowRunStepInstance(
      makeInstance({ taskId: t.id, stepIndex: 0, currentNodeId: "n1", status: "in-progress", reworkCount: 0 }),
    );
    // Same PK — overwrites in place, not a second row.
    sis().saveWorkflowRunStepInstance(
      makeInstance({ taskId: t.id, stepIndex: 0, currentNodeId: "n5", status: "completed", reworkCount: 1 }),
    );
    // Different stepIndex — a new row.
    sis().saveWorkflowRunStepInstance(
      makeInstance({ taskId: t.id, stepIndex: 1, currentNodeId: "n2", status: "pending" }),
    );

    expect(rawCount(t.id)).toBe(2);
    const loaded = sis().loadWorkflowRunStepInstances(t.id, "r1");
    const step0 = loaded.find((row) => row.stepIndex === 0);
    expect(step0?.currentNodeId).toBe("n5");
    expect(step0?.status).toBe("completed");
    expect(step0?.reworkCount).toBe(1);
  });

  it("persists nullable anchors as null and reads them back as null", async () => {
    const t = await store.createTask({ description: "nulls" });
    sis().saveWorkflowRunStepInstance(
      makeInstance({
        taskId: t.id,
        currentNodeId: null,
        baselineSha: null,
        checkpointId: null,
        branchName: null,
        integratedAt: null,
        status: "pending",
      }),
    );
    const [loaded] = sis().loadWorkflowRunStepInstances(t.id, "r1");
    expect(loaded.currentNodeId).toBeNull();
    expect(loaded.baselineSha).toBeNull();
    expect(loaded.checkpointId).toBeNull();
    expect(loaded.branchName).toBeNull();
    expect(loaded.integratedAt).toBeNull();
  });

  it("loadWorkflowRunStepInstances returns the run ordered by stepIndex", async () => {
    const t = await store.createTask({ description: "ordered" });
    // Insert out of order.
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, stepIndex: 2, currentNodeId: "n2" }));
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, stepIndex: 0, currentNodeId: "n0" }));
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, stepIndex: 1, currentNodeId: "n1" }));

    const loaded = sis().loadWorkflowRunStepInstances(t.id, "r1");
    expect(loaded.map((row) => row.stepIndex)).toEqual([0, 1, 2]);
  });

  it("loadWorkflowRunStepInstances scopes to the requested run only", async () => {
    const t = await store.createTask({ description: "scoped" });
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "r1", stepIndex: 0 }));
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "r2", stepIndex: 0 }));
    expect(sis().loadWorkflowRunStepInstances(t.id, "r1").length).toBe(1);
    expect(sis().loadWorkflowRunStepInstances(t.id, "r2").length).toBe(1);
  });

  it("clear with keepRunId prunes every other run, keeps the kept run", async () => {
    const t = await store.createTask({ description: "prune" });
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "old", stepIndex: 0 }));
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "old", stepIndex: 1 }));
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "cur", stepIndex: 0 }));

    sis().clearWorkflowRunStepInstances(t.id, "cur");

    expect(rawCount(t.id)).toBe(1);
    expect(sis().loadWorkflowRunStepInstances(t.id, "old").length).toBe(0);
    expect(sis().loadWorkflowRunStepInstances(t.id, "cur").length).toBe(1);
  });

  it("clear with no keepRunId prunes all rows for the task", async () => {
    const t = await store.createTask({ description: "wipe" });
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "r1", stepIndex: 0 }));
    sis().saveWorkflowRunStepInstance(makeInstance({ taskId: t.id, runId: "r2", stepIndex: 0 }));

    sis().clearWorkflowRunStepInstances(t.id);

    expect(rawCount(t.id)).toBe(0);
  });
});

describe("tasks.customFields JSON round-trip under a fielded workflow (U11/KTD-13)", () => {
  // U11 behavior change vs. U4: customFields is no longer an opaque whole-object
  // round-trip — every write is now validated against the task's workflow field
  // schema through the single store authority (task-fields.ts). The default
  // workflow declares no fields, so the original U4 tests (which wrote arbitrary
  // keys onto a default-workflow task) would now be rejected with
  // `no-fields-defined`. They are reworked here to attach a workflow that
  // declares the fields under test, and `updateTask` is now a MERGE-with-delete
  // patch (not whole-object replacement). The zero-fields rejection path is
  // covered in task-fields.test.ts.
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  // A v2 workflow declaring the fields exercised below.
  const fieldedIr = (): WorkflowIr =>
    ({
      version: "v2",
      name: "fielded",
      columns: [
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "done", name: "done", traits: [] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [{ from: "start", to: "end" }],
      fields: [
        {
          id: "severity",
          name: "Severity",
          type: "enum",
          options: [
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ],
        },
        { id: "points", name: "Points", type: "number" },
        { id: "flagged", name: "Flagged", type: "boolean" },
        {
          id: "tags",
          name: "Tags",
          type: "multi-enum",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
        { id: "keep", name: "Keep", type: "string" },
        { id: "a", name: "A", type: "number" },
        { id: "b", name: "B", type: "number" },
      ],
    }) as unknown as WorkflowIr;

  let workflowId: string;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    const def = await (store as any).createWorkflowDefinition({ name: "Fielded", ir: fieldedIr() });
    workflowId = def.id;
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  async function fieldedTask(description: string) {
    const t = await store.createTask({ description });
    await (store as any).selectTaskWorkflow(t.id, workflowId);
    return t;
  }

  it("a freshly created task has no customFields (legacy-shape default)", async () => {
    const t = await store.createTask({ description: "no fields" });
    const got = await store.getTask(t.id);
    expect(got?.customFields).toEqual({});
  });

  it("round-trips a validated customFields object through updateTask → getTask", async () => {
    const t = await fieldedTask("fielded");
    await store.updateTask(t.id, {
      customFields: { severity: "high", points: 3, flagged: true, tags: ["a", "b"] },
    });
    const got = await store.getTask(t.id);
    expect(got?.customFields).toEqual({ severity: "high", points: 3, flagged: true, tags: ["a", "b"] });
  });

  it("updateTask MERGES the customFields patch (U11 change from U4's whole-object replace)", async () => {
    const t = await fieldedTask("merge");
    await store.updateTask(t.id, { customFields: { a: 1, b: 2 } });
    await store.updateTask(t.id, { customFields: { a: 9 } });
    const got = await store.getTask(t.id);
    // U11 merge semantics: `b` survives, `a` is overwritten. (U4 replaced wholesale.)
    expect(got?.customFields).toEqual({ a: 9, b: 2 });
  });

  it("null in the patch deletes that field's value", async () => {
    const t = await fieldedTask("delete");
    await store.updateTask(t.id, { customFields: { a: 1, b: 2 } });
    await store.updateTask(t.id, { customFields: { a: null } });
    const got = await store.getTask(t.id);
    expect(got?.customFields).toEqual({ b: 2 });
  });

  it("leaves customFields untouched when an unrelated field is updated", async () => {
    const t = await fieldedTask("untouched");
    await store.updateTask(t.id, { customFields: { keep: "me" } });
    await store.updateTask(t.id, { summary: "an unrelated change" });
    const got = await store.getTask(t.id);
    expect(got?.customFields).toEqual({ keep: "me" });
  });
});
