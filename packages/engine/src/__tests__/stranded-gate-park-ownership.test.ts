import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings, Task, TaskStore, WorkflowIr, WorkflowWorkItem } from "@fusion/core";

/*
FNXC:StrandedGateRetry 2026-10-13 (STAS-299):
Self-healing now parks a hold-lane card whose gate row it had to fail (`status:"failed"` + `error`).
A park that the engine immediately re-runs is not a park: the stranded-hold continuation sweep is the
recovery owner that would otherwise re-arm the very gate whose death produced the park, so the retry
contract has to be the ONLY thing that lifts it. These tests pin that ownership in both directions —
quiet while parked, re-armed the moment a retry discharges the failure — plus the one explicit
operator action (plan approval) that is itself an honest exit from the park.
*/

const { resolveWorkflowIrForTaskMock } = vi.hoisted(() => ({
  resolveWorkflowIrForTaskMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));

import { SelfHealingManager } from "../self-healing.js";
import {
  evaluateStrandedHoldContinuation,
  resumeApprovedPlanReviewHandoff,
} from "../plan-review-continuation.js";
import { resolveColumnFlags } from "@fusion/core";

const workflow: WorkflowIr = {
  version: "v2",
  name: "stranded-gate-test",
  columns: [
    { id: "holding-area", name: "Holding", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "Working", traits: [{ trait: "wip" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "holding-area" },
    {
      id: "plan-review",
      kind: "optional-group",
      column: "holding-area",
      config: { defaultOn: true, template: { nodes: [{ id: "reviewer", kind: "prompt", config: { prompt: "Review the plan" } }], edges: [] } },
    },
  ],
  edges: [{ from: "start", to: "plan-review" }],
};

const failedGateRow = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  phase: "pre-merge" as const,
  source: "optional-group" as const,
  status: "failed" as const,
  reviewKind: "plan" as const,
  output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
};

function strandedTask(overrides: Partial<Task> = {}): Task {
  const stale = new Date(Date.now() - 120_000).toISOString();
  return {
    id: "STAS-281-test",
    title: "Real specification",
    description: "A real task",
    column: "holding-area",
    status: "failed",
    error: "1 workflow step result(s) … marked failed by self-healing (FN-8492)",
    approvedPlanFingerprint: "7a73aaff",
    dependencies: [],
    steps: [{ name: "Draft the plan", status: "done" }, { name: "Await the verdict", status: "pending" }],
    currentStep: 1,
    log: [],
    createdAt: stale,
    updatedAt: stale,
    columnMovedAt: stale,
    workflowStepResults: [failedGateRow],
    ...overrides,
  } as unknown as Task;
}

function storeFor(task: Task) {
  const items: WorkflowWorkItem[] = [];
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    seedStrandedPlanReviewContinuation: vi.fn(async (input: Record<string, unknown>) => {
      const item = { ...input, id: "seeded", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as WorkflowWorkItem;
      items.push(item);
      return { seeded: true, workItemId: item.id };
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
    getTasksDir: vi.fn(() => ""),
    getRootDir: vi.fn(() => "stas299-project"),
  };
  return store as unknown as TaskStore & typeof store;
}

function holdFlags() {
  return resolveColumnFlags(workflow.columns![0] as never);
}

describe("STAS-299: the failure park owns a hold-lane card, not the recovery sweep", () => {
  let root = "";
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "fusion-stas299-park-"));
    resolveWorkflowIrForTaskMock.mockResolvedValue(workflow);
  });

  async function parkedSweep(task: Task) {
    const dir = join(root, task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), "# Task\n\n## Steps\n\n### Step 0: Real work");
    const store = storeFor(task);
    (store.getTasksDir as ReturnType<typeof vi.fn>).mockReturnValue(root);
    return { manager: new SelfHealingManager(store, { rootDir: root }), store };
  }

  it("names the park's owner instead of calling it a stranded continuation", () => {
    const verdict = evaluateStrandedHoldContinuation({
      task: strandedTask(),
      columnFlags: holdFlags(),
      ir: workflow,
      continuations: [],
      stepResults: [failedGateRow],
      effectiveSettings: { autoMerge: true },
      enginePaused: false,
      promptContent: "# Task\n\n## Steps\n\n### Step 0: Real work",
      live: false,
      stalenessMs: 120_000,
      graceMs: 60_000,
    });
    expect(verdict).toMatchObject({ stranded: false, candidate: false, reason: "retry-owned" });
  });

  it("re-arms the gate once the park is discharged", () => {
    const retried = strandedTask({ status: undefined, error: undefined });
    const verdict = evaluateStrandedHoldContinuation({
      task: retried,
      columnFlags: holdFlags(),
      ir: workflow,
      continuations: [],
      stepResults: [failedGateRow],
      effectiveSettings: { autoMerge: true },
      enginePaused: false,
      promptContent: "# Task\n\n## Steps\n\n### Step 0: Real work",
      live: false,
      stalenessMs: 120_000,
      graceMs: 60_000,
    });
    expect(verdict).toMatchObject({ stranded: true, reason: "ready" });
  });

  it("does not auto-retry a parked card through the recovery sweep", async () => {
    const task = strandedTask();
    const { manager, store } = await parkedSweep(task);

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
  });

  it("re-seeds the same card as soon as a retry has cleared its failure status", async () => {
    const task = strandedTask({ status: undefined, error: undefined });
    const { manager, store } = await parkedSweep(task);

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
  });

  it("treats an explicit plan approval as an honest exit from the park", async () => {
    const task = strandedTask();
    const store = storeFor(task);

    const result = await resumeApprovedPlanReviewHandoff(store, task, workflow);

    expect(result).toMatchObject({ resumed: true, reason: "seeded" });
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: null, error: null });
    expect(task.status).toBeNull();
  });
});
