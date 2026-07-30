import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-16:30:
A card in a RENAMED wip column must still hold a file-scope lease.

THE DEFECT. `Scheduler.runHoldReleaseSweepPass` builds `activeScopes` — the registry the dispatch
path reads to decide whether a candidate overlaps work already in flight — behind
`if (task.column !== "in-progress") continue;`. Forty lines above it, the capacity arithmetic for the
same cards resolves the `countsTowardWip` trait from the workflow IR. So on a board whose wip column
is not literally `in-progress`, capacity counts the occupant correctly while the lease loop skips it,
`activeScopes` stays empty, `overlappingTaskId` resolves to null, and a second task sharing the same
file scope is DISPATCHED instead of queued — two agents editing the same files, which is precisely
what `groupOverlappingFiles` exists to prevent.

WHY IT IS DIFFERENTIAL. The scenario runs twice against the same workflow SHAPE under two
vocabularies whose traits are identical; only the column ids differ. Any behavioural difference
between the two runs is therefore attributable to a surviving column-id literal and nothing else.
The default-vocabulary case is the control: it passes before and after, so a change that breaks
overlap protection generally cannot hide behind this test.

None of the renamed ids collides with a legacy literal, so a surviving `=== "in-progress"` cannot
pass by luck.
*/

const WF = "custom:renamed-wip";

const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

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
    workflowStepResults: [PASSED_PLAN_REVIEW],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/** One workflow shape; the traits are identical under both vocabularies. */
function ir(names: { hold: string; wip: string; complete: string }): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: names.hold, label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: names.wip, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const DEFAULT_NAMES = { hold: "todo", wip: "in-progress", complete: "done" };
const RENAMED_NAMES = { hold: "drafting", wip: "building", complete: "shipped" };

function createStore(
  tasks: Task[],
  scopes: Record<string, string[]>,
  workflowIr: WorkflowIr,
  settings: Partial<Settings> = {},
): TaskStore {
  const resolved = { maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: true, ...settings };
  const selection = { workflowId: WF, stepIds: [] };
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) Object.assign(task, patch);
    return task as Task;
  });
  const moveTask = vi.fn(async (id: string, column: Task["column"], _opts?: Record<string, unknown>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) task.column = column;
    return task as Task;
  });
  const moveTaskIf = vi.fn(async (
    id: string,
    column: Task["column"],
    predicate: (live: Task) => boolean | Promise<boolean>,
    opts?: Record<string, unknown>,
  ) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) return { task: task as unknown as Task, moved: false };
    if (!(await predicate(task)) || task.column === column) return { task, moved: false };
    const movedTask = await moveTask(id, column, opts as never);
    return { task: movedTask ?? task, moved: true };
  });

  return {
    listTasks: vi.fn(async () => tasks),
    getSettings: vi.fn(async () => resolved),
    updateSettings: vi.fn(async () => resolved),
    parseFileScopeFromPrompt: vi.fn(async (id: string) => scopes[id] ?? []),
    updateTask,
    moveTask,
    moveTaskIf,
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    // The readers that let the scheduler resolve trait flags for these columns.
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
  } as unknown as TaskStore;
}

/**
 * One occupant already in the wip column holding a file scope, and one ready candidate in the hold
 * column whose scope overlaps it. Reported in ROLE terms so both runs are directly comparable.
 */
async function overlapScenario(names: { hold: string; wip: string; complete: string }) {
  const tasks = [
    makeTask({ id: "FN-OCC", column: names.wip, priority: "normal" }),
    makeTask({ id: "FN-CAND", column: names.hold, priority: "urgent" }),
  ];
  const store = createStore(
    tasks,
    {
      "FN-OCC": ["packages/engine/src/scheduler.ts"],
      "FN-CAND": ["packages/engine/src/scheduler.ts"],
    },
    ir(names),
  );

  const scheduler = new Scheduler(store);
  (scheduler as unknown as { running: boolean }).running = true;
  await scheduler.schedule();

  const queuedOnLease = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) =>
      call[0] === "FN-CAND"
      && (call[1] as Partial<Task> | undefined)?.overlapBlockedBy === "FN-OCC",
  );
  const dispatched = (store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) => call[0] === "FN-CAND" && call[1] === names.wip,
  );

  return { queuedOnLease, dispatched };
}

describe("scheduler file-scope lease is held for a RENAMED wip column", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as never as { validateTaskFilesystem: () => unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  /* Control. Passes before and after the fix; if overlap protection breaks generally, this fails. */
  it("default vocabulary: the overlapping candidate is queued on the lease, not dispatched", async () => {
    const outcome = await overlapScenario(DEFAULT_NAMES);

    expect(outcome.queuedOnLease).toBe(true);
    expect(outcome.dispatched).toBe(false);
  });

  /*
  The defect. Before the fix the lease loop skipped the occupant (its column is not literally
  `in-progress`), so `activeScopes` was empty and this dispatched with no overlap block.
  */
  it("renamed vocabulary: the overlapping candidate is queued on the lease, not dispatched", async () => {
    const outcome = await overlapScenario(RENAMED_NAMES);

    expect(outcome.queuedOnLease).toBe(true);
    expect(outcome.dispatched).toBe(false);
  });

  /* States the invariant directly: the two vocabularies must be indistinguishable. */
  it("both vocabularies reach the SAME outcome — no column-id literal survives on this path", async () => {
    const [byDefault, renamed] = await Promise.all([
      overlapScenario(DEFAULT_NAMES),
      overlapScenario(RENAMED_NAMES),
    ]);

    expect(renamed).toEqual(byDefault);
  });
});
