import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../active-session-registry.js";
import { TriageProcessor } from "../triage.js";

/*
FNXC:NodeWorktreeIsolation 2026-07-26-09:10:
Regression suite for the FN-8600 spurious-pause incident.

Original symptom: a healthy card was parked `paused` with `pausedReason:"branch-conflict-unrecoverable"`
and `error: "Task branch conflict: fusion/fn-8600 is not safely reclaimable (tip-already-merged
cleanup failed for FN-8600)"` — with no operator action (`userPaused:false`). Cause: planning moved
into the task's own worktree (FNXC:NodeWorktreeIsolation 2026-07-25-22:10) but never registered that
path in `activeSessionRegistry`. A zero-commit task branch trivially reads as `tip-already-merged`
(its tip IS the integration ref), so the self-owned-branch reclaim sweep selected it, and its
FN-4819 liveness guard — `activeSessionRegistry.isPathActive(task.worktree)` — could not see the
live planner. `git worktree remove --force` then failed against the in-use worktree and the outer
catch escalated to `branch-conflict-unrecoverable`.

Surface enumeration (the invariant is "a planner holding a worktree is a visible live session",
not merely "FN-8600 stops pausing"):
 - registers the acquired worktree for the life of the planning run, with kind "planning" and the
   owning task id, so EVERY isPathActive-keyed guard sees it — not just the reclaim sweep;
 - releases it on the success path;
 - releases it when planning throws, since a leaked entry would permanently veto legitimate cleanup
   of that worktree (the inverse stall);
 - does NOT register when planning falls back to the shared root checkout, which is the operator's
   tree and must never be marked task-owned.
*/

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({
  reviewStep: vi.fn(),
}));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    createFnAgent: mockCreateFnAgent,
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: mockPromptWithFallback,
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

const ROOT_DIR = "/tmp/fn-8600-root";
const PLANNING_WORKTREE = "/tmp/fn-8600-root/.worktrees/amber-stone";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8600",
    description: "Add ability to favorite projects on mobile",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-26T15:37:52.786Z",
    updatedAt: "2026-07-26T15:37:52.786Z",
    ...overrides,
  };
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue({ ...task, prompt: "", attachments: [], comments: [] } as TaskDetail),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 12,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
}

/**
 * Runs a planning session, invoking `duringSession` while the agent session is live.
 * The observation point is `promptWithFallback` — triage drives the planner through it rather than
 * calling `session.prompt` directly, so that is where "the session is running" is true.
 */
function stubAgentSession(duringSession: () => void, opts: { throwInSession?: boolean } = {}): void {
  mockCreateFnAgent.mockImplementationOnce(async () => ({
    session: {
      state: {},
      sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      navigateTree: vi.fn(),
    },
  }));
  mockPromptWithFallback.mockImplementationOnce(async () => {
    duringSession();
    if (opts.throwInSession) throw new Error("planner blew up");
  });
}

describe("planning session worktree registration (FN-8600)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessionRegistry.unregisterPath(PLANNING_WORKTREE);
    activeSessionRegistry.unregisterPath(ROOT_DIR);
  });

  it("marks the planning worktree active for the life of the session, then releases it", async () => {
    const task = createTask();
    const store = createStore(task);
    let activeDuringSession: boolean | undefined;
    let recordDuringSession: { taskId: string; kind: string } | undefined;

    stubAgentSession(() => {
      activeDuringSession = activeSessionRegistry.isPathActive(PLANNING_WORKTREE);
      const record = activeSessionRegistry.lookupByPath(PLANNING_WORKTREE);
      recordDuringSession = record ? { taskId: record.taskId, kind: record.kind } : undefined;
    });

    await new TriageProcessor(store, ROOT_DIR, {
      acquirePlanningWorktree: async () => PLANNING_WORKTREE,
    }).specifyTask(task);

    // The exact condition the self-healing reclaim sweep consults before removing a worktree.
    expect(activeDuringSession).toBe(true);
    expect(recordDuringSession).toEqual({ taskId: "FN-8600", kind: "planning" });
    // And it must not outlive the run, or it would veto all later cleanup of that path.
    expect(activeSessionRegistry.isPathActive(PLANNING_WORKTREE)).toBe(false);
  });

  it("releases the planning worktree when the planning session fails", async () => {
    const task = createTask({ id: "FN-8600-FAIL" });
    const store = createStore(task);
    let activeDuringSession: boolean | undefined;

    stubAgentSession(() => {
      activeDuringSession = activeSessionRegistry.isPathActive(PLANNING_WORKTREE);
    }, { throwInSession: true });

    await new TriageProcessor(store, ROOT_DIR, {
      acquirePlanningWorktree: async () => PLANNING_WORKTREE,
    }).specifyTask(task);

    expect(activeDuringSession).toBe(true);
    expect(activeSessionRegistry.isPathActive(PLANNING_WORKTREE)).toBe(false);
  });

  /*
  FNXC:NodeWorktreeIsolation 2026-07-26-10:20:
  The teardown must not clear a LIVE executor entry. `finalizeApprovedTask` moves the card to `todo`
  while planning is still unwinding, so the scheduler can dispatch and the executor can register the
  same worktree path (same task => `registerPath` overwrites) before planning's `finally` runs. A
  bare path delete there would make `isPathActive` false under a live executor and hand the reclaim
  sweep the same worktree it tore out from under a planner in FN-8600 — the fix reintroducing its
  own symptom one lane over.
  */
  it("leaves a live executor registration on the same path intact when planning unwinds", async () => {
    const task = createTask({ id: "FN-8600-HANDOFF" });
    const store = createStore(task);

    stubAgentSession(() => {
      // Simulate the planning->execution handoff landing mid-teardown: the executor takes over the
      // very same worktree path for the very same task.
      activeSessionRegistry.registerPath(PLANNING_WORKTREE, {
        taskId: "FN-8600-HANDOFF",
        kind: "executor",
        ownerKey: "FN-8600-HANDOFF",
      });
    });

    await new TriageProcessor(store, ROOT_DIR, {
      acquirePlanningWorktree: async () => PLANNING_WORKTREE,
    }).specifyTask(task);

    // The executor's session must survive planning's finally, or the reclaim sweep removes its tree.
    expect(activeSessionRegistry.isPathActive(PLANNING_WORKTREE)).toBe(true);
    expect(activeSessionRegistry.lookupByPath(PLANNING_WORKTREE)?.kind).toBe("executor");
    activeSessionRegistry.unregisterPath(PLANNING_WORKTREE);
  });

  /*
  FNXC:NodeWorktreeIsolation 2026-07-26-10:15:
  The consuming guard is the point of the fix. `SelfHealingManager`'s self-owned-branch reclaim sweep
  defers on the kind-agnostic predicate `activeSessionRegistry.isPathActive(task.worktree)`
  (self-healing.ts, "deferring reclaim for"). Pinning that predicate against the "planning" kind is
  what proves a live planner is now visible to it — and to the other liveness-keyed sweeps that share
  the same predicate — rather than only proving that triage wrote a record.
  */
  it("makes a live planner satisfy the kind-agnostic liveness predicate the reclaim sweep defers on", async () => {
    const task = createTask({ id: "FN-8600-GUARD" });
    const store = createStore(task);
    let guardDuringSession: boolean | undefined;

    stubAgentSession(() => {
      guardDuringSession = activeSessionRegistry.isPathActive(PLANNING_WORKTREE);
    });

    await new TriageProcessor(store, ROOT_DIR, {
      acquirePlanningWorktree: async () => PLANNING_WORKTREE,
    }).specifyTask(task);

    expect(guardDuringSession).toBe(true);
    expect(activeSessionRegistry.isPathActive(PLANNING_WORKTREE)).toBe(false);
  });

  it("falls back to the shared checkout when a live foreign task holds the planning worktree", async () => {
    const task = createTask({ id: "FN-8600-CONTENDED" });
    const store = createStore(task);
    // A different, live task already owns the path.
    activeSessionRegistry.registerPath(PLANNING_WORKTREE, {
      taskId: "FN-OTHER",
      kind: "executor",
      ownerKey: "FN-OTHER",
    });
    let cwdDuringSession: string | undefined;

    mockCreateFnAgent.mockImplementationOnce(async (opts: { cwd?: string }) => {
      cwdDuringSession = opts.cwd;
      return {
        session: {
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });
    mockPromptWithFallback.mockImplementationOnce(async () => undefined);

    await new TriageProcessor(store, ROOT_DIR, {
      acquirePlanningWorktree: async () => PLANNING_WORKTREE,
    }).specifyTask(task);

    // Planning must not run inside a worktree a live foreign session owns...
    expect(cwdDuringSession).toBe(ROOT_DIR);
    // ...and must not have disturbed that session's registration on the way out.
    expect(activeSessionRegistry.lookupByPath(PLANNING_WORKTREE)?.taskId).toBe("FN-OTHER");
    activeSessionRegistry.unregisterPath(PLANNING_WORKTREE);
  });

  it("never marks the shared root checkout as a task-owned session", async () => {
    const task = createTask({ id: "FN-8600-SHARED" });
    const store = createStore(task);
    let rootActiveDuringSession: boolean | undefined;

    stubAgentSession(() => {
      rootActiveDuringSession = activeSessionRegistry.isPathActive(ROOT_DIR);
    });

    // No worktree available: planning falls back to the operator's checkout.
    await new TriageProcessor(store, ROOT_DIR, {
      acquirePlanningWorktree: async () => null,
    }).specifyTask(task);

    expect(rootActiveDuringSession).toBe(false);
    expect(activeSessionRegistry.isPathActive(ROOT_DIR)).toBe(false);
  });
});
