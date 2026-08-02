import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import { projectAdmissionCoordinator } from "../concurrency.js";
import {
  admitPlanningContinuation,
  createPlanningContinuationDispatcher,
  drainDuePlanningContinuations,
} from "../runtimes/in-process-runtime.js";

const PROJECT_ID = "/test/workflow-continuation-capacity";
const CONTINUATION_ID = "FN-CONTINUATION";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    priority: "medium",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

function store(
  tasks: Task[],
  settings: { maxConcurrent: number; maxWorktrees: number; worktreeLimitEnabled: boolean } = {
    maxConcurrent: 12,
    maxWorktrees: 9,
    worktreeLimitEnabled: true,
  },
): TaskStore {
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

const item = {
  id: "continuation-1",
  taskId: CONTINUATION_ID,
  nodeId: "plan-review",
  kind: "task",
  state: "runnable",
  waitReason: "planning",
  createdAt: "2026-08-01T00:00:00.000Z",
} as WorkflowWorkItem;

afterEach(() => {
  projectAdmissionCoordinator.releaseReservation(CONTINUATION_ID);
  projectAdmissionCoordinator.releaseReservation("FN-CONTINUATION-2");
  projectAdmissionCoordinator.releaseReservation("FN-CONTINUATION-3");
  projectAdmissionCoordinator.releaseReservation("FN-BLOCKER");
});

describe("workflow continuation active-slot admission", () => {
  it("does not start a tenth task when nine active tasks already hold the worktree budget", async () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    active.push(task("FN-REVIEW", {
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        source: "optional-group",
        status: "pending",
        startedAt: "2026-08-01T00:00:00.000Z",
      }],
    }));
    const dispatch = vi.fn(async () => {});

    const admitted = await admitPlanningContinuation({
      store: store([...active, task(CONTINUATION_ID)]),
      projectId: PROJECT_ID,
      task: task(CONTINUATION_ID),
      item,
      dispatch,
    });

    expect(admitted).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("starts the ninth task when only eight active tasks hold slots", async () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    const dispatch = vi.fn(async () => {});

    const admitted = await admitPlanningContinuation({
      store: store([...active, task(CONTINUATION_ID)]),
      projectId: PROJECT_ID,
      task: task(CONTINUATION_ID),
      item,
      dispatch,
    });

    expect(admitted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("loads project capacity only after an earlier coordinator handoff settles", async () => {
    const eightActive = Array.from({ length: 8 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    const ninthActive = task("FN-LANDED-HANDOFF", { status: "planning" });
    const continuation = task(CONTINUATION_ID);
    let liveTasks = [...eightActive, continuation];
    const taskStore = store(liveTasks);
    vi.mocked(taskStore.listTasks).mockImplementation(async () => liveTasks);
    const dispatch = vi.fn(async () => {});
    let releaseBlocker!: () => void;
    const blockerStarted = new Promise<void>((resolveStarted) => {
      void projectAdmissionCoordinator.admitNext({
        projectId: PROJECT_ID,
        maxConcurrent: 9,
        claimed: () => 8,
        claimedTaskIds: () => eightActive.map((candidate) => candidate.id),
        refresh: async () => [{
          taskId: "FN-BLOCKER",
          projectId: PROJECT_ID,
          lane: "execute",
          createdAt: "2026-07-31T23:59:59.000Z",
          start: async () => {
            resolveStarted();
            await new Promise<void>((resolve) => { releaseBlocker = resolve; });
            liveTasks = [...eightActive, ninthActive, continuation];
            projectAdmissionCoordinator.releaseReservation("FN-BLOCKER");
          },
        }],
      });
    });
    await blockerStarted;

    const admission = admitPlanningContinuation({
      store: taskStore,
      projectId: PROJECT_ID,
      task: continuation,
      item,
      dispatch,
    });
    await Promise.resolve();
    expect(taskStore.listTasks).not.toHaveBeenCalled();
    releaseBlocker();
    const admitted = await admission;

    expect(taskStore.listTasks).toHaveBeenCalledOnce();
    expect(admitted).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores maxWorktrees when worktree limiting is disabled", async () => {
    const active = Array.from({ length: 2 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    const continuation = task(CONTINUATION_ID);
    const dispatch = vi.fn(async () => {});

    const admitted = await admitPlanningContinuation({
      store: store([...active, continuation], {
        maxConcurrent: 3,
        maxWorktrees: 1,
        worktreeLimitEnabled: false,
      }),
      projectId: PROJECT_ID,
      task: continuation,
      item,
      dispatch,
    });

    expect(admitted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("allows an already-active task to resume without claiming a second slot", async () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    const continuing = task(CONTINUATION_ID, { status: "planning" });
    const dispatch = vi.fn(async () => {});

    const admitted = await admitPlanningContinuation({
      store: store([...active, continuing]),
      projectId: PROJECT_ID,
      task: continuing,
      item,
      dispatch,
    });

    expect(admitted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("holds the final slot across a same-drain handoff until the resumed run settles", async () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    const first = task(CONTINUATION_ID);
    const second = task("FN-CONTINUATION-2", { createdAt: "2026-08-01T00:00:01.000Z" });
    const tasks = [...active, first, second];
    const taskStore = store(tasks);
    const pendingResolvers: Array<() => void> = [];
    const execute = vi.fn(() => new Promise<void>((resolve) => pendingResolvers.push(resolve)));
    const items = [
      item,
      { ...item, id: "continuation-2", taskId: second.id, createdAt: second.createdAt },
    ] as WorkflowWorkItem[];

    await drainDuePlanningContinuations({
      listDue: async () => items,
      getTask: async (taskId) => tasks.find((candidate) => candidate.id === taskId),
      cancelOrphan: async () => {},
      defer: async () => {},
      dispatch: createPlanningContinuationDispatcher({
        store: taskStore,
        projectId: PROJECT_ID,
        execute,
      }),
      nowMs: () => Date.now(),
      warn: () => {},
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(first);
    pendingResolvers[0]?.();
    await Promise.resolve();
  });

  it("does not dispatch duplicate due continuations for the same inactive task", async () => {
    const active = Array.from({ length: 7 }, (_, index) =>
      task(`FN-PLAN-${index}`, { status: "planning" }),
    );
    const continuation = task(CONTINUATION_ID);
    const other = task("FN-CONTINUATION-2");
    const fourth = task("FN-CONTINUATION-3");
    const taskStore = store([...active, continuation, other, fourth]);
    const settles: Array<() => void> = [];
    const execute = vi.fn(() => new Promise<void>((resolve) => { settles.push(resolve); }));
    const dispatch = createPlanningContinuationDispatcher({
      store: taskStore,
      projectId: PROJECT_ID,
      execute,
    });

    const admissions = await Promise.all([
      dispatch(continuation, item),
      dispatch(continuation, { ...item, id: "continuation-duplicate" }),
    ]);
    expect(admissions).toEqual([true, true]);
    expect(execute).toHaveBeenCalledOnce();
    expect(await dispatch(other, { ...item, id: "continuation-other", taskId: other.id })).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await dispatch(fourth, { ...item, id: "continuation-fourth", taskId: fourth.id })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);

    settles.forEach((settle) => settle());
    await Promise.resolve();
  });
});
