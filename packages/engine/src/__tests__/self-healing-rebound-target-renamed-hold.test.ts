/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
THE REBOUND TARGET, not the guard that selects the card.

`self-healing.ts` held 18 `moveTask(task.id, "todo", …)` calls — every one a RECOVERY. A move target
is an ARGUMENT, not a comparison, so the lifecycle-column census never counted them and no gate ever
pointed here. The failure mode is also harder than a guard's: `moveTaskInternal` REJECTS a target the
workflow does not declare (`TransitionRejectionError: unknown-column`, documented in
`task-store/moves.ts`). So on a renamed board these sweeps did not degrade to "no rescue" — they threw,
and the strand each sweep exists to clear survived while the sweep reported failure.

`reconcileInReviewUnmetDependencies` is driven here as the representative: it is a public entry point
with a documented contract (FN-6793), and its rebound is one of the 18.

WHY THE DEFAULT-BOARD CASE IS THE CONTROL AND NOT AN AFTERTHOUGHT. `resolveReboundTargetForTask`
degrades to `"todo"` whenever the workflow declares no hold/intake lane, so the conversion is a no-op
on every board we ship. The control pins that; without it a regression that made the resolver always
answer `"todo"` would leave the renamed case failing and look like a fixture problem.
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

describe("the self-healing rebound TARGET follows the board's own hold lane", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /*
  The defect: the target was the literal `"todo"`, which this board does not declare, so the move was
  rejected outright rather than rebounding the card. `drafting` collides with no legacy id, so a
  surviving literal cannot pass by luck.
  */
  it("rebounds an in-review card with unmet dependencies to the RENAMED hold lane", async () => {
    const tasks = [inReviewTask("checking"), blockerTask("building")];
    const { store, moveTask } = createStore(tasks, renamedIr());

    await manager(store).reconcileInReviewUnmetDependencies();

    expect(moveTask).toHaveBeenCalled();
    expect(moveTask.mock.calls[0]?.[1]).toBe("drafting");
  });

  /*
  CONTROL. `resolveReboundTargetForTask` falls back to `"todo"` when no workflow resolves, so the
  default board must be byte-identical to the pre-conversion behaviour. This is what makes the
  conversion safe to land across 18 recovery paths at once.
  */
  it("default vocabulary: still rebounds to `todo` when no workflow resolves", async () => {
    const tasks = [inReviewTask("in-review"), blockerTask("in-progress")];
    const { store, moveTask } = createStore(tasks, undefined);

    await manager(store).reconcileInReviewUnmetDependencies();

    expect(moveTask).toHaveBeenCalled();
    expect(moveTask.mock.calls[0]?.[1]).toBe("todo");
  });
});
