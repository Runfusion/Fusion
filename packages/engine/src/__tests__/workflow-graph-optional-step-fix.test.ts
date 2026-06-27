import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7066",
    title: "Optional step fix",
    description: "Fix optional workflow findings",
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 0: Implement\n- [x] done",
    worktree: "/tmp/fusion/fn-7066",
    postReviewFixCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

const reviseInfo = {
  stepName: "Code Review",
  feedback: "packages/engine/src/example.ts:1 needs a guard",
  phase: "pre-merge" as const,
  status: "advisory_failure" as const,
  verdict: "REVISE",
};

describe("TaskExecutor pre-merge optional-step fix seam", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("consumes budget before sending the task back for optional-step remediation", async () => {
    const store = createMockStore();
    const liveTask = task({ postReviewFixCount: 0 });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 2 });
    const executor = new TaskExecutor(store, "/tmp/test");
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, reviseInfo);

    expect(scheduled).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 1 }, undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      expect.stringContaining("attempt 1/2"),
      expect.stringContaining("packages/engine/src/example.ts:1 needs a guard"),
      undefined,
    );
    expect(sendBack).toHaveBeenCalledWith(
      liveTask,
      "/tmp/fusion/fn-7066",
      "packages/engine/src/example.ts:1 needs a guard",
      "Code Review",
      expect.stringContaining("requested revision"),
    );
    expect(store.updateTask.mock.invocationCallOrder[0]).toBeLessThan(sendBack.mock.invocationCallOrder[0]);
  });

  it("uses the default budget of 3 for repeated fix passes and then declines when exhausted", async () => {
    const sendBackCalls: number[] = [];

    for (const count of [0, 1, 2, 3]) {
      const store = createMockStore();
      const liveTask = task({ postReviewFixCount: count });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({});
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockImplementation(async () => {
        sendBackCalls.push(count);
      });

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, reviseInfo);

      if (count < 3) {
        expect(scheduled).toBe(true);
        expect(store.updateTask).toHaveBeenCalledWith("FN-7066", { postReviewFixCount: count + 1 }, undefined);
        expect(store.logEntry).toHaveBeenCalledWith(
          "FN-7066",
          expect.stringContaining(`attempt ${count + 1}/3`),
          expect.any(String),
          undefined,
        );
        expect(sendBack).toHaveBeenCalledOnce();
      } else {
        expect(scheduled).toBe(false);
        expect(store.updateTask).not.toHaveBeenCalledWith("FN-7066", expect.objectContaining({ postReviewFixCount: 4 }), undefined);
        expect(sendBack).not.toHaveBeenCalled();
      }
    }

    expect(sendBackCalls).toEqual([0, 1, 2]);
  });

  it("declines without sending back when maxPostReviewFixes disables or exhausts the budget", async () => {
    for (const { settingsMax, count } of [
      { settingsMax: 0, count: 0 },
      { settingsMax: 1, count: 1 },
    ]) {
      const store = createMockStore();
      const liveTask = task({ postReviewFixCount: count });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({ maxPostReviewFixes: settingsMax });
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, reviseInfo);

      expect(scheduled).toBe(false);
      expect(store.updateTask).not.toHaveBeenCalledWith(liveTask.id, expect.objectContaining({ postReviewFixCount: expect.any(Number) }), expect.anything());
      expect(store.updateTask).not.toHaveBeenCalledWith(liveTask.id, expect.objectContaining({ postReviewFixCount: expect.any(Number) }), undefined);
      expect(sendBack).not.toHaveBeenCalled();
    }
  });
});
