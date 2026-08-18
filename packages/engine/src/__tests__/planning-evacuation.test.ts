/*
FNXC:PlanningEvacuation 2026-07-25-23:00 (withdrawing a card from planning — regression):
Operator requirement: moving a card from todo to Ideas WHILE it is being planned must stop the
planning session and all engine work on it, and the "planning" badge must disappear. Moving it back to
todo must restart planning. Planning-acquired worktrees must not accumulate on withdrawn cards, and the
background sweep that reclaims them must only touch very old, genuinely idle trees.

Invariant under test:
 1. evacuation to a non-planner column aborts + disposes the triage session and clears the badge;
 2. it does NOT fire for moves within the planner lanes, or for the forward move into execution;
 3. moving back to a planner lane wakes the poll, so planning restarts;
 4. `hasAdvancedPastPlanning` no longer reads a worktree as execution evidence — planning owns one now;
 5. the sweep skips young, active, waiting, and executed tasks, and reclaims only 30-day-idle parked ones.
*/
import { describe, expect, it, vi } from "vitest";
import { ANY_MUTATION_CONTEXT } from "./mutation-context-matchers.js";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { TriageProcessor } from "../triage.js";
import { hasAdvancedPastPlanning } from "../execution/replan-target.js";
import { SelfHealingManager } from "../self-healing.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStore(overrides: Partial<Record<string, unknown>> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

function planningTask(overrides: Partial<Task> = {}): Task {
  return { id: "FN-1403", column: "ideas", status: "planning", ...overrides } as Task;
}

function attachLiveSession(processor: TriageProcessor, taskId: string) {
  const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() };
  (processor as any).activeSessions.set(taskId, session);
  // The token-usage snapshot is unrelated bookkeeping here; stub it so the abort path is isolated.
  vi.spyOn(processor as any, "recordTriageSessionTokenUsageSoon").mockImplementation(() => undefined);
  return session;
}

describe("withdrawing a card from planning", () => {
  it("aborts the planning session and clears the planning badge when moved to ideas", () => {
    const store = makeStore();
    const processor = new TriageProcessor(store, "/tmp/test");
    const session = attachLiveSession(processor, "FN-1403");

    (processor as any).taskEvacuatedFromPlanningHandler(planningTask());

    expect(session.abort).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect((processor as any).activeSessions.has("FN-1403")).toBe(false);
    // The badge is `status: "planning"` — clearing it is what makes the card read as a plain idea.
    expect(store.updateTask).toHaveBeenCalledWith("FN-1403", { status: null }, ANY_MUTATION_CONTEXT);
  });

  it.each([
    ["todo", "todo"],
    ["triage", "triage"],
    ["in-progress (forward into execution)", "in-progress"],
  ])("does not abort planning for a move to %s", (_label, column) => {
    const store = makeStore();
    const processor = new TriageProcessor(store, "/tmp/test");
    const session = attachLiveSession(processor, "FN-1403");

    (processor as any).taskEvacuatedFromPlanningHandler(planningTask({ column }));

    expect(session.abort).not.toHaveBeenCalled();
    expect((processor as any).activeSessions.has("FN-1403")).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("wakes the poll when the card comes back to todo, so planning restarts", () => {
    const store = makeStore();
    const processor = new TriageProcessor(store, "/tmp/test");
    const wake = vi.spyOn(processor as any, "requestImmediatePoll").mockImplementation(() => undefined);

    (processor as any).taskColumnWakeHandler({ id: "FN-1403", column: "todo" } as Task);

    expect(wake).toHaveBeenCalled();
  });
});

describe("a planning worktree is not execution evidence", () => {
  it("keeps a worktree-holding planner card in the planning stage", () => {
    // Pre-change this returned true and every planning write (status, spec finalization) was skipped.
    expect(hasAdvancedPastPlanning({ column: "todo", worktree: "/wt/fn-1403", steps: [], status: "planning" } as any)).toBe(false);
  });

  it("still treats a card that actually executed as advanced", () => {
    expect(
      hasAdvancedPastPlanning({
        column: "todo",
        worktree: "/wt/fn-1403",
        steps: [],
        status: null,
        firstExecutionAt: new Date().toISOString(),
      } as any),
    ).toBe(true);
  });
});

describe("pre-execution worktree sweep", () => {
  const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
  const recent = new Date(Date.now() - 2 * DAY_MS).toISOString();

  function sweepWith(tasks: Array<Partial<Task>>) {
    const store = makeStore({ listTasks: vi.fn().mockResolvedValue(tasks) });
    const release = vi.fn().mockResolvedValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test",
      releasePreExecutionWorktree: release,
    } as any);
    return { manager, release };
  }

  it("reclaims a parked card whose worktree has been idle past 30 days", async () => {
    const { manager, release } = sweepWith([
      { id: "FN-OLD", column: "ideas", worktree: "/wt/old", columnMovedAt: old, updatedAt: old } as Partial<Task>,
    ]);

    await expect(manager.reconcilePreExecutionWorktrees()).resolves.toBe(1);
    expect(release).toHaveBeenCalledWith("FN-OLD", expect.stringContaining("parked pre-execution"));
  });

  it.each([
    ["recently touched", { column: "ideas", worktree: "/wt/x", columnMovedAt: recent, updatedAt: recent }],
    ["queued in todo", { column: "todo", worktree: "/wt/x", columnMovedAt: old, updatedAt: old }],
    ["executing", { column: "in-progress", worktree: "/wt/x", columnMovedAt: old, updatedAt: old }],
    ["already executed once", { column: "ideas", worktree: "/wt/x", columnMovedAt: old, updatedAt: old, firstExecutionAt: old }],
    ["paused awaiting an operator", { column: "ideas", worktree: "/wt/x", columnMovedAt: old, updatedAt: old, paused: true }],
    ["carrying a status", { column: "ideas", worktree: "/wt/x", columnMovedAt: old, updatedAt: old, status: "needs-replan" }],
    ["blocked on another task", { column: "ideas", worktree: "/wt/x", columnMovedAt: old, updatedAt: old, blockedBy: "FN-9" }],
    ["scheduled for recovery", { column: "ideas", worktree: "/wt/x", columnMovedAt: old, updatedAt: old, nextRecoveryAt: old }],
    ["soft-deleted", { column: "ideas", worktree: "/wt/x", columnMovedAt: old, updatedAt: old, deletedAt: old }],
    ["holding no worktree", { column: "ideas", columnMovedAt: old, updatedAt: old }],
    ["of unprovable age", { column: "ideas", worktree: "/wt/x" }],
  ])("leaves a task that is %s alone", async (_label, task) => {
    const { manager, release } = sweepWith([{ id: "FN-SKIP", ...task } as Partial<Task>]);

    await expect(manager.reconcilePreExecutionWorktrees()).resolves.toBe(0);
    expect(release).not.toHaveBeenCalled();
  });

  it("does nothing while the engine or the board is paused", async () => {
    const store = makeStore({
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-OLD", column: "ideas", worktree: "/wt/old", columnMovedAt: old, updatedAt: old }]),
      getSettings: vi.fn().mockResolvedValue({ enginePaused: true }),
    });
    const release = vi.fn().mockResolvedValue(true);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test", releasePreExecutionWorktree: release } as any);

    await expect(manager.reconcilePreExecutionWorktrees()).resolves.toBe(0);
    expect(release).not.toHaveBeenCalled();
  });
});
