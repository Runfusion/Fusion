import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransitionRejection, TransitionRejectionError, buildBootstrapPrompt, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Scheduler } from "../scheduler.js";
import { AgentSemaphore } from "../concurrency/concurrency.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

/*
FNXC:PlanReviewStep 2026-07-26-17:10:
The default workflow is plan-in-place: a `todo` card releases only after Plan Review passed, so these
scheduler fixtures model a card that already cleared the gate (the state every real card is in when
the capacity sweep sees it). Holding an unreviewed card is the gate working — that path is owned by
`pre-release-plan-review.test.ts`.
*/
const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    title: "Workflow task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [PASSED_PLAN_REVIEW],
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function storeWith(
  tasks: Task[],
  settings: Record<string, unknown> = {},
  workflows: { selections?: Record<string, string>; definitions?: Record<string, WorkflowIr> } = {},
): TaskStore {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const current = byId.get(id);
    if (current) Object.assign(current, patch);
    return current as Task;
  });
  const logEntry = vi.fn(async () => undefined);
  return {
    listTasks: vi.fn(async () => [...byId.values()]),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
      experimentalFeatures: { workflowColumns: false },
      ...settings,
    })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ ...settings, ...patch })),
    updateTask,
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = byId.get(id);
      if (current) current.column = column;
      return current as Task;
    }),
    moveTaskIf: vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>) => {
      const current = byId.get(id)!;
      if (!await predicate(current) || current.column === column) return { task: current, moved: false };
      current.column = column;
      return { task: current, moved: true };
    }),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    logEntry,
    transitionQueuedEpisode: vi.fn(async (id: string, transition: { signature: string; blockedBy: string | null; overlapBlockedBy: string | null; action: string }) => {
      const current = byId.get(id)!;
      const appended = !(current.status === "queued"
        && (current.blockedBy ?? null) === transition.blockedBy
        && (current.overlapBlockedBy ?? null) === transition.overlapBlockedBy
        && current.queuedLogEpisodeSignature === transition.signature);
      await updateTask(id, {
        status: "queued",
        blockedBy: transition.blockedBy,
        overlapBlockedBy: transition.overlapBlockedBy,
        queuedLogEpisodeSignature: transition.signature,
      });
      if (appended) await logEntry(id, transition.action);
      return { appended, task: current };
    }),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    renewSymbolLocks: vi.fn(async () => ({ renewed: [], lost: [] })),
    getMissionStore: vi.fn(() => ({
      listMissions: () => [],
      listGoalIdsForMission: () => [],
    })),
    getTaskWorkflowSelection: vi.fn((id: string) => {
      const workflowId = workflows.selections?.[id];
      return workflowId ? { workflowId, stepIds: [] } : undefined;
    }),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      const ir = workflows.definitions?.[id];
      return ir ? { ir } : undefined;
    }),
  } as unknown as TaskStore;
}

describe("Scheduler workflow cutover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nBody");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the engine active heartbeat at most once per poll interval and skips while paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00.000Z"));
    const store = storeWith([], { pollIntervalMs: 15_000 });
    const scheduler = new Scheduler(store, { onSchedule: vi.fn() });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();
    expect(store.updateSettings).toHaveBeenCalledTimes(1);
    expect(store.updateSettings).toHaveBeenCalledWith({ engineLastActiveAt: "2026-06-25T00:00:00.000Z" });

    vi.setSystemTime(new Date("2026-06-25T00:00:15.000Z"));
    await scheduler.schedule();
    expect(store.updateSettings).toHaveBeenCalledTimes(2);

    vi.mocked(store.getSettings).mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000, enginePaused: true } as any);
    vi.setSystemTime(new Date("2026-06-25T00:00:30.000Z"));
    await scheduler.schedule();
    expect(store.updateSettings).toHaveBeenCalledTimes(2);
  });

  it("renews active mission symbol locks before their short admission lease expires", async () => {
    const active = task({
      id: "FN-symbol-owner",
      column: "in-progress",
      missionId: "M-1",
      sliceId: "SL-1",
      declaredSymbols: ["pkg/a.ts#A"],
    });
    const store = storeWith([active]);
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.renewSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#A"], "FN-symbol-owner", 10 * 60_000);
  });

  /*
  FNXC:EngineDiagnostics 2026-08-10-17:13:
  Renewal runs every poll, and a LOST lock never recovers by renewing — the same `lost` set comes back on every
  subsequent pass. Reporting it per poll spammed the log pane AND appended an identical activityLog row forever for a
  stuck task. Assert the transition contract: report once per distinct lost set, again when the set CHANGES, and once
  more after a clean renewal clears the memo — with the `logEntry` write gated on the same decision.
  */
  it("reports a persistently lost symbol lock once per distinct loss, not once per poll", async () => {
    const active = task({
      id: "FN-symbol-owner",
      column: "in-progress",
      missionId: "M-1",
      sliceId: "SL-1",
      declaredSymbols: ["pkg/a.ts#A"],
    });
    const store = storeWith([active]);
    vi.mocked(store.renewSymbolLocks).mockResolvedValue({ renewed: [], lost: ["pkg/a.ts#A"] } as any);
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();
    await scheduler.schedule();

    const lossEntries = () => vi.mocked(store.logEntry).mock.calls.filter((call) => String(call[1]).startsWith("symbol-lock renewal lost"));
    expect(lossEntries()).toHaveLength(1);

    // A different lost set is a real transition and reports again.
    vi.mocked(store.renewSymbolLocks).mockResolvedValue({ renewed: [], lost: ["pkg/a.ts#A", "pkg/b.ts#B"] } as any);
    await scheduler.schedule();
    await scheduler.schedule();
    expect(lossEntries()).toHaveLength(2);

    // A clean renewal clears the memo, so a later loss is reported afresh.
    vi.mocked(store.renewSymbolLocks).mockResolvedValue({ renewed: ["pkg/a.ts#A"], lost: [] } as any);
    await scheduler.schedule();
    vi.mocked(store.renewSymbolLocks).mockResolvedValue({ renewed: [], lost: ["pkg/a.ts#A", "pkg/b.ts#B"] } as any);
    await scheduler.schedule();
    expect(lossEntries()).toHaveLength(3);
  });

  it("renews locks in a custom workflow WIP column", async () => {
    const active = task({
      id: "FN-custom-symbol-owner",
      column: "implementing",
      missionId: "M-1",
      sliceId: "SL-1",
      declaredSymbols: ["pkg/a.ts#A"],
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "custom-wip",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "hold" }] },
        { id: "implementing", name: "Implementing", traits: [{ trait: "wip", config: { limit: 1 } }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [],
      edges: [],
    } as WorkflowIr;
    const store = storeWith([active], {}, {
      selections: { "FN-custom-symbol-owner": "custom:wip" },
      definitions: { "custom:wip": workflow },
    });
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.renewSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#A"], "FN-custom-symbol-owner", 10 * 60_000);
  });

  it("uses the workflow sweep for todo pickup even when stale workflowColumns=false is persisted", async () => {
    const ready = task({ id: "FN-100" });
    const store = storeWith([ready]);
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-100", "in-progress", expect.any(Function), expect.objectContaining({
      moveSource: "scheduler",
      allocateWorktree: expect.any(Function),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-100", expect.objectContaining({
      status: null,
      blockedBy: null,
      mergeRetries: 0,
      effectiveNodeId: null,
      effectiveNodeSource: "local",
    }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-100", column: "in-progress" }));
  });

  it("does not dispatch an operator-parked todo task when only userPaused remains true", async () => {
    const parked = task({ id: "FN-PAUSED", paused: false, userPaused: true });
    const store = storeWith([parked]);
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(onSchedule).not.toHaveBeenCalled();
    expect(parked.column).toBe("todo");
  });

  it("does not dispatch when an operator sets userPaused after the queue snapshot", async () => {
    const ready = task({ id: "FN-CONCURRENT-PAUSE", paused: false, userPaused: false });
    const store = storeWith([ready]);
    vi.mocked(store.getTask).mockResolvedValue({ ...ready, userPaused: true });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });

  it("does not dispatch when userPaused wins the atomic move race", async () => {
    const ready = task({ id: "FN-ATOMIC-PAUSE", paused: false, userPaused: false });
    const store = storeWith([ready]);
    vi.mocked(store.moveTaskIf).mockImplementation(async (_id, _column, predicate) => {
      ready.userPaused = true;
      return { task: ready, moved: await predicate(ready) };
    });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalled();
    expect(ready.column).toBe("todo");
    expect(onSchedule).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowScheduling 2026-07-07-00:00:
  FN-7648 regression: a custom workflow's intake column can be renamed away from
  the literal "todo" id (e.g. `ideas`). An unplanned card resting there (still
  carrying the bootstrap-stub PROMPT.md) must stay held — the `reserveSlot`
  guard used to be keyed on `task.column === "todo"` and silently released this
  kind of card straight into `in-progress`.
  */
  it("FN-7648: keeps an unplanned card in a renamed custom intake column held instead of releasing it", async () => {
    const unplanned = task({ id: "FN-300", column: "ideas" });
    const renamedIntakeIr: WorkflowIr = {
      version: "v2",
      name: "renamed-intake",
      columns: [
        { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limit: 5 } }] },
        { id: "done", name: "done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "ideas" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute", prompt: "Do the work" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "execute", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    const store = storeWith([unplanned], {}, {
      selections: { "FN-300": "custom:renamed-intake" },
      definitions: { "custom:renamed-intake": renamedIntakeIr },
    });
    vi.mocked(readFile).mockImplementation(async () => buildBootstrapPrompt("FN-300", unplanned.title, unplanned.description));
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-300", "in-progress", expect.anything(), expect.anything());
    expect(unplanned.column).toBe("ideas");
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-300" }));
  });

  it("passes worktree naming and directory settings to the workflow release allocator", async () => {
    const ready = task({ id: "FN-102" });
    const store = storeWith([ready], {
      worktreeNaming: "task-id",
      worktreesDir: "custom-worktrees",
    });
    const scheduler = new Scheduler(store, { onSchedule: vi.fn() });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    const moveOptions = vi.mocked(store.moveTaskIf).mock.calls[0]?.[3] as {
      allocateWorktree?: (reservedNames: Set<string>) => string | null;
    };
    expect(moveOptions.allocateWorktree?.(new Set())).toBe("/tmp/project/custom-worktrees/fn-102");
  });

  it("continues executor handoff for all released tasks when post-release metadata or logs fail", async () => {
    const first = task({ id: "FN-201", status: "queued" });
    const second = task({ id: "FN-202", status: "queued" });
    const store = storeWith([first, second], { maxConcurrent: 4, maxWorktrees: 4 });
    const updateImpl = vi.mocked(store.updateTask).getMockImplementation()!;
    vi.mocked(store.updateTask).mockImplementation(async (id, patch) => {
      if (id === "FN-201" && "lastDispatchAt" in patch) {
        throw new Error("metadata write failed");
      }
      return updateImpl(id, patch);
    });
    vi.mocked(store.logEntry).mockImplementation(async (id, message) => {
      if (id === "FN-201" && message.startsWith("Node routing resolved")) {
        throw new Error("log write failed");
      }
    });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "FN-201",
      column: "in-progress",
      status: undefined,
      effectiveNodeSource: "local",
    }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "FN-202",
      column: "in-progress",
      status: undefined,
      effectiveNodeSource: "local",
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-202", expect.objectContaining({
      status: null,
      effectiveNodeSource: "local",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-202",
      "Node routing resolved: local (source: local)",
    );
  });

  it("keeps dependency-blocked todo tasks queued on the workflow sweep path", async () => {
    const blocker = task({ id: "FN-001", column: "todo" });
    const dependent = task({ id: "FN-002", dependencies: ["FN-001"] });
    const store = storeWith([blocker, dependent]);
    const onBlocked = vi.fn();
    const scheduler = new Scheduler(store, { onBlocked });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-002", {
      signature: "dependency:FN-001",
      blockedBy: "FN-001",
      overlapBlockedBy: null,
      action: "queued — unmet dependencies: FN-001",
    });
    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything(), expect.anything());
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }), ["FN-001"]);
  });

  it("clears a stale overlap blocker while preserving an unfinished dependency", async () => {
    const blocker = task({ id: "FN-001", column: "in-progress", paused: true, userPaused: true });
    const dependent = task({
      id: "FN-002",
      dependencies: ["FN-001"],
      status: "queued",
      blockedBy: "FN-001",
      overlapBlockedBy: "FN-001",
    });
    const store = storeWith([blocker, dependent], { groupOverlappingFiles: true });
    vi.mocked(store.parseFileScopeFromPrompt).mockResolvedValue(["packages/engine/src/scheduler.ts"]);
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-002", {
      signature: "dependency:FN-001",
      blockedBy: "FN-001",
      overlapBlockedBy: null,
      action: "queued — unmet dependencies: FN-001",
    });
  });

  it("derives an active overlapping lease while the dependency remains unfinished", async () => {
    const blocker = task({ id: "FN-001", column: "in-progress" });
    const dependent = task({
      id: "FN-002",
      dependencies: ["FN-001"],
      status: "queued",
      blockedBy: "FN-001",
    });
    const store = storeWith([blocker, dependent], { groupOverlappingFiles: true });
    vi.mocked(store.parseFileScopeFromPrompt).mockImplementation(async (id) => (
      id === "FN-001" || id === "FN-002" ? ["packages/engine/src/scheduler.ts"] : []
    ));
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-002", {
      signature: "dependency:FN-001",
      blockedBy: "FN-001",
      overlapBlockedBy: "FN-001",
      action: "queued — unmet dependencies: FN-001",
    });
  });

  it("clears an active but non-overlapping lease while preserving an unfinished dependency", async () => {
    const blocker = task({ id: "FN-001", column: "in-progress" });
    const dependent = task({
      id: "FN-002",
      dependencies: ["FN-001"],
      status: "queued",
      blockedBy: "FN-001",
      overlapBlockedBy: "FN-001",
    });
    const store = storeWith([blocker, dependent], { groupOverlappingFiles: true });
    vi.mocked(store.parseFileScopeFromPrompt).mockImplementation(async (id) => (
      id === "FN-001" ? ["packages/core/src/store.ts"] : ["packages/engine/src/scheduler.ts"]
    ));
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-002", {
      signature: "dependency:FN-001",
      blockedBy: "FN-001",
      overlapBlockedBy: null,
      action: "queued — unmet dependencies: FN-001",
    });
  });

  it("keeps scheduling after a dependency-blocked task file scope cannot be read", async () => {
    const blocker = task({ id: "FN-001", column: "in-progress" });
    const dependent = task({
      id: "FN-002",
      dependencies: ["FN-001"],
      status: "queued",
      blockedBy: "FN-001",
      overlapBlockedBy: "FN-001",
      priority: "urgent",
    });
    const ready = task({ id: "FN-003", priority: "normal" });
    const store = storeWith([blocker, dependent, ready], { groupOverlappingFiles: true });
    vi.mocked(store.parseFileScopeFromPrompt).mockImplementation(async (id) => {
      if (id === "FN-002") throw new Error("scope read failed");
      return id === "FN-001" ? ["packages/engine/src/scheduler.ts"] : ["packages/core/src/store.ts"];
    });
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-002", {
      signature: "dependency:FN-001",
      blockedBy: "FN-001",
      overlapBlockedBy: null,
      action: "queued — unmet dependencies: FN-001",
    });
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-003", "in-progress", expect.anything(), expect.anything());
  });

  it("does not clear status or release work when maxConcurrent is full", async () => {
    const active = task({ id: "FN-001", column: "in-progress" });
    const ready = task({ id: "FN-002", status: "queued", worktree: "/tmp/project/.worktrees/fn-002" });
    const store = storeWith([active, ready], { maxConcurrent: 1, maxWorktrees: 4 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything(), expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }));
    expect(ready.column).toBe("todo");
  });

  it("does not clear status or release work when maxWorktrees is full", async () => {
    const active = task({ id: "FN-001", column: "in-progress" });
    const ready = task({ id: "FN-002", status: "queued" });
    const store = storeWith([active, ready], { maxConcurrent: 4, maxWorktrees: 1 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything(), expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      expect.stringContaining("gate=maxWorktrees; maxConcurrent used=1/4"),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      expect.stringContaining("maxWorktrees used=1/1"),
    );
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }));
    expect(ready.column).toBe("todo");
  });

  it("does not release work when already over maxWorktrees even if maxConcurrent has slack", async () => {
    const active = Array.from({ length: 5 }, (_, index) => task({ id: `FN-10${index}`, column: "in-progress" }));
    const ready = task({ id: "FN-200", status: "queued" });
    const store = storeWith([...active, ready], { maxConcurrent: 10, maxWorktrees: 4 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-200", "in-progress", expect.anything(), expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-200",
      expect.stringContaining("gate=maxWorktrees; maxConcurrent used=5/10"),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-200",
      expect.stringContaining("maxWorktrees used=5/4"),
    );
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });

  it("does not let a retained directory bypass a full active-task worktree cap", async () => {
    const active = task({ id: "FN-101", column: "in-progress", worktree: "/tmp/project/.worktrees/fn-101" });
    const ready = task({ id: "FN-200", status: "queued", worktree: "/tmp/project/.worktrees/fn-200" });
    const store = storeWith([active, ready], { maxConcurrent: 4, maxWorktrees: 1 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-200", "in-progress", expect.anything(), expect.anything());
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("counts only active tasks when retained queued worktrees would strand execution slots", async () => {
    /*
    FNXC:WorktreeCapacity 2026-08-01-04:38:
    Live regression: seven active tasks plus two dependency-blocked queued cards with retained
    worktrees filled a nine-slot ledger. The inactive holders then blocked both dependency-free
    roots from starting. Slots represent live task execution, not directories retained on disk.
    */
    const planners = Array.from({ length: 6 }, (_, index) => task({
      id: `FN-PLAN-${index}`,
      status: "planning",
      worktree: `/tmp/project/.worktrees/plan-${index}`,
    }));
    const executing = task({
      id: "FN-EXECUTING",
      column: "in-progress",
      worktree: "/tmp/project/.worktrees/executing",
    });
    const parkedDependents = [
      task({ id: "FN-PARKED-1", status: "queued", worktree: "/tmp/project/.worktrees/parked-1", dependencies: ["FN-ROOT-1"] }),
      task({ id: "FN-PARKED-2", status: "queued", worktree: "/tmp/project/.worktrees/parked-2", dependencies: ["FN-ROOT-1"] }),
    ];
    const roots = [
      task({ id: "FN-ROOT-1", status: "queued" }),
      task({ id: "FN-ROOT-2", status: "queued" }),
      task({ id: "FN-ROOT-3", status: "queued" }),
    ];
    const store = storeWith([...planners, executing, ...parkedDependents, ...roots], {
      maxConcurrent: 12,
      maxWorktrees: 9,
    });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-ROOT-1", column: "in-progress" }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-ROOT-2", column: "in-progress" }));
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-ROOT-3" }));
    expect(roots[2]?.column).toBe("todo");
  });

  /*
  FNXC:CapacityModel 2026-07-28-12:10:
  WORKTREES OFF → "limit via total agents only". These three cases are the proof
  that maxWorktrees is genuinely INERT rather than merely generous, and they use
  the SAME fixture as the two maxWorktrees tests above (5 in-progress, limit 4)
  which are proven to BLOCK — so a regression that quietly re-enables the worktree
  gate flips these red while those stay green, and vice versa.

  "Inert" is asserted three ways because "set very high" and "skipped by
  convention" both pass a naive does-it-dispatch check:
    1. the card actually releases where worktrees-on blocks it;
    2. maxWorktrees is absent from everything the operator reads — with worktrees
       on this same fixture logs "gate=maxWorktrees; ... used=5/4";
    3. an ABSURD maxWorktrees (0 — the value that DEADLOCKS the board when
       worktrees are on, because `used >= 0` holds on an empty board) changes
       nothing, proving the value is never consulted rather than merely large.

  Note on (2): a maxWorktrees-named queued reason is structurally UNREACHABLE in
  OFF mode, so this asserts absence rather than a rewritten string. Measured, not
  assumed — when maxConcurrent is the binding gate the sweep bails before the
  per-task reason and logs nothing at all (the pre-existing "maxConcurrent is
  full" test above likewise asserts no log line). Only maxWorktrees or the
  semaphore binding produces that string, and OFF mode removes the first.
  */
  it("worktrees off: releases despite being far over maxWorktrees (agents-only capacity)", async () => {
    const active = Array.from({ length: 5 }, (_, index) => task({ id: `FN-10${index}`, column: "in-progress" }));
    const ready = task({ id: "FN-200", status: "queued" });
    const store = storeWith([...active, ready], {
      maxConcurrent: 10,
      maxWorktrees: 4,
      worktreeLimitEnabled: false,
    });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    // 5 > 4 would have bound the worktree gate; with worktrees off only the agent
    // count (5/10) is consulted, so the card releases.
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-200", "in-progress", expect.any(Function), expect.anything());
    expect(onSchedule).toHaveBeenCalledTimes(1);
    // ...and maxWorktrees is never named in anything the operator reads. With
    // worktrees on, this exact fixture logs "gate=maxWorktrees; ... used=5/4".
    const messages = vi.mocked(store.logEntry).mock.calls.map(([, m]) => String(m));
    expect(messages.some((m) => m.includes("maxWorktrees"))).toBe(false);
  });

  it("worktrees off: maxWorktrees=0 does not deadlock dispatch (the value is never read)", async () => {
    // 0 is the value that makes the ON path refuse every release (`used >= 0` is
    // true on an empty board). If anything still consulted the limit, this would
    // dispatch nothing.
    const ready = task({ id: "FN-700", status: "queued" });
    const store = storeWith([ready], {
      maxConcurrent: 4,
      maxWorktrees: 0,
      worktreeLimitEnabled: false,
    });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-700", "in-progress", expect.any(Function), expect.anything());
    expect(onSchedule).toHaveBeenCalledTimes(1);
  });

  it("releases one ready task when maxWorktrees has exactly one remaining slot and maxConcurrent is higher", async () => {
    const active = Array.from({ length: 3 }, (_, index) => task({ id: `FN-30${index}`, column: "in-progress" }));
    const first = task({ id: "FN-401", status: "queued" });
    const second = task({ id: "FN-402", status: "queued" });
    const store = storeWith([...active, first, second], { maxConcurrent: 10, maxWorktrees: 4 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-401", "in-progress", expect.any(Function), expect.anything());
    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-402", "in-progress", expect.anything(), expect.anything());
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-402",
      expect.stringContaining("gate=maxWorktrees; maxConcurrent used=4/10"),
    );
    expect(onSchedule).toHaveBeenCalledTimes(1);
  });

  it("reserves same-sweep capacity so only one ready task is released into one slot", async () => {
    const first = task({ id: "FN-001", status: "queued" });
    const second = task({ id: "FN-002", status: "queued" });
    const store = storeWith([first, second], { maxConcurrent: 1, maxWorktrees: 1 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-001", "in-progress", expect.any(Function), expect.anything());
    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything(), expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001", column: "in-progress" }));
    expect(second.column).toBe("todo");
    expect(second.status).toBe("queued");
  });

  it("rechecks canonical live tasks inside final admission after the sweep snapshot goes stale", async () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task({ id: `FN-ACTIVE-${index}`, column: "in-progress" }),
    );
    const ready = task({ id: "FN-READY", status: "queued" });
    const latePlanner = task({ id: "FN-LATE-PLANNER", status: "planning" });
    const store = storeWith([...active, ready], { maxConcurrent: 12, maxWorktrees: 9 });
    vi.mocked(store.listTasks)
      .mockResolvedValueOnce([...active, ready])
      .mockResolvedValue([...active, latePlanner, ready]);
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.listTasks).toHaveBeenCalledWith({ slim: false, includeArchived: false });
    expect(store.moveTaskIf).not.toHaveBeenCalledWith(
      ready.id,
      "in-progress",
      expect.any(Function),
      expect.anything(),
    );
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
    expect(ready.status).toBe("queued");
  });

  it("counts a pending optional workflow-step lease in final scheduler admission", async () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task({ id: `FN-LEASE-ACTIVE-${index}`, column: "in-progress" }),
    );
    const liveLease = task({
      id: "FN-LIVE-LEASE",
      status: null,
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        source: "optional-group",
        status: "pending",
        startedAt: "2026-08-01T00:00:00.000Z",
      }],
    });
    const ready = task({ id: "FN-READY", status: "queued" });
    const store = storeWith([...active, liveLease, ready], { maxConcurrent: 12, maxWorktrees: 9 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.listTasks).toHaveBeenCalledWith({ slim: false, includeArchived: false });
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });

  it("does not let a stale full sweep hide capacity that freed before final admission", async () => {
    const initiallyActive = Array.from({ length: 9 }, (_, index) =>
      task({ id: `FN-STALE-ACTIVE-${index}`, column: "in-progress" }),
    );
    const ready = task({ id: "FN-READY", status: "queued" });
    const store = storeWith([...initiallyActive, ready], { maxConcurrent: 12, maxWorktrees: 9 });
    vi.mocked(store.listTasks)
      .mockResolvedValueOnce([...initiallyActive, ready])
      .mockResolvedValue(initiallyActive.slice(0, 8).concat(ready));
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.listTasks).toHaveBeenCalledWith({ slim: false, includeArchived: false });
    expect(store.moveTaskIf).toHaveBeenCalledWith(
      ready.id,
      "in-progress",
      expect.any(Function),
      expect.anything(),
    );
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: ready.id }));
  });

  it("leaves a task queued when the authoritative release move rejects after reservation", async () => {
    const ready = task({ id: "FN-002", status: "queued" });
    const store = storeWith([ready], { maxConcurrent: 4, maxWorktrees: 4 });
    vi.mocked(store.moveTaskIf).mockRejectedValueOnce(
      new TransitionRejectionError(
        makeTransitionRejection(
          "capacity-exhausted",
          "transition.rejected.capacityExhausted",
          true,
          "Column is at capacity",
        ),
        "Column is at capacity",
      ),
    );
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-002", "in-progress", expect.any(Function), expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-002",
      expect.stringContaining("Node routing resolved"),
    );
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
    expect(ready.status).toBe("queued");
  });

  it("returns a rejected active-task reservation so the next candidate can start", async () => {
    const retained = task({ id: "FN-001", status: "queued", worktree: "/tmp/project/.worktrees/fn-001" });
    const fresh = task({ id: "FN-002", status: "queued" });
    const store = storeWith([retained, fresh], { maxConcurrent: 4, maxWorktrees: 1 });
    vi.mocked(store.moveTaskIf).mockRejectedValueOnce(
      new TransitionRejectionError(
        makeTransitionRejection(
          "capacity-exhausted",
          "transition.rejected.capacityExhausted",
          true,
          "Column is at capacity",
        ),
        "Column is at capacity",
      ),
    );
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTaskIf).toHaveBeenCalledTimes(2);
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-001", "in-progress", expect.any(Function), expect.anything());
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-002", "in-progress", expect.any(Function), expect.anything());
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002", column: "in-progress" }));
    expect(fresh.column).toBe("in-progress");
  });

  it("does not release work when the shared semaphore is saturated", async () => {
    const ready = task({ id: "FN-002", status: "queued", worktree: "/tmp/project/.worktrees/fn-002" });
    const store = storeWith([ready], { maxConcurrent: 4, maxWorktrees: 4 });
    const semaphore = new AgentSemaphore(1);
    await semaphore.acquire();
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule, semaphore });
    (scheduler as unknown as { running: boolean }).running = true;

    try {
      await scheduler.schedule();
    } finally {
      semaphore.release();
    }

    expect(store.moveTaskIf).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything(), expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });
});
