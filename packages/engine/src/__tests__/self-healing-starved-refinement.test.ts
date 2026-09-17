import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509 REMOVED this sweep's remediation. Its only action was a one-step priority nudge
(low -> normal -> high -> urgent), and priority no longer exists, so the seven cases that asserted
"escalates / does not escalate" have no subject left. Making them pass again would mean re-adding an
automatic rank write — exactly the hidden priority the chronological queue replaces, and the one
thing FN-509 forbids outside the operator's explicit Boost.

What remains worth protecting is what the sweep still does and what it must never do again:
stale triage-processing eviction is an independent recovery and is kept, while NO task mutation,
rank write, or column move may come out of this sweep under any board state.
*/

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    title: id,
    description: id,
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: null,
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
    columnMovedAt: "2026-05-15T10:00:00.000Z",
    ...rest,
  } as Task;
}

/** A board deliberately shaped like the old escalation trigger: an aged refinement behind peers. */
function starvedBoard(): Task[] {
  const longAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
  return [
    task({ id: "FN-REFINE", sourceType: "task_refine", createdAt: longAgo, updatedAt: longAgo } as never),
    task({ id: "FN-PEER-1", column: "todo" }),
    task({ id: "FN-PEER-2", column: "todo" }),
    task({ id: "FN-PEER-3", column: "todo" }),
  ];
}

function createHarness(tasks: Task[]) {
  const updateTask = vi.fn(async () => tasks[0]!);
  const moveTask = vi.fn(async () => tasks[0]!);
  const logEntry = vi.fn(async () => undefined);
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const evictStaleTriageProcessing = vi.fn();

  const store = {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((candidate) => candidate.id === id) ?? null),
    getSettings: vi.fn(async () => ({})),
    getSettingsFast: vi.fn(async () => ({})),
    getRootDir: () => "/repo",
    updateTask,
    moveTask,
    logEntry,
    recordRunAuditEvent,
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
  } as unknown as TaskStore;

  // SelfHealingManager takes the store and its options as two constructor arguments.
  const manager = new SelfHealingManager(store, { evictStaleTriageProcessing } as never);

  return { manager, updateTask, moveTask, logEntry, recordRunAuditEvent, evictStaleTriageProcessing };
}

describe("SelfHealingManager.recoverStarvedRefinementTriageTasks after FN-509", () => {
  it("escalates nothing on a board that previously triggered the priority nudge", async () => {
    const h = createHarness(starvedBoard());

    const recovered = await h.manager.recoverStarvedRefinementTriageTasks();

    expect(recovered).toBe(0);
    // No rank write, no annotation, no audit row, and above all no column move.
    expect(h.updateTask).not.toHaveBeenCalled();
    expect(h.moveTask).not.toHaveBeenCalled();
    expect(h.logEntry).not.toHaveBeenCalled();
    expect(h.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("still evicts stale triage processing, which is an independent recovery", async () => {
    const h = createHarness(starvedBoard());

    await h.manager.recoverStarvedRefinementTriageTasks();

    expect(h.evictStaleTriageProcessing).toHaveBeenCalledTimes(1);
  });

  it("mutates nothing on an empty board and reports no recovery", async () => {
    const h = createHarness([]);

    expect(await h.manager.recoverStarvedRefinementTriageTasks()).toBe(0);
    expect(h.updateTask).not.toHaveBeenCalled();
    expect(h.moveTask).not.toHaveBeenCalled();
  });

  it("ignores a legacy priority value still sitting on a refinement row", async () => {
    const board = starvedBoard();
    (board[0] as { priority?: string }).priority = "low";
    const h = createHarness(board);

    expect(await h.manager.recoverStarvedRefinementTriageTasks()).toBe(0);
    expect(h.updateTask).not.toHaveBeenCalled();
  });
});
