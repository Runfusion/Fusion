import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings, Task, TaskStore, WorkflowIr, WorkflowWorkItem } from "@fusion/core";

const { recordRunAuditEventMock, resolveWorkflowIrForTaskMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
  resolveWorkflowIrForTaskMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { SelfHealingManager, type SelfHealingOptions } from "../self-healing.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { evaluateStrandedHoldContinuation } from "../plan-review-continuation.js";

const workflow: WorkflowIr = {
  version: "v2", name: "stranded-test", columns: [
    { id: "holding-area", name: "Holding", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "Working", traits: [{ trait: "wip" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "holding-area" },
    { id: "plan-review", kind: "optional-group", column: "holding-area", config: { defaultOn: true, template: { nodes: [{ id: "reviewer", kind: "prompt", config: { prompt: "Review the plan" } }], edges: [] } } },
  ],
  edges: [{ from: "start", to: "plan-review" }],
};

function strandedTask(overrides: Partial<Task> = {}): Task {
  const stale = new Date(Date.now() - 120_000).toISOString();
  return {
    id: "FN-8592-test", title: "Real specification", description: "A real task", column: "holding-area",
    dependencies: [], steps: [], currentStep: 0, log: [], createdAt: stale, updatedAt: stale,
    columnMovedAt: stale, workflowStepResults: [], ...overrides,
  } as Task;
}

function storeFor(task: Task, settings: Partial<Settings> = {}) {
  const items: WorkflowWorkItem[] = [];
  return {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async (id: string) => id === task.id ? task : undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    listDueWorkflowWorkItems: vi.fn(async () => items.filter((item) => item.state === "runnable" || item.state === "retrying")),
    seedStrandedPlanReviewContinuation: vi.fn(async (input: any) => {
      const item = { ...input, id: "seeded", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as WorkflowWorkItem;
      items.push(item);
      return { seeded: true, workItemId: item.id };
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
    getTasksDir: vi.fn(() => ""),
    // FNXC:StrandedHoldContinuation 2026-08-02-00:15: 713e9320b0 routed continuation dispatch through createPlanningContinuationDispatcher, whose capacity gate reads projectId from store.getRootDir(); the mock must expose it so drainWorkflowContinuations does not throw.
    getRootDir: vi.fn(() => "fn8592-project"),
    _items: items,
  } as unknown as TaskStore & { _items: WorkflowWorkItem[] };
}

/*
FNXC:StrandedHoldContinuation 2026-07-26-16:55:
These fixtures reproduce the FN-8591 durable shape rather than an abort timing:
a real prompt plus no all-kind active continuation is sufficient for recovery.
They also pin the audit-noise boundary: healthy active ownership is silent.
*/
describe("FN-8592 stranded hold continuation recovery", () => {
  let root = "";
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "fusion-fn8592-"));
    resolveWorkflowIrForTaskMock.mockResolvedValue(workflow);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function writePrompt(id: string, text = "# Task\n\n## Steps\n\n### Step 0: Real work") {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), text);
  }

  it("defers re-seeding while planning owns the card, then recovers after release", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const planningIds = new Set([task.id]);
    const manager = new SelfHealingManager(store, {
      rootDir: root,
      getPlanningTaskIds: () => planningIds,
    } as SelfHealingOptions);

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();

    planningIds.clear();
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
  });

  it("re-seeds a real-spec hold card and records ids-only recovery metadata", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const manager = new SelfHealingManager(store, { rootDir: root });

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
    expect(store.withPlanningLifecycleLock).toHaveBeenCalledWith(task.id, expect.any(Function));
    expect(store._items).toHaveLength(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-stranded-hold-continuation",
      metadata: expect.objectContaining({ taskId: task.id, column: "holding-area" }),
    }));
    expect(JSON.stringify(recordRunAuditEventMock.mock.calls)).not.toContain("Real work");
  });

  it("defers the exact stale null-status persisted-plan episode to lifecycle recovery", () => {
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    const task = strandedTask({
      status: null as never,
      steps: [{ name: "Persisted planner step", status: "pending" }],
      updatedAt: stale,
      columnMovedAt: stale,
    });

    expect(evaluateStrandedHoldContinuation({
      task,
      columnFlags: { hold: true, intake: true },
      ir: workflow,
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# Task\n\n## Steps\n\n### Step 0: Persisted planner step",
      live: false,
      stalenessMs: 31 * 60_000,
      graceMs: 60_000,
      now: Date.now(),
    })).toMatchObject({ stranded: false, candidate: false, reason: "planning-recovery-owned" });
  });

  it("treats a Fast hold card as a non-candidate for Plan Review reseeding", () => {
    const task = strandedTask({ executionMode: "fast" });

    expect(evaluateStrandedHoldContinuation({
      task,
      columnFlags: { hold: true },
      ir: workflow,
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# FN-8592-test: Real specification\n\nA Fast request",
      live: false,
      stalenessMs: 120_000,
      graceMs: 60_000,
    })).toMatchObject({ stranded: false, candidate: false, reason: "fast-lane" });
  });

  it("keeps ordinary null-status continuation recovery outside the conservative legacy shape", () => {
    const task = strandedTask({ status: null as never, steps: [] });

    expect(evaluateStrandedHoldContinuation({
      task,
      columnFlags: { hold: true, intake: true },
      ir: workflow,
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# Task\n\n## Steps\n\n### Step 0: Ordinary continuation",
      live: false,
      stalenessMs: 120_000,
      graceMs: 60_000,
      now: Date.now(),
    })).toMatchObject({ stranded: true, candidate: true, reason: "ready" });
  });

  it("drives the repaired continuation through the runtime processor and graph reviewer seam", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const manager = new SelfHealingManager(store, { rootDir: root });
    // Optional groups run only when this task's resolved graph selection enables it.
    (task as any).enabledWorkflowSteps = ["plan-review"];

    expect(evaluateStrandedHoldContinuation({ task, columnFlags: { hold: true }, ir: workflow, continuations: [], stepResults: [], effectiveSettings: {}, enginePaused: false, promptContent: "# Task\\n\\n## Steps\\n\\n### Step 0: Real work", live: false, stalenessMs: 120_000, graceMs: 60_000 })).toMatchObject({ stranded: true });
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);

    const reviewer = vi.fn(async () => ({ outcome: "success" as const, value: "APPROVE" }));
    const graph = new WorkflowGraphExecutor({
      handlers: { prompt: reviewer },
      recordWorkflowStepResult: async (_taskId, result) => {
        await store.updateTask(task.id, { workflowStepResults: [result] as any });
      },
    });
    // Invoke the production continuation drain, which selects the seeded row and
    // dispatches it to the graph executor; this is deliberately not a direct
    // reviewer call or a hand-written workflowStepResults fixture.
    const runtime = Object.create(InProcessRuntime.prototype) as any;
    runtime.status = "active";
    runtime.workflowContinuationDrainActive = false;
    runtime.taskStore = store;
    let dispatched!: Promise<unknown>;
    runtime.executor = { execute: vi.fn((dispatchedTask: Task) => {
      dispatched = graph.run(dispatchedTask as any, {} as any, workflow);
      return dispatched;
    }) };
    await runtime.drainWorkflowContinuations();
    await dispatched;

    expect(runtime.executor.execute).toHaveBeenCalledWith(task);
    expect(reviewer).toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([expect.objectContaining({ workflowStepId: "plan-review", status: "passed" })]);
    expect(evaluateStrandedHoldContinuation({ task, columnFlags: { hold: true }, ir: workflow, continuations: [], stepResults: task.workflowStepResults, effectiveSettings: {}, enginePaused: false, promptContent: "# Task\\n\\n## Steps\\n\\n### Step 0: Real work", live: false, stalenessMs: 120_000, graceMs: 60_000 })).toMatchObject({ candidate: false, reason: "plan-review-passed" });
  });

  it("silently skips a healthy active continuation of a non-task kind", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    store._items.push({ id: "step", taskId: task.id, kind: "workflow-step", state: "held" } as WorkflowWorkItem);
    await writePrompt(task.id);

    await expect(new SelfHealingManager(store, { rootDir: root }).reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
    expect(evaluateStrandedHoldContinuation({ task, columnFlags: { hold: true }, ir: workflow, continuations: store._items, stepResults: [], effectiveSettings: {}, enginePaused: false, promptContent: "real", live: false, stalenessMs: 120_000, graceMs: 60_000 })).toMatchObject({ candidate: false, reason: "active-continuation" });
  });

  it("audits but does not repair a globally paused candidate, then recovers once cleared", async () => {
    const task = strandedTask();
    const store = storeFor(task, { globalPause: true });
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const manager = new SelfHealingManager(store, { rootDir: root });

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: "task:reconcile-stranded-hold-continuation-no-action", metadata: expect.objectContaining({ reason: "engine-paused" }) }));
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    store.getSettings.mockResolvedValue({ globalPause: false, enginePaused: false } as Settings);
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);
  });
});
