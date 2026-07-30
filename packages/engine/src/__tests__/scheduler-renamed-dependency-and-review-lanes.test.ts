import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:05:
Two scheduler decisions that were keyed on column-id literals, on a RENAMED board.

DEFECT 1 — DEPENDENCY SATISFACTION. `isLegacyDependencySatisfied` answered "is this dependency
finished?" with `column === "done" || "in-review" || "archived"`. On a board whose complete column is
`shipped`, a FINISHED dependency matched none of the three, so `getUnmetSchedulingDependencies`
reported it unmet and every dependent stayed queued with `blockedBy` set — permanently, because the
dependency can never move anywhere that would satisfy the literal. This is the expensive direction to
be wrong in: work stops and nothing rescues it.

DEFECT 2 — THE REVIEW HALF OF THE FILE-SCOPE LEASE. The sweep that builds `activeScopes` had its wip
half converted to traits (2026-07-30-16:30, scheduler-renamed-wip-file-scope-lease.test.ts) while its
review half still read `column === "in-review"`. On a renamed board no review card entered the
registry, so a merging card's worktree files read as FREE and an overlapping candidate dispatched on
top of them. Half a fix leaves one registry with two disagreeing halves.

WHY THESE ARE DIFFERENTIAL. Each scenario runs twice against the same workflow SHAPE under two
vocabularies with identical traits; only the ids differ. Any behavioural difference between the runs
is attributable to a surviving column-id literal and nothing else. The default-vocabulary run is the
control: it passes before and after, so a change that breaks these paths generally cannot hide here.
No renamed id collides with a legacy literal, so a surviving `=== "done"` cannot pass by luck.
*/

const WF = "custom:renamed-lanes";

const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

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
    workflowStepResults: [PASSED_PLAN_REVIEW],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/** One workflow shape; the traits are identical under both vocabularies. */
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
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
  } as unknown as TaskStore;
}

async function runSweep(store: TaskStore): Promise<void> {
  const scheduler = new Scheduler(store);
  (scheduler as unknown as { running: boolean }).running = true;
  await scheduler.schedule();
}

/**
 * A ready candidate in the hold column whose single dependency already rests in the board's COMPLETE
 * column. Reported in role terms so both runs are directly comparable.
 */
async function finishedDependencyScenario(names: Names) {
  const tasks = [
    makeTask({ id: "FN-DEP", column: names.complete }),
    makeTask({ id: "FN-CAND", column: names.hold, priority: "urgent", dependencies: ["FN-DEP"] }),
  ];
  const store = createStore(tasks, {}, ir(names));
  await runSweep(store);

  const dispatched = (store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) => call[0] === "FN-CAND" && call[1] === names.wip,
  );
  const queuedAsBlocked = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) =>
      call[0] === "FN-CAND" && (call[1] as Partial<Task> | undefined)?.blockedBy === "FN-DEP",
  );

  return { dispatched, queuedAsBlocked };
}

/** The paired negative: an UNFINISHED dependency must still block, on both vocabularies. */
async function unfinishedDependencyScenario(names: Names) {
  const tasks = [
    makeTask({ id: "FN-DEP", column: names.wip }),
    makeTask({ id: "FN-CAND", column: names.hold, priority: "urgent", dependencies: ["FN-DEP"] }),
  ];
  const store = createStore(tasks, {}, ir(names));
  await runSweep(store);

  const dispatched = (store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) => call[0] === "FN-CAND" && call[1] === names.wip,
  );
  const queuedAsBlocked = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) =>
      call[0] === "FN-CAND" && (call[1] as Partial<Task> | undefined)?.blockedBy === "FN-DEP",
  );

  return { dispatched, queuedAsBlocked };
}

/**
 * An occupant in the REVIEW column holding a worktree and a file scope, and an overlapping candidate
 * in the hold column. The review occupant must hold its file-scope lease.
 */
async function reviewLeaseScenario(names: Names) {
  const tasks = [
    makeTask({ id: "FN-OCC", column: names.review, worktree: "/tmp/project/.worktrees/FN-OCC" }),
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
  await runSweep(store);

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

describe("scheduler dependency satisfaction on a RENAMED board", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as never as { validateTaskFilesystem: () => unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  /* Control. Passes before and after; a general break in dependency gating fails here too. */
  it("default vocabulary: a dependency in the complete column satisfies its dependent", async () => {
    const outcome = await finishedDependencyScenario(DEFAULT_NAMES);

    expect(outcome.dispatched).toBe(true);
    expect(outcome.queuedAsBlocked).toBe(false);
  });

  /*
  The defect. Before the fix `shipped` matched none of `done`/`in-review`/`archived`, so the finished
  dependency read as unmet and the dependent was parked `blockedBy` with nothing able to clear it.
  */
  it("renamed vocabulary: a dependency in the complete column satisfies its dependent", async () => {
    const outcome = await finishedDependencyScenario(RENAMED_NAMES);

    expect(outcome.dispatched).toBe(true);
    expect(outcome.queuedAsBlocked).toBe(false);
  });

  /* Satisfaction must not degrade into "always satisfied" — the direction the fix could overshoot. */
  it("an UNFINISHED dependency still blocks, under both vocabularies", async () => {
    const [byDefault, renamed] = await Promise.all([
      unfinishedDependencyScenario(DEFAULT_NAMES),
      unfinishedDependencyScenario(RENAMED_NAMES),
    ]);

    expect(byDefault.dispatched).toBe(false);
    expect(renamed.dispatched).toBe(false);
    expect(renamed).toEqual(byDefault);
  });

  /* States the invariant directly: the two vocabularies must be indistinguishable. */
  it("both vocabularies reach the SAME outcome — no column-id literal survives on this path", async () => {
    const [byDefault, renamed] = await Promise.all([
      finishedDependencyScenario(DEFAULT_NAMES),
      finishedDependencyScenario(RENAMED_NAMES),
    ]);

    expect(renamed).toEqual(byDefault);
  });
});

describe("scheduler file-scope lease is held for a RENAMED review column", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as never as { validateTaskFilesystem: () => unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  /* Control. */
  it("default vocabulary: the candidate overlapping a review card is queued, not dispatched", async () => {
    const outcome = await reviewLeaseScenario(DEFAULT_NAMES);

    expect(outcome.queuedOnLease).toBe(true);
    expect(outcome.dispatched).toBe(false);
  });

  /*
  The defect. Before the fix the review pass skipped the occupant (its column is not literally
  `in-review`), so its merging worktree's files read as free and the candidate dispatched on top.
  */
  it("renamed vocabulary: the candidate overlapping a review card is queued, not dispatched", async () => {
    const outcome = await reviewLeaseScenario(RENAMED_NAMES);

    expect(outcome.queuedOnLease).toBe(true);
    expect(outcome.dispatched).toBe(false);
  });

  it("both vocabularies reach the SAME outcome — no column-id literal survives on this path", async () => {
    const [byDefault, renamed] = await Promise.all([
      reviewLeaseScenario(DEFAULT_NAMES),
      reviewLeaseScenario(RENAMED_NAMES),
    ]);

    expect(renamed).toEqual(byDefault);
  });
});
