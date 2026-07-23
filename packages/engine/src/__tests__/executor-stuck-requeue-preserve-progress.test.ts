import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import type { Task } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { removeWorktree } from "../worktree/worktree-pool.js";
import {
  createMockStore,
  mockCleanup,
  mockExecuteAll,
  mockedCreateFnAgent,
  mockedDescribeRegisteredWorktrees,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedRemoveWorktree = vi.mocked(removeWorktree);

/*
FNXC:EngineTests 2026-07-19-16:05 (U10b):
Requirement under test is unchanged: a force-requeue with preserveProgress must never leave the
board claiming work that the discarded worktree took with it. What changed is WHO owns the step
list. Under the workflow graph the `parse-steps` node re-materializes `task.steps` from PROMPT.md
at the start of every run, so the executor's step statuses at abort time are the graph's, not a
hand-seeded fixture. The fixture prompt therefore has to BE the step source (see
`createMutableStore`'s `getTaskDocument`), and the assertions read the materialized list.
*/
const STEP_PROMPT =
  "# test\n## Steps\n### Step 0: Preflight\n- [ ] check\n### Step 1: Implement\n- [ ] code\n### Step 2: Verify\n- [ ] verify";

/*
FNXC:EngineTests 2026-07-19-16:05 (U10b):
The graph drives its own step transitions through the same `updateStep` seam, tagged
`{ source: "graph" }`. The lost-work reconciliation (`resetStepsIfWorkLost`) writes untagged. Split
them so "reset exactly the steps whose work was lost" stays measurable now that the graph shares
the seam — a bare call count would measure the graph, not the reconciliation.
*/
function reconciliationStepResets(store: { updateStep: { mock: { calls: unknown[][] } } }): unknown[][] {
  return store.updateStep.mock.calls.filter((call) => call[3] === undefined);
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7174",
    title: "Preserve stuck progress",
    description: STEP_PROMPT,
    prompt: STEP_PROMPT,
    column: "in-progress",
    dependencies: [],
    steps: [
      { name: "Step 0", status: "done" },
      { name: "Step 1", status: "in-progress" },
      { name: "Step 2", status: "pending" },
    ],
    currentStep: 2,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    worktree: "/tmp/test/.worktrees/fn-7174-worktree",
    branch: "fusion/fn-7174",
    baseCommitSha: "base-sha",
    enabledWorkflowSteps: [],
    ...overrides,
  };
}

function installGitResult(kind: "uncommitted-only" | "committed") {
  mockedExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes("git rev-parse --is-inside-work-tree")) return "true\n";
    if (cmd.includes("git merge-base")) return "base-sha\n";
    if (cmd.includes("git rev-parse")) {
      return kind === "uncommitted-only" ? "base-sha\n" : "branch-sha\n";
    }
    return "";
  });
}

function installGitProofFailure() {
  mockedExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes("git rev-parse --is-inside-work-tree")) return "true\n";
    if (cmd.includes("git merge-base")) throw new Error("fatal: not a valid object name fusion/fn-7174");
    return "";
  });
}

function createMutableStore(task: Task, settings: Record<string, unknown> = {}) {
  const store = createMockStore();
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: false,
    ...settings,
  });
  store.getTask.mockImplementation(async () => task);
  /*
  FNXC:EngineTests 2026-07-19-16:05 (U10b):
  Point the graph's PROMPT.md artifact read at this fixture's own prompt so the materialized step
  list is the three steps this file reasons about, instead of the shared harness's single-step
  default.
  */
  store.getTaskDocument.mockImplementation(async (_id: string, key: string) =>
    key === "PROMPT.md" ? { content: task.prompt } : undefined,
  );
  store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: Task["steps"][number]["status"]) => {
    task.steps[stepIndex].status = status;
    return task;
  });
  store.updateTask.mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
    return task;
  });
  store.moveTask.mockImplementation(async (_taskId: string, column: Task["column"]) => {
    task.column = column;
    return task;
  });
  return store;
}

function installSingleSession(resolvePrompt: () => Promise<void> | void = async () => {}) {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const session = {
    prompt: vi.fn().mockImplementation(async () => {
      started();
      await resolvePrompt();
    }),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    on: vi.fn(),
    setThinkingLevel: vi.fn(),
    sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
    getSessionStats: vi.fn().mockReturnValue({ tokens: {} }),
  };
  mockedCreateFnAgent.mockResolvedValue({ session, sessionFile: "/tmp/session.json" } as any);
  return { session, startedPromise };
}

/*
FNXC:EngineTests 2026-07-19-16:05 (U10b):
`beforeAbort` runs after the agent session exists but before the stuck kill, which is the only
window where a test can stage state the graph has already written past — the graph's own column
boundary move and its step-0 in-progress transition both land before the kill. Simulating a
concurrent recovery or a no-work session by pre-seeding the fixture no longer works.
*/
async function runSingleSessionStuckRequeue(
  task: Task,
  settings: Record<string, unknown> = {},
  beforeAbort?: (live: Task) => void,
) {
  const store = createMutableStore(task, settings);
  let releasePrompt!: () => void;
  const promptRelease = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const { startedPromise } = installSingleSession(() => promptRelease);
  const executor = new TaskExecutor(store as any, "/tmp/test", {});

  const executePromise = executor.execute(task);
  await startedPromise;
  beforeAbort?.(task);
  executor.markStuckAborted(task.id, true);
  releasePrompt();
  await executePromise;
  return { store, executor };
}

async function runStepSessionStuckRequeue(task: Task, settings: Record<string, unknown> = {}) {
  const store = createMutableStore(task, {
    runStepsInNewSessions: true,
    maxParallelSteps: 2,
    ...settings,
  });
  let release!: () => void;
  mockExecuteAll.mockReturnValue(new Promise<void>((resolve) => {
    release = resolve;
  }));
  const executor = new TaskExecutor(store as any, "/tmp/test", {});

  const executePromise = executor.execute(task);
  await vi.waitFor(() => expect((executor as any).activeStepExecutors.has(task.id)).toBe(true));
  executor.markStuckAborted(task.id, true);
  release();
  await executePromise;
  return { store, executor };
}

describe("TaskExecutor stuck requeue preserve-progress reconciliation", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedRemoveWorktree.mockResolvedValue(undefined as any);
    mockedDescribeRegisteredWorktrees.mockResolvedValue({
      rawOutput: "worktree /tmp/test/.worktrees/fn-7174-worktree\nbranch refs/heads/fusion/fn-7174\n",
      canonicalized: ["/tmp/test/.worktrees/fn-7174-worktree"],
    });
    mockCleanup.mockResolvedValue(undefined);
    installGitResult("uncommitted-only");
  });

  it("reproduces the default preserve-progress corruption case and resets uncommitted-only steps before removing the worktree", async () => {
    const task = createTask();
    const { store } = await runSingleSessionStuckRequeue(task);

    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(task.currentStep).toBe(0);
    // Every step the discarded worktree was mid-way through is reset — here the graph's step 0.
    expect(reconciliationStepResets(store)).toEqual([[task.id, 0, "pending"]]);
    expect(mockedRemoveWorktree).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: "/tmp/test/.worktrees/fn-7174-worktree",
      taskId: task.id,
      expectedOwnerTaskId: task.id,
    }));
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      worktree: null,
      branch: null,
    }));
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });
  });

  it("resets steps when git cannot prove a stale branch has durable commits before cleanup", async () => {
    installGitProofFailure();
    const task = createTask({ branch: "fusion/missing-fn-7174" });
    const { store } = await runSingleSessionStuckRequeue(task);

    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(task.currentStep).toBe(0);
    expect(reconciliationStepResets(store)).toEqual([[task.id, 0, "pending"]]);
    expect(mockedRemoveWorktree).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });
  });

  it("keeps committed step progress unchanged on preserve-progress stuck requeue", async () => {
    installGitResult("committed");
    const task = createTask();
    const { store } = await runSingleSessionStuckRequeue(task);

    // Committed work is durable: the graph's in-flight step keeps its status and currentStep stands.
    expect(task.steps.map((step) => step.status)).toEqual(["in-progress", "pending", "pending"]);
    expect(task.currentStep).toBe(2);
    expect(reconciliationStepResets(store)).toEqual([]);
    expect(mockedRemoveWorktree).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });
  });

  it("keeps preserveProgress=false reset behavior while moving without preserve options", async () => {
    const task = createTask();
    const { store } = await runSingleSessionStuckRequeue(task, { preserveProgressOnStuckRequeue: false });

    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(task.currentStep).toBe(0);
    expect(reconciliationStepResets(store)).toEqual([[task.id, 0, "pending"]]);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", undefined);
  });

  /*
  FNXC:EngineTests 2026-07-19-16:05 (U10b):
  A session that recorded no step progress must not be "reconciled" at all — there is nothing to
  lose, so the requeue writes no step statuses. Post-cutover the all-pending state has to be staged
  at kill time (the graph marks its first step in-progress before the session starts), so the
  no-work condition is asserted against the reconciliation's own writes rather than the seam's.
  */
  it("does nothing for no-work tasks with no completed or in-progress steps", async () => {
    const task = createTask();
    const { store } = await runSingleSessionStuckRequeue(task, {}, (live) => {
      for (const step of live.steps) step.status = "pending";
    });

    expect(reconciliationStepResets(store)).toEqual([]);
    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });
  });

  /*
  FNXC:EngineTests 2026-07-19-16:05 (U10b):
  The guard is the reason this file exists: if a concurrent recovery has already carried the task
  past in-progress/todo, the stuck requeue must abandon its cleanup rather than destroy the
  worktree that recovery now depends on and clobber the card back to todo. The graph moves the card
  itself during the run, so the concurrent recovery is now staged at kill time via `beforeAbort`
  instead of by seeding `column` before `execute()`.

  FNXC:EngineTests 2026-07-19-16:05 (U10b):
  "Never moved to todo" is no longer the guard's contract — the graph, as a separate authority,
  rebounds its own failed run for execution resume (`{ moveSource: "engine", recoveryRehome: true }`)
  and that move is not destructive. What the guard must suppress is the stuck-requeue's own
  bare-`{preserveProgress:true}` move plus the cleanup that goes with it: step resets, worktree
  removal, and the worktree/branch clear.
  */
  it("preserves the concurrent-recovery guard without removing worktree or clearing the checkout", async () => {
    const task = createTask();
    const { store } = await runSingleSessionStuckRequeue(task, {}, (live) => {
      live.column = "in-review";
    });

    expect(reconciliationStepResets(store)).toEqual([]);
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({
      worktree: null,
      branch: null,
    }));
    expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });
    expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "todo");
  });

  it("applies the same lost-work reconciliation to the step-session requeue path", async () => {
    const task = createTask();
    const { store } = await runStepSessionStuckRequeue(task);

    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(task.currentStep).toBe(0);
    expect(reconciliationStepResets(store)).toEqual([[task.id, 0, "pending"]]);
    expect(mockedRemoveWorktree).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });
  });

  it("applies the same lost-work reconciliation to the force-requeue grace-timeout path", async () => {
    vi.useFakeTimers();
    const task = createTask();
    const store = createMutableStore(task);
    let releasePrompt!: () => void;
    const promptRelease = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const { startedPromise } = installSingleSession(() => promptRelease);
    const executor = new TaskExecutor(store as any, "/tmp/test", {});

    const executePromise = executor.execute(task);
    await startedPromise;
    executor.markStuckAborted(task.id, true);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    expect(task.currentStep).toBe(0);
    expect(mockedRemoveWorktree).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveProgress: true });

    releasePrompt();
    await executePromise;
  });
});
