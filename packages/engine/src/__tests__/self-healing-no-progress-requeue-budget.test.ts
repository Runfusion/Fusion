import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildManualRetryResetPatch, type Task, type TaskStore } from "@fusion/core";
import {
  MAX_TASK_DONE_RETRIES,
  SelfHealingManager,
} from "../self-healing.js";
import { classifyTerminalFailureAutoRecoveryForTask } from "../notification/task-wedge-notification.js";
import { NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX } from "../healing/no-progress-requeue-budget.js";

function candidate(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9186",
    column: "in-progress",
    status: "failed",
    error: "Agent finished without calling fn_task_done: sandbox unavailable",
    paused: false,
    steps: [],
    ...overrides,
  } as Task;
}

/** Production-shaped mutable store: atomic updates serialize competing maintenance owners. */
function createStore(initial: Task) {
  let task = { ...initial };
  let tail = Promise.resolve();
  const emitter = new EventEmitter();
  const moveTask = vi.fn(async (_id: string, column: string) => {
    task = { ...task, column } as Task;
    return task;
  });
  const store = Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({ maintenanceIntervalMs: 60_000, autoRecovery: { mode: "on" } }),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => !column || column === task.column ? [{ ...task }] : []),
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(async () => ({ ...task })),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Partial<Task> | null) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const patch = await updater({ ...task });
        if (patch) task = { ...task, ...patch } as Task;
        return { ...task };
      } finally {
        release();
      }
    }),
    moveTask,
    updateTask: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    claimTerminalFailureAutoRecoveryAttempt: vi.fn(),
    applyTerminalFailureAutoRecoveryRetry: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
  }) as unknown as TaskStore & EventEmitter;
  return {
    store,
    moveTask,
    read: () => ({ ...task }),
    failAgain: () => { task = candidate({ taskDoneRetryCount: task.taskDoneRetryCount }); },
    applyManualRetryAndFailAgain: () => {
      task = candidate({ ...task, ...buildManualRetryResetPatch(), error: candidate().error });
    },
  };
}

describe("no-progress no-task_done recovery budget", () => {
  it("serializes competing sweeps so the persisted budget permits only three moves", async () => {
    const fixture = createStore(candidate());
    const first = new SelfHealingManager(fixture.store, { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set() });
    const second = new SelfHealingManager(fixture.store, { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set() });
    vi.spyOn(first as any, "hasRecoverableGitWork").mockResolvedValue(false);
    vi.spyOn(second as any, "hasRecoverableGitWork").mockResolvedValue(false);
    vi.spyOn(first as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });
    vi.spyOn(second as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.all([first.recoverNoProgressNoTaskDoneFailures(), second.recoverNoProgressNoTaskDoneFailures()]);
      const current = fixture.read();
      if (current.taskDoneRetryCount && current.taskDoneRetryCount <= MAX_TASK_DONE_RETRIES && current.column === "todo") {
        fixture.failAgain();
      }
    }

    expect(fixture.moveTask).toHaveBeenCalledTimes(MAX_TASK_DONE_RETRIES);
    expect(fixture.read().column).toBe("in-progress");
    expect(fixture.read().status).toBe("failed");
    expect(fixture.read().error?.startsWith(NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX)).toBe(true);
    expect(fixture.store.logEntry).toHaveBeenCalledTimes(MAX_TASK_DONE_RETRIES + 1);
    first.stop();
    second.stop();
  });

  it("keeps the exhausted park out of terminal-failure recovery while ordinary failures retain that owner", async () => {
    const fixture = createStore(candidate({
      taskDoneRetryCount: MAX_TASK_DONE_RETRIES,
      error: `${NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX} 3/3 Agent finished without calling fn_task_done: sandbox unavailable`,
    }));
    const manager = new SelfHealingManager(fixture.store, { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set() });

    expect(classifyTerminalFailureAutoRecoveryForTask(fixture.read(), { autoRecoveryEnabled: true }))
      .toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
    await expect(manager.autoRecoverTerminalFailures()).resolves.toBe(0);
    expect(fixture.store.claimTerminalFailureAutoRecoveryAttempt).not.toHaveBeenCalled();
    expect(fixture.store.applyTerminalFailureAutoRecoveryRetry).not.toHaveBeenCalled();
    expect(fixture.moveTask).not.toHaveBeenCalled();
    expect(fixture.read().error?.startsWith(NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED_PREFIX)).toBe(true);
    expect(fixture.read().column).toBe("in-progress");

    const ordinary = createStore(candidate({ id: "FN-9186-ordinary", column: "todo", error: "opaque terminal failure" }));
    (ordinary.store.claimTerminalFailureAutoRecoveryAttempt as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ outcome: "claimed", attempt: 1, applyToken: "test-token" });
    (ordinary.store.applyTerminalFailureAutoRecoveryRetry as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ outcome: "applied" });
    const ordinaryManager = new SelfHealingManager(ordinary.store, { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set() });
    await expect(ordinaryManager.autoRecoverTerminalFailures()).resolves.toBe(1);
    expect(ordinary.store.claimTerminalFailureAutoRecoveryAttempt).toHaveBeenCalledOnce();
    expect(ordinary.store.applyTerminalFailureAutoRecoveryRetry).toHaveBeenCalledOnce();
    ordinaryManager.stop();

    fixture.applyManualRetryAndFailAgain();
    vi.spyOn(manager as any, "hasRecoverableGitWork").mockResolvedValue(false);
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });
    await expect(manager.recoverNoProgressNoTaskDoneFailures()).resolves.toBe(1);
    expect(fixture.moveTask).toHaveBeenCalledTimes(1);
    expect(fixture.read().taskDoneRetryCount).toBe(1);
    manager.stop();
  });
});
