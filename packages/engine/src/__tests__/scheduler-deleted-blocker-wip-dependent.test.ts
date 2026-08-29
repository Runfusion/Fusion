import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-18:55:
THE DELETED-BLOCKER SWEEP, on a RENAMED board.

When a task is soft-deleted, a `task:deleted` listener reconciles every dependent that was blocked by
it: the dependent's `blockedBy` is cleared so it can be scheduled again. It reads two lanes to find
those dependents — the hold lane and the WIP lane.

WHY THIS FILE EXISTS. The WIP read (`resolveProjectColumnsForRoles(store, ["countsTowardWip"])`) was
converted to traits, but NO test could observe the conversion. Blinding that resolver back to the
literal `["in-progress"]` left all 14 existing scheduler test files green (145/145). Two independent
harness properties made the conversion invisible:

  1. `resolveProjectColumnsForRoles` returns the LEGACY ids and nothing else when the store has no
     `listWorkflowDefinitions` method (project-lane-vocabulary.ts — an intentional degrade so an
     unreadable workflow list cannot fail a sweep). The shared scheduler harness does not define it,
     so the resolved set and the literal set were EQUAL BY CONSTRUCTION in every existing test.
  2. `listTasks` was mocked as `vi.fn(async () => tasks)`, ignoring its `column` filter entirely. A
     mock that returns every task regardless of the lane asked for cannot detect a wrong lane.

Either property alone is enough to make a column-set defect unobservable; both were present. So this
harness supplies `listWorkflowDefinitions` AND filters `listTasks` by column — the two things the
assertion below actually depends on.

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose WIP lane is `building`, the literal read asks
for `in-progress`, finds nothing, and the in-flight dependent is never reconciled. It keeps
`blockedBy` pointing at a task that no longer exists — permanently, because the blocker can never be
completed or re-deleted to trigger another sweep. Work stops with nothing to rescue it.

DIFFERENTIAL. Both vocabularies run the same workflow SHAPE with identical traits; only the ids
differ, and no renamed id collides with a legacy literal. The default-vocabulary run is the control:
it passes with or without the conversion, so a generic break in this path cannot hide here.
*/

const WF = "custom:deleted-blocker-lanes";

interface Names {
  hold: string;
  wip: string;
  review: string;
  complete: string;
}

const DEFAULT_NAMES: Names = { hold: "todo", wip: "in-progress", review: "in-review", complete: "done" };
const RENAMED_NAMES: Names = { hold: "drafting", wip: "building", review: "checking", complete: "shipped" };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function ir(names: Names): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: names.hold, label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: names.wip, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.review, label: "Review", traits: [{ trait: "merge" }, { trait: "human-review" }] },
      { id: names.complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

type Listener = (task: Task) => void;

function createStore(tasks: Task[], workflowIr: WorkflowIr, settings: Partial<Settings> = {}) {
  const resolved = { maxConcurrent: 10, maxWorktrees: 10, ...settings };
  const selection = { workflowId: WF, stepIds: [] };
  const listeners = new Map<string, Listener>();
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) Object.assign(task, patch);
    return task as Task;
  });

  const store = {
    /*
    Honours the `column` filter — the whole point of this harness. The shared scheduler harness
    returns `tasks` unfiltered, which silently satisfies any lane the caller asks for.
    */
    listTasks: vi.fn(async (query?: { column?: string }) =>
      (query?.column ? tasks.filter((task) => task.column === query.column) : tasks)),
    getSettings: vi.fn(async () => resolved),
    /*
    The listener ends with `this.schedule()`, which is not what these cases are about. Stubbed only so
    its failure cannot fill the run with stderr that a REAL assertion failure would then hide in.
    */
    updateSettings: vi.fn(async () => resolved),
    updateTask,
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn((event: string, callback: Listener) => {
      listeners.set(event, callback);
    }),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
    /* Without this the resolver hands back legacy ids only, and the conversion is untestable. */
    listWorkflowDefinitions: vi.fn(async () => [{ ir: workflowIr }]),
  } as unknown as TaskStore;

  return { store, updateTask, listeners };
}

/**
 * A dependent sitting in the board's WIP lane, blocked by a task that has just been soft-deleted.
 * Reported in role terms so both vocabularies are directly comparable.
 */
async function deletedBlockerScenario(names: Names) {
  const dependent = makeTask({
    id: "FN-WIP-DEPENDENT",
    column: names.wip,
    dependencies: ["FN-GONE"],
    blockedBy: "FN-GONE",
  } as Partial<Task>);
  const { store, updateTask, listeners } = createStore([dependent], ir(names));

  /* Registration happens in the constructor. */
  const scheduler = new Scheduler(store);
  (scheduler as unknown as { running: boolean }).running = true;

  const onDeleted = listeners.get("task:deleted");
  expect(onDeleted, "scheduler must subscribe to task:deleted").toBeDefined();
  onDeleted?.(makeTask({ id: "FN-GONE", column: names.wip }));

  /* The listener body is a detached async IIFE; let its awaits settle. */
  await vi.waitFor(() => {
    expect(updateTask).toHaveBeenCalled();
  });

  return { updateTask, dependent };
}

describe("scheduler deleted-blocker reconciliation reaches the WIP lane on a RENAMED board", () => {
  it("default vocabulary: an in-flight dependent of a deleted blocker is unblocked", async () => {
    const { updateTask } = await deletedBlockerScenario(DEFAULT_NAMES);
    expect(updateTask).toHaveBeenCalledWith("FN-WIP-DEPENDENT", expect.objectContaining({ blockedBy: null }));
  });

  it("renamed vocabulary: an in-flight dependent of a deleted blocker is unblocked", async () => {
    const { updateTask } = await deletedBlockerScenario(RENAMED_NAMES);
    expect(updateTask).toHaveBeenCalledWith("FN-WIP-DEPENDENT", expect.objectContaining({ blockedBy: null }));
  });

  it("both vocabularies reach the SAME outcome — no column-id literal survives on this path", async () => {
    const defaultRun = await deletedBlockerScenario(DEFAULT_NAMES);
    const renamedRun = await deletedBlockerScenario(RENAMED_NAMES);
    expect(renamedRun.dependent.blockedBy).toBe(defaultRun.dependent.blockedBy);
    expect(renamedRun.dependent.blockedBy).toBeNull();
  });
});
