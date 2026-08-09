/*
FNXC:WorktreeCapacity 2026-08-01-04:38:
PLANNING ADMISSION'S WORKTREE LEDGER COUNTS LIVE TASKS BY ROLE, NOT RETAINED DIRECTORIES.

The worktree cap limits simultaneous task activity. Planning, WIP, and live review sessions count;
queued, paused, dependency-blocked, and terminal cards do not count even when their worktree path is
retained for reuse or cleanup. The canonical running-agent predicate resolves renamed workflow roles
before making that decision.

WHY THIS FILE RATHER THAN A CASE IN `triage-plan-admission-throttle-audit.test.ts`: that suite's
fixture deliberately exhausts `maxConcurrent` (1 slot, consumed by a running card) so the AGENT gate
binds. The agent gate is checked with the worktree gate via `Math.min`, so an exhausted agent count
masks the worktree answer entirely — the conversion under test would never decide anything. This
fixture leaves agent headroom so the worktree ledger is the only gate that can bind.

The assertion is the run-audit event, not a return value: `task:plan-admission-throttled` is what
the withhold path DOES, and it names the binding gate. A boolean "did anything start" would also be
satisfied by an unrelated early return.
*/

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { TriageProcessor } from "../triage.js";
import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

/** Hold lane `drafting`, wip `building`, complete `shipped`, archive `filed`. No legacy ids. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
  ],
};

interface RecordedEvent { type: string; target: string; metadata?: Record<string, unknown> }

function task(id: string, column: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    description: "Add ability to favorite projects on mobile",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-26T15:37:52.786Z",
    updatedAt: "2026-07-26T15:37:52.786Z",
    ...extra,
  } as Task;
}

/**
 * `maxConcurrent` is generous on purpose — admission takes `min(projectRoom, worktreeRoom)`, so an
 * exhausted agent count would mask the ledger this file is about.
 */
function createStore(
  tasks: Task[],
  recorded: RecordedEvent[],
  maxWorktrees: number,
  worktreeLimitEnabled: boolean = true,
): TaskStore {
  return {
    getTask: vi.fn(async (id: string) => {
      const found = tasks.find((candidate) => candidate.id === id);
      return found ? { ...found, prompt: "", attachments: [], comments: [] } : null;
    }),
    listTasks: vi.fn(async (options?: { slim?: boolean }) => options?.slim === true
      ? tasks.map(({ workflowStepResults: _omitted, ...candidate }) => candidate as Task)
      : tasks),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 20,
      maxWorktrees,
      worktreeLimitEnabled,
      pollIntervalMs: 600_000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; target: string; metadata?: Record<string, unknown> }) => {
      recorded.push({ type: event.mutationType, target: event.target, metadata: event.metadata });
    }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn(),
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    updateSettings: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    /*
    The candidate scan resolves each task's OWN workflow (`resolveWorkflowIrForTask`), which reads
    the SELECTION — not `listWorkflowDefinitions`. Omitting these makes every card fall back to the
    DEFAULT board, where `drafting` is not a hold lane, so nothing is eligible, nothing throttles,
    and the absence assertion below passes for the wrong reason. Caught by the paired positive.
    */
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-renamed", stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-renamed", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: RENAMED_IR })),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
}

async function pollOnce(store: TaskStore): Promise<ReturnType<typeof vi.fn>> {
  const processor = new TriageProcessor(store, "/tmp/fn-admission-renamed-root", {});
  /*
  FNXC:WorktreeCapacity 2026-08-01-04:38:
  Admission is the contract under test; replace the planner body with a narrow seam so a passing
  admission cannot launch a real provider subprocess from this unit test.
  */
  const specifyTask = vi.fn(async () => undefined);
  (processor as unknown as { specifyTask: (task: Task) => Promise<void> }).specifyTask = specifyTask;
  /* poll() no-ops unless running; driving one pass directly keeps this time-independent. */
  (processor as unknown as { running: boolean }).running = true;
  await (processor as unknown as { poll: () => Promise<void> }).poll();
  /* The audit write is fire-and-forget. */
  await new Promise((resolve) => setImmediate(resolve));
  processor.stop();
  for (const [admitted] of specifyTask.mock.calls) {
    projectAdmissionCoordinator.releaseReservation((admitted as Task).id);
  }
  return specifyTask;
}

describe("planning admission's worktree ledger on a renamed board", () => {
  let recorded: RecordedEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    recorded = [];
  });

  it("does not count a card in a RENAMED complete lane against the worktree budget", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
      /* Finished work whose worktree is cleanup-owned, not capacity. */
      task("FN-SHIPPED", "shipped", { worktree: "/tmp/wt-shipped" }),
    ], recorded, 1);

    const specifyTask = await pollOnce(store);

    /* Against the literals `shipped` is counted, worktreeRoom is 0, and admission is withheld. */
    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle, "a finished card must not consume a worktree slot").toHaveLength(0);
    expect(specifyTask).toHaveBeenCalledOnce();
    expect(specifyTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-WAITING" }));
  });

  it("does not count an inactive retained worktree against planning capacity", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
      task("FN-PARKED", "drafting", {
        worktree: "/tmp/wt-parked",
        status: "queued",
        paused: true,
      }),
    ], recorded, 1);

    const specifyTask = await pollOnce(store);

    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle, "an inactive retained directory must not consume a live-task slot").toHaveLength(0);
    expect(specifyTask).toHaveBeenCalledOnce();
    expect(specifyTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-WAITING" }));
  });

  it("keeps the planning worktree gate inert when the limit is disabled", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
    ], recorded, 0, false);

    const specifyTask = await pollOnce(store);

    expect(recorded.filter((event) => event.type === "task:plan-admission-throttled")).toHaveLength(0);
    expect(specifyTask).toHaveBeenCalledOnce();
  });

  it("admits only one planner when one active-task worktree slot remains", async () => {
    const store = createStore([
      task("FN-WAITING-1", "drafting"),
      task("FN-WAITING-2", "drafting"),
    ], recorded, 1);

    const specifyTask = await pollOnce(store);

    expect(specifyTask).toHaveBeenCalledOnce();
    expect(specifyTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-WAITING-1" }));
  });

  /*
  THE PAIRED POSITIVE. The absence cases would also pass if maxWorktrees were ignored entirely. This
  pins that the same renamed board still withholds when a task is genuinely live, so the inactive
  cases measure liveness rather than a dead gate.
  */
  it("still withholds when a card in a live RENAMED lane holds the last worktree", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
      task("FN-LIVE", "building", { worktree: "/tmp/wt-live" }),
    ], recorded, 1);

    const specifyTask = await pollOnce(store);

    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle.length, "a live task must still consume its worktree-capacity slot").toBeGreaterThan(0);
    expect(specifyTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-WAITING",
      expect.stringContaining("maxWorktrees capacity exhausted: used=1/1"),
    );
  });

  it("counts a pending optional workflow-step lease in final planning admission", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
      task("FN-LIVE-REVIEW", "drafting", {
        steps: [{ name: "Implementation", status: "pending" }] as Task["steps"],
        workflowStepResults: [{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          phase: "pre-merge",
          source: "optional-group",
          status: "pending",
          startedAt: "2026-08-01T00:00:00.000Z",
        }],
      }),
    ], recorded, 1);

    const specifyTask = await pollOnce(store);

    expect(store.listTasks).toHaveBeenCalledWith({ slim: false, includeArchived: false });
    expect(specifyTask).not.toHaveBeenCalled();
  });
});
