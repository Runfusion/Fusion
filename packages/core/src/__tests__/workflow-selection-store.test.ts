import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { WorkflowCompileError } from "../workflow-compiler.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:CustomWorkflows 2026-06-18-12:00:
FN-6643 hardened the create-time workflow selection invariant: every task creation entry point that shares materializeExplicitWorkflowSteps must fail closed for unknown explicit workflow ids before creating a task row or task_workflow_selection state.
*/

/** Linear workflow with two pre-merge steps. */
function linearIr(): WorkflowIr {
  return {
    version: "v1",
    name: "wf",
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "spec", kind: "prompt", config: { name: "Spec", prompt: "check" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "spec", condition: "success" },
      { from: "spec", to: "end", condition: "success" },
    ],
  };
}

/** A single-node fragment IR (start → one node → end). */
function fragmentIr(): WorkflowIr {
  return {
    version: "v1",
    name: "frag",
    nodes: [
      { id: "start", kind: "start" },
      { id: "step-1", kind: "prompt", config: { name: "Doc", prompt: "doc it" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "step-1", condition: "success" },
      { from: "step-1", to: "end", condition: "success" },
    ],
  };
}

function branchingIr(): WorkflowIr {
  return {
    version: "v1",
    name: "branchy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { prompt: "a" } },
      { id: "b", kind: "prompt", config: { prompt: "b" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "success" },
      { from: "a", to: "end", condition: "success" },
      { from: "b", to: "end", condition: "success" },
    ],
  };
}

describe("TaskStore workflow selection (U3)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("selecting a workflow populates enabledWorkflowSteps and records selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wf.id);

    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(2);
    const selection = store.getTaskWorkflowSelection(task.id);
    expect(selection?.workflowId).toBe(wf.id);
    expect(selection?.stepIds).toEqual(detail.enabledWorkflowSteps);
  });

  it("compiled steps are hidden from the user-facing step manager listing", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);

    expect(await store.listWorkflowSteps()).toHaveLength(0);
    // …but the executor can still resolve them directly.
    const selection = store.getTaskWorkflowSelection(task.id)!;
    expect(await store.getWorkflowStep(selection.stepIds[0])).toBeDefined();
  });

  it("re-selecting replaces prior compiled steps without accumulating orphans", async () => {
    const wfA = await store.createWorkflowDefinition({ name: "A", ir: linearIr() });
    const wfB = await store.createWorkflowDefinition({ name: "B", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wfA.id);
    const firstIds = store.getTaskWorkflowSelection(task.id)!.stepIds;
    await store.selectTaskWorkflow(task.id, wfB.id);
    const secondIds = store.getTaskWorkflowSelection(task.id)!.stepIds;

    // Old steps are gone, only the new selection's steps remain.
    for (const id of firstIds) {
      expect(await store.getWorkflowStep(id)).toBeUndefined();
    }
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toEqual(secondIds);
  });

  it("clearing selection empties enabledWorkflowSteps", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);

    await store.clearTaskWorkflowSelection(task.id);
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("rejects selecting a non-linear workflow without writing partial state", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Branchy", ir: branchingIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await expect(store.selectTaskWorkflow(task.id, wf.id)).rejects.toBeInstanceOf(WorkflowCompileError);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
  });

  it("force-resurrecting over a tombstoned task purges its prior workflow selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);
    const priorIds = store.getTaskWorkflowSelection(task.id)!.stepIds;
    expect(priorIds).toHaveLength(2);

    // Soft-delete then physically resurrect the same id; the physical purge of
    // the old tasks row must drop the orphaned selection + its compiled steps.
    await store.deleteTask(task.id);
    await store.createTaskWithReservedId(
      { description: "resurrected", enabledWorkflowSteps: [], forceResurrect: true },
      { taskId: task.id, applyDefaultWorkflowSteps: false },
    );

    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    for (const id of priorIds) {
      expect(await store.getWorkflowStep(id)).toBeUndefined();
    }
  });

  it("throws when selecting an unknown workflow", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await expect(store.selectTaskWorkflow(task.id, "WF-404")).rejects.toThrow(/not found/i);
  });

  it("new tasks inherit the project default workflow", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);

    const task = await store.createTask({ description: "inherits" });
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(2);
    expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(wf.id);
  });

  it("explicit enabledWorkflowSteps overrides the project default", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);

    const task = await store.createTask({ description: "override", enabledWorkflowSteps: [] });
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("setDefaultWorkflowId rejects an unknown workflow and clears with null", async () => {
    await expect(store.setDefaultWorkflowId("WF-404")).rejects.toThrow(/not found/i);
    const wf = await store.createWorkflowDefinition({ name: "D", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);
    expect(await store.getDefaultWorkflowId()).toBe(wf.id);
    await store.setDefaultWorkflowId(null);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });

  // U6/R3/KTD-4: create-time `workflowId` materializes the selection atomically.
  describe("create-time workflowId (U6/R3)", () => {
    it("materializes enabledWorkflowSteps atomically when workflowId is given", async () => {
      const wf = await store.createWorkflowDefinition({ name: "Pick", ir: linearIr() });

      const task = await store.createTask({ description: "with workflow", workflowId: wf.id });
      // Reading the task right after create observes the populated steps — no
      // intermediate empty state visible to the executor.
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toHaveLength(2);
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(wf.id);
      expect(store.getTaskWorkflowSelection(task.id)?.stepIds).toEqual(detail.enabledWorkflowSteps);
    });

    it("explicit workflowId overrides the project default", async () => {
      const def = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
      const chosen = await store.createWorkflowDefinition({ name: "Chosen", ir: linearIr() });
      await store.setDefaultWorkflowId(def.id);

      const task = await store.createTask({ description: "override default", workflowId: chosen.id });
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(chosen.id);
    });

    it("workflowId: null skips default materialization (explicit No workflow)", async () => {
      const def = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
      await store.setDefaultWorkflowId(def.id);

      const task = await store.createTask({ description: "no workflow", workflowId: null });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
      expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    });

    it("undefined workflowId still inherits the project default (unchanged)", async () => {
      const def = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
      await store.setDefaultWorkflowId(def.id);

      const task = await store.createTask({ description: "inherit" });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toHaveLength(2);
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(def.id);
    });

    it("rejects a fragment id before creating the task row", async () => {
      const frag = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
      const before = (await store.listTasks({ includeArchived: true })).length;

      await expect(
        store.createTask({ description: "frag pick", workflowId: frag.id }),
      ).rejects.toThrow(/fragment/i);

      const after = (await store.listTasks({ includeArchived: true })).length;
      expect(after).toBe(before);
    });

    it("rejects an unknown workflow id before creating a task row across create entry points", async () => {
      const beforeCreateTask = (await store.listTasks({ includeArchived: true })).length;

      await expect(
        store.createTask({ description: "bad pick", workflowId: "WF-404" }),
      ).rejects.toThrow(/not found/i);

      const afterCreateTask = (await store.listTasks({ includeArchived: true })).length;
      expect(afterCreateTask).toBe(beforeCreateTask);

      const reservedTaskId = "FN-RESERVED-404";
      const beforeReservedCreate = (await store.listTasks({ includeArchived: true })).length;

      await expect(
        store.createTaskWithReservedId(
          { description: "bad reserved pick", workflowId: "WF-404" },
          { taskId: reservedTaskId, applyDefaultWorkflowSteps: true },
        ),
      ).rejects.toThrow(/not found/i);

      const afterReservedCreate = (await store.listTasks({ includeArchived: true })).length;
      expect(afterReservedCreate).toBe(beforeReservedCreate);
      expect(store.getTaskWorkflowSelection(reservedTaskId)).toBeUndefined();
    });
  });
});
