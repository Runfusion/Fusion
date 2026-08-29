import { describe, it, expect, vi, beforeEach } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { mockedExecSync, resetExecutorMocks, createMockStore } from "../executor-test-helpers.js";
import { MAX_WORKTREE_SESSION_RETRIES } from "../../self-healing.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4917-T",
    title: "Task",
    description: "Desc",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

async function runRecovery(
  store: any,
  task: any,
  errorText: string,
  events: any[],
) {
  const executor = new TaskExecutor(store, process.cwd());
  return (executor as any).recoverMissingWorktreeSessionStartFailure(
    task,
    "/tmp/wt",
    new Error(errorText),
    {
      git: vi.fn(async (event: any) => events.push(event)),
      database: vi.fn(async (event: any) => events.push(event)),
    },
  );
}

describe("reliability interactions: FN-4917 worktree incomplete session-start", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("");
  });

  it.each([
    ["missing", "Refusing to start coding agent in missing worktree: /tmp/wt"],
    ["incomplete", "Refusing to start coding agent in incomplete worktree: /tmp/wt"],
    ["unregistered", "Refusing to start coding agent in unregistered git worktree: /tmp/wt"],
  ])("executor auto-recovers %s session-start failures", async (classification, errorText) => {
    const store = createMockStore();
    const events: any[] = [];

    let task = makeTask({ worktree: "/tmp/wt", branch: "fusion/fn-4917-t" });
    store.updateTask.mockImplementation(async (_id: string, updates: any) => {
      task = { ...task, ...updates };
      return task;
    });
    store.moveTask.mockImplementation(async (_id: string, column: string, _opts?: any) => {
      task = { ...task, column };
    });

    await runRecovery(store, task, errorText, events);

    expect(task.column).toBe("todo");

    const incompleteDetectedIndex = events.findIndex((event) => event.type === "worktree:incomplete-detected" || event.mutationType === "worktree:incomplete-detected");
    const autoRecoveredIndex = events.findIndex((event) => event.type === "worktree:auto-recovered" || event.mutationType === "worktree:auto-recovered");
    expect(incompleteDetectedIndex).toBeGreaterThanOrEqual(0);
    expect(autoRecoveredIndex).toBeGreaterThanOrEqual(0);
    expect(incompleteDetectedIndex).toBeLessThan(autoRecoveredIndex);

    expect(events[incompleteDetectedIndex]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        classification,
        source: "session-start",
        taskId: "FN-4917-T",
      }),
    }));
    expect(events[autoRecoveredIndex]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        classification,
        action: "requeue-todo",
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        staleWorktree: "/tmp/wt",
      }),
    }));

    expect(store.moveTask.mock.calls).toContainEqual(["FN-4917-T", "todo", { moveSource: "engine", recoveryRehome: true }]);
    for (const call of store.logEntry.mock.calls) {
      const leaked = call.some((arg: unknown) => typeof arg === "string" && /Refusing to start coding agent/.test(arg));
      expect(leaked).toBe(false);
    }
  });

  it("preserves progress when steps already completed", async () => {
    const store = createMockStore();
    const events: any[] = [];
    let task = makeTask({
      worktree: "/tmp/wt",
      branch: "fusion/fn-4917-t",
      steps: [
        { id: "1", title: "done", status: "done" },
        { id: "2", title: "next", status: "pending" },
      ],
    });
    store.updateTask.mockImplementation(async (_id: string, updates: any) => {
      task = { ...task, ...updates };
      return task;
    });

    await runRecovery(store, task, "Refusing to start coding agent in incomplete worktree: /tmp/wt", events);

    expect(store.moveTask).toHaveBeenCalledWith("FN-4917-T", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
    expect(store.moveTask.mock.calls).not.toContainEqual(["FN-4917-T", "todo"]);
    for (const call of store.logEntry.mock.calls) {
      const leaked = call.some((arg: unknown) => typeof arg === "string" && /Refusing to start coding agent/.test(arg));
      expect(leaked).toBe(false);
    }
    expect(events).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ action: "requeue-todo", classification: "incomplete" }),
    }));
  });

  it("escalates when session-start auto-recovery reaches retry cap", async () => {
    const store = createMockStore();
    const events: any[] = [];
    let task = makeTask({ worktree: "/tmp/wt", branch: "fusion/fn-4917-t", worktreeSessionRetryCount: 3 });
    store.updateTask.mockImplementation(async (_id: string, updates: any) => {
      task = { ...task, ...updates };
      return task;
    });

    await runRecovery(store, task, "Refusing to start coding agent in incomplete worktree: /tmp/wt", events);

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4917-T", "todo", expect.anything());
    expect(store.moveTask.mock.calls).not.toContainEqual(["FN-4917-T", "todo"]);

    const incompleteDetectedIndex = events.findIndex((event) => event.type === "worktree:incomplete-detected" || event.mutationType === "worktree:incomplete-detected");
    const autoRecoveredIndex = events.findIndex((event) => event.type === "worktree:auto-recovered" || event.mutationType === "worktree:auto-recovered");
    expect(incompleteDetectedIndex).toBeGreaterThanOrEqual(0);
    expect(autoRecoveredIndex).toBeGreaterThanOrEqual(0);
    expect(incompleteDetectedIndex).toBeLessThan(autoRecoveredIndex);
    expect(events[autoRecoveredIndex]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        action: "escalate-exhausted",
        retries: MAX_WORKTREE_SESSION_RETRIES,
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        staleWorktree: "/tmp/wt",
        classification: "incomplete",
      }),
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "task:auto-recover-worktree-session-exhausted",
      metadata: expect.objectContaining({
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        source: "executor-session-start",
      }),
    }));
    expect(store.logEntry.mock.calls.some((call: unknown[]) => call.some((arg) => typeof arg === "string" && /Worktree session-start auto-recovery exhausted/.test(arg)))).toBe(true);
    for (const call of store.logEntry.mock.calls) {
      const leaked = call.some((arg: unknown) => typeof arg === "string" && /Refusing to start coding agent/.test(arg));
      expect(leaked).toBe(false);
    }
    expect(task.column).toBe("in-progress");
  });

  it("does not intercept unrelated session-start failures", async () => {
    const store = createMockStore();
    const events: any[] = [];
    const task = makeTask({ worktree: "/tmp/wt", branch: "fusion/fn-4917-t" });

    const recovered = await runRecovery(store, task, "model API key missing", events);

    expect(recovered).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ mutationType: "worktree:auto-recovered" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "worktree:auto-recovered" }));
    expect(events).not.toContainEqual(expect.objectContaining({ mutationType: "worktree:incomplete-detected" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "worktree:incomplete-detected" }));
  });
});
