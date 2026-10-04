/*
FNXC:LifecycleContainment 2026-10-04-15:21:
`reconcileInReviewUnmetDependencies` still detects unmet dependencies on both renamed and built-in
review lanes, but FN-207 removed its automatic backward-move authority. The recovery records the
queued dependency state in place; only named review revision reasons may select a prior lifecycle lane.
*/
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const WF = "custom:wf";

/** An in-review card whose dependency is unmet — the FN-6793 rebound case. */
function inReviewTask(column: string): Task {
  return {
    id: "FN-DEP",
    title: "t",
    description: "",
    column,
    dependencies: ["FN-BLOCKER"],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
}

/** The blocker it depends on, still unfinished, so the dependency stays unmet. */
function blockerTask(column: string): Task {
  return {
    id: "FN-BLOCKER",
    title: "blocker",
    description: "",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
}

/** A board whose hold lane is `drafting` and whose review lane is `checking`. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "checking", label: "Checking", traits: [{ trait: "merge" }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(tasks: Task[], workflowIr: WorkflowIr | undefined) {
  const moveTask = vi.fn(async (_id: string, _column: string) => tasks[0]);
  const selection = { workflowId: WF, stepIds: [] };
  const store = {
    getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
    listTasks: vi.fn(async (opts?: { column?: string }) =>
      opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
    ),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    moveTask,
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getCompletionHandoffAcceptedMarker: vi.fn().mockResolvedValue(null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (workflowIr ? { ir: workflowIr } : null)),
    /* The sweep selects rows with `resolveProjectColumnsForRoles`, which reads the PROJECT's workflow
       definitions rather than the task's own selection. Without this the renamed card is never even
       considered, and the test fails upstream of the target it is about. */
    listWorkflowDefinitions: vi.fn(async () => (workflowIr ? [{ ir: workflowIr }] : [])),
  } as unknown as TaskStore;
  return { store, moveTask };
}

function manager(store: TaskStore) {
  return new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
}

describe("in-review dependency recovery respects lifecycle containment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /*
  FNXC:LifecycleContainment 2026-10-04-15:21:
  Dependency recovery is an automatic self-healing path, not a named review revision. It must retain
  an in-review card in place on both renamed and built-in boards; only explicit revision reasons may
  move a card backward. The former target assertion encoded the retired automatic rebound contract.
  */
  it("retains an in-review card on a renamed board", async () => {
    const tasks = [inReviewTask("checking"), blockerTask("building")];
    const { store, moveTask } = createStore(tasks, renamedIr());

    await manager(store).reconcileInReviewUnmetDependencies();

    expect(moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { status: "queued", blockedBy: "FN-BLOCKER" });
  });

  it("retains an in-review card with built-in vocabulary", async () => {
    const tasks = [inReviewTask("in-review"), blockerTask("in-progress")];
    const { store, moveTask } = createStore(tasks, undefined);

    await manager(store).reconcileInReviewUnmetDependencies();

    expect(moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { status: "queued", blockedBy: "FN-BLOCKER" });
  });
});
