import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
The hydration path bails early unless the root dir resolves to a real GitHub repo. That guard is not
what these cases are about, so it is stubbed — leaving it live made the assertion pass vacuously
(BOTH vocabularies hydrated nothing, so "they match" was true for the wrong reason).
*/
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, getCurrentRepo: () => ({ owner: "acme", repo: "widgets" }) };
});

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

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:40:
Three more scheduler decisions that were keyed on column-id literals.

DEFECT 3 — PR-MONITOR STARTUP HYDRATION. `configurePrMonitoring` rehydrated watchers behind
`column !== "in-review"`. On a renamed board an engine restart hydrated NOTHING, so every open PR
silently stopped being watched — no error, just a background watcher that never runs again.

DEFECT 4 — BASE-BRANCH STACKING. `resolveBaseBranch` decides whether a starting task stacks its
branch on a predecessor still in review. Keyed on the literal, a renamed board started the task from
HEAD instead, so it silently rebuilt work its predecessor had already done.

DEFECT 5 — MISSION COMPLETION ADVANCE. `handleMissionTaskMove` reconciled the feature status through
a trait-aware path and THEN gated the follow-on completion on `toColumn === "done"`. On a renamed
board the two halves of one handler disagreed about whether the same move was a completion, so the
roadmap showed the work finished while mission execution stalled.
*/

async function baseBranchScenario(names: Names) {
  const tasks = [
    makeTask({ id: "FN-PRED", column: names.review, worktree: "/tmp/project/.worktrees/FN-PRED" }),
    makeTask({ id: "FN-CAND", column: names.hold, priority: "urgent", dependencies: ["FN-PRED"] }),
  ];
  const store = createStore(tasks, {}, ir(names));
  const started: Array<{ id: string; baseBranch: string | null }> = [];
  const scheduler = new Scheduler(store, {
    onTaskStart: ((task: Task, _worktree: string, baseBranch: string | null) => {
      started.push({ id: task.id, baseBranch });
    }) as never,
  } as never);
  (scheduler as unknown as { running: boolean }).running = true;
  await scheduler.schedule();

  const resolved = (scheduler as unknown as {
    resolveBaseBranch: (t: Task, all: Task[], isReview: (c: Task) => boolean) => string | null;
  });
  return { started, resolved, tasks };
}

describe("scheduler base-branch stacking on a RENAMED board", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as never as { validateTaskFilesystem: () => unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  /*
  The predicate is now REQUIRED, so the compiler asks the question at the one call site. This asserts
  the behaviour that matters: a review-lane predecessor with a worktree supplies the base branch, and
  the answer is identical under both vocabularies.
  */
  it("stacks on a review-lane predecessor under BOTH vocabularies", async () => {
    const outcomes = await Promise.all([DEFAULT_NAMES, RENAMED_NAMES].map(async (names) => {
      const { resolved, tasks } = await baseBranchScenario(names);
      const reviewIds = new Set([tasks[0].id]);
      return resolved.resolveBaseBranch(
        tasks[1],
        tasks,
        (candidate: Task) => reviewIds.has(candidate.id),
      );
    }));

    expect(outcomes[0]).not.toBeNull();
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  /* The paired negative: no review-lane predecessor means start from HEAD, not from something else. */
  it("returns null when no predecessor is in the review lane", async () => {
    const { resolved, tasks } = await baseBranchScenario(RENAMED_NAMES);

    expect(resolved.resolveBaseBranch(tasks[1], tasks, () => false)).toBeNull();
  });
});

describe("scheduler PR-monitor hydration on a RENAMED board", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as never as { validateTaskFilesystem: () => unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  async function hydrationScenario(names: Names) {
    const tasks = [
      makeTask({
        id: "FN-PR",
        column: names.review,
        prInfo: { number: 7, url: "https://example.invalid/pr/7", branch: "fusion/FN-PR" },
      } as Partial<Task>),
    ];
    const store = createStore(tasks, {}, ir(names));
    const scheduler = new Scheduler(store);
    const startMonitoring = vi.fn();
    scheduler.configurePrMonitoring({
      prMonitor: { startMonitoring, getTrackedPrs: () => new Map(), updatePrInfo: vi.fn() } as never,
    });
    // The hydration is intentionally off the hot path (`void ... .then`), so let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return startMonitoring.mock.calls.map((call) => call[0]);
  }

  it("hydrates the review-lane PR under BOTH vocabularies", async () => {
    const [byDefault, renamed] = await Promise.all([
      hydrationScenario(DEFAULT_NAMES),
      hydrationScenario(RENAMED_NAMES),
    ]);

    expect(byDefault).toEqual(["FN-PR"]);
    expect(renamed).toEqual(byDefault);
  });
});

describe("scheduler mission completion advance on a RENAMED board", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drives `handleMissionTaskMove` directly with a task whose linked feature exists, and reports
   * whether the follow-on completion fired. The feature-status half of this handler already resolves
   * traits; this asserts the completion half agrees with it.
   */
  async function missionMoveScenario(names: Names) {
    const task = makeTask({ id: "FN-M", column: names.complete, sliceId: "slice-1" } as Partial<Task>);
    const store = createStore([task], {}, ir(names));
    const feature = { id: "feat-1", sliceId: "slice-1", status: "in-progress", taskId: "FN-M", title: "task" };
    const missionStore = {
      listFeatures: vi.fn(async () => [feature]),
      listAssertionsForFeature: vi.fn(async () => []),
      updateFeatureStatus: vi.fn(async () => undefined),
      getFeature: vi.fn(async () => feature),
      getFeatureByTaskId: vi.fn(async () => feature),
    };

    const scheduler = new Scheduler(store, { missionStore } as never);
    const completion = vi
      .spyOn(scheduler as never as { handleMissionTaskCompletion: () => Promise<void> }, "handleMissionTaskCompletion")
      .mockResolvedValue(undefined as never);

    await (scheduler as unknown as {
      handleMissionTaskMove: (id: string, to: string) => Promise<void>;
    }).handleMissionTaskMove("FN-M", names.complete);

    return completion.mock.calls.length;
  }

  /* Control: the default vocabulary advances the mission. */
  it("default vocabulary: moving into the complete column advances mission execution", async () => {
    expect(await missionMoveScenario(DEFAULT_NAMES)).toBe(1);
  });

  /*
  The defect. Before the fix `shipped` failed `toColumn === "done"`, so the feature status was
  reconciled but mission execution never advanced — the roadmap showed the work finished while the
  mission stalled.
  */
  it("renamed vocabulary: moving into the complete column advances mission execution", async () => {
    expect(await missionMoveScenario(RENAMED_NAMES)).toBe(1);
  });

  /* The paired negative: a non-complete destination must NOT advance, under either vocabulary. */
  it("a move into the REVIEW column does not advance mission execution", async () => {
    const task = makeTask({ id: "FN-M", column: RENAMED_NAMES.review, sliceId: "slice-1" } as Partial<Task>);
    const store = createStore([task], {}, ir(RENAMED_NAMES));
    const feature = { id: "feat-1", sliceId: "slice-1", status: "in-progress", taskId: "FN-M", title: "task" };
    const scheduler = new Scheduler(store, {
      missionStore: {
        listFeatures: vi.fn(async () => [feature]),
        listAssertionsForFeature: vi.fn(async () => []),
        updateFeatureStatus: vi.fn(async () => undefined),
        getFeature: vi.fn(async () => feature),
      getFeatureByTaskId: vi.fn(async () => feature),
      },
    } as never);
    const completion = vi
      .spyOn(scheduler as never as { handleMissionTaskCompletion: () => Promise<void> }, "handleMissionTaskCompletion")
      .mockResolvedValue(undefined as never);

    await (scheduler as unknown as {
      handleMissionTaskMove: (id: string, to: string) => Promise<void>;
    }).handleMissionTaskMove("FN-M", RENAMED_NAMES.review);

    expect(completion).not.toHaveBeenCalled();
  });
});
