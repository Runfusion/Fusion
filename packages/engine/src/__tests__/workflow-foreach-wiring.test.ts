import { afterEach, beforeEach, expect, it } from "vitest";
import { TaskStore } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

/** The exact param type the store's save method expects (WorkflowRunStepInstance
 *  is not exported via the barrel; derive it from the method signature). */
type SaveInstanceArg = Parameters<TaskStore["saveWorkflowRunStepInstanceAsync"]>[0];

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import type {
  IntegrationGitOps,
  IntegrationProjection,
} from "../step-integration.js";
import type { WorkflowStepInstancePersistence, WorkflowStepInstanceState } from "../workflow-graph-foreach.js";
import { type WorkflowLegacySeams } from "../workflow-node-handlers.js";

/**
 * runId/foreachNodeId wiring regression coverage (FIX 1). These tests wire the
 * REAL PostgreSQL-backed TaskStore through store-backed persistence + projection
 * adapters that MIRROR the executor's production adapters, then assert that:
 *   (i)   after a foreach expands + persists, a pin-protection probe under the
 *         PRODUCTION runId sees the rows (would be empty under the old `:run` literal);
 *   (ii)  markInstanceIntegrated flips the SAME row the sub-walk persisted (status
 *         completed, integratedAt set) with NO orphan row;
 *   (iii) a resume load under the production runId sees the persisted rows.
 */

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** The production run id derivation: `${task.id}:${definition.id}`. */
const DEFINITION_ID = "wf-coding";
const runIdFor = (taskId: string) => `${taskId}:${DEFINITION_ID}`;

/** Store-backed step-instance persistence — MIRRORS executor.buildStepInstancePersistence. */
function storePersistence(store: TaskStore): WorkflowStepInstancePersistence {
  return {
    saveInstanceState: (state) =>
      store.saveWorkflowRunStepInstanceAsync(state as unknown as SaveInstanceArg),
    loadInstanceStates: async (taskId, runId) =>
      await store.loadWorkflowRunStepInstancesAsync(taskId, runId) as WorkflowStepInstanceState[],
    clearStaleInstanceStates: (taskId, keepRunId) => store.clearWorkflowRunStepInstancesAsync(taskId, keepRunId),
  };
}

/** Store-backed projection — MIRRORS executor.buildForeachWorktreeDeps.integrationProjection.
 *  Critically, markInstanceIntegrated flips the EXISTING row by its REAL identity. */
function storeProjection(store: TaskStore): IntegrationProjection {
  return {
    markStepDone: async (stepIndex) => {
      await store.updateStep(STORED_TASK_ID, stepIndex, "done", { source: "graph" });
    },
    markInstanceIntegrated: async (stepIndex, integratedAt, identity) => {
      const rows = await store.loadWorkflowRunStepInstancesAsync(STORED_TASK_ID, identity.runId);
      const existing = rows.find(
        (r) => r.foreachNodeId === identity.foreachNodeId && r.stepIndex === stepIndex,
      );
      await store.saveWorkflowRunStepInstanceAsync({
        ...(existing ?? {}),
        taskId: STORED_TASK_ID,
        runId: identity.runId,
        foreachNodeId: identity.foreachNodeId,
        stepIndex,
        pinnedStepCount: identity.pinnedStepCount,
        currentNodeId: existing?.currentNodeId ?? "",
        status: "completed",
        reworkCount: existing?.reworkCount ?? 0,
        branchName: identity.branchName,
        integratedAt,
      } as unknown as SaveInstanceArg);
    },
  };
}

let STORED_TASK_ID = "";

function fakeGitOps(): IntegrationGitOps {
  return {
    integrate: async () => ({ kind: "integrated" as const, integratedAt: "2026-01-01T00:00:00Z" }),
    discardBranch: async () => {},
  };
}

function singleExecuteTemplate(): { nodes: WorkflowIrNode[]; edges: WorkflowIr["edges"] } {
  return {
    nodes: [{ id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } }],
    edges: [],
  };
}

function foreachIr(config: Record<string, unknown>): WorkflowIr {
  return {
    version: "v2",
    name: "wiring-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "fe", kind: "foreach", config: { source: "task-steps", template: singleExecuteTemplate(), ...config } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "fe" },
      { from: "fe", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

function baseSeams(overrides: Partial<WorkflowLegacySeams>): WorkflowLegacySeams {
  const ok = async () => ({ outcome: "success" as const });
  return { planning: ok, execute: ok, review: ok, merge: ok, schedule: ok, ...overrides };
}

pgDescribe("foreach runId/foreachNodeId wiring (FIX 1)", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let taskId: string;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_foreach_wiring" });
    store = harness.store;
    const task = await store.createTask({ description: "wiring task" });
    taskId = task.id;
    STORED_TASK_ID = taskId;
    // Two steps so the foreach expands two instances.
    await store.updateTask(taskId, {
      steps: [
        { name: "Step 1", status: "pending" },
        { name: "Step 2", status: "pending" },
      ],
    });
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  function makeExecutor() {
    const stepExecuteCalls: number[] = [];
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx["foreach:active"] as { stepIndex: number } | undefined;
        if (active) stepExecuteCalls.push(active.stepIndex);
        return { outcome: "success" as const, value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      runCustomNode: async () => ({ outcome: "success" as const }),
      stepInstancePersistence: storePersistence(store),
      // Worktree isolation deps (parallel).
      allocateInstanceWorktree: async (stepIndex) => ({
        worktreePath: `/wt/step-${stepIndex}`,
        branchName: `fusion/${taskId.toLowerCase()}-step-${stepIndex}`,
      }),
      resolveIntegrationBase: async () => "base",
      integrationGitOps: fakeGitOps(),
      integrationProjection: storeProjection(store),
      semaphoreAvailability: () => 8,
      // The PRODUCTION runId, threaded as the single source of truth.
      runId: runIdFor(taskId),
    });
    return { executor, stepExecuteCalls };
  }

  it("(i)+(ii) expands+persists under the production runId and integration flips the SAME row (no orphans)", async () => {
    const detail = (await store.getTask(taskId)) as unknown as TaskDetail;
    const { executor } = makeExecutor();
    const result = await executor.run(detail, settingsOn(), foreachIr({ mode: "parallel" }));
    expect(result.outcome).toBe("success");

    const prodRunId = runIdFor(taskId);

    // (i) Pin-protection probe under the PRODUCTION runId sees rows; the old buggy
    // `${taskId}:run` literal would see nothing.
    const rowsProd = await store.loadWorkflowRunStepInstancesAsync(taskId, prodRunId);
    expect(rowsProd.length).toBe(2);
    expect(await store.loadWorkflowRunStepInstancesAsync(taskId, `${taskId}:run`)).toEqual([]);

    // (ii) Each instance row was FLIPPED in place to completed/integratedAt — and
    // there are NO orphan rows (no foreachNodeId:"" rows, exactly 2 rows total).
    expect(rowsProd.every((r) => r.foreachNodeId === "fe")).toBe(true);
    expect(rowsProd.every((r) => r.status === "completed")).toBe(true);
    expect(rowsProd.every((r) => typeof r.integratedAt === "string" && r.integratedAt)).toBe(true);
    expect(rowsProd.some((r) => r.foreachNodeId === "")).toBe(false);
    // Both steps are done in the projection.
    const after = await store.getTask(taskId);
    expect(after.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("(iii) a resume load under the production runId sees the persisted rows", async () => {
    const detail = (await store.getTask(taskId)) as unknown as TaskDetail;
    const { executor } = makeExecutor();
    await executor.run(detail, settingsOn(), foreachIr({ mode: "parallel" }));

    // Resume-equivalent probe: load under the production runId.
    const rows = await store.loadWorkflowRunStepInstancesAsync(taskId, runIdFor(taskId));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.stepIndex).sort()).toEqual([0, 1]);
    expect(rows.every((r) => r.branchName?.includes("step-"))).toBe(true);
  });

  it("prunes stale-run instance rows at run start, keeping the current run", async () => {
    // Seed a stale row from a prior run.
    await store.saveWorkflowRunStepInstanceAsync({
      taskId,
      runId: `${taskId}:stale-run`,
      foreachNodeId: "fe",
      stepIndex: 0,
      pinnedStepCount: 1,
      currentNodeId: "exec",
      status: "in-progress",
      reworkCount: 0,
      updatedAt: new Date().toISOString(),
    });
    expect((await store.loadWorkflowRunStepInstancesAsync(taskId, `${taskId}:stale-run`)).length).toBe(1);

    const detail = (await store.getTask(taskId)) as unknown as TaskDetail;
    const { executor } = makeExecutor();
    await executor.run(detail, settingsOn(), foreachIr({ mode: "parallel" }));

    // The stale run's rows were pruned at run start (keepRunId = production runId).
    expect(await store.loadWorkflowRunStepInstancesAsync(taskId, `${taskId}:stale-run`)).toEqual([]);
    // The current run's rows survive.
    expect((await store.loadWorkflowRunStepInstancesAsync(taskId, runIdFor(taskId))).length).toBe(2);
  });
});
