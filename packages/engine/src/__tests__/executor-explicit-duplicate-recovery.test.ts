import "./executor-test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-124",
    title: "DUPLICATE: KB-123",
    description: "Duplicate redirect",
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

/*
FNXC:DuplicateIntake 2026-08-09-01:54:
FN-8840 must recover an already-admitted title-only redirect at the graph failure boundary.
This fixture deliberately keeps PROMPT.md executable-looking, proving the title—not a prompt marker—
routes parse failure to replan before generic retry/terminal failure handling can run.
*/
describe("executor explicit duplicate redirect parse recovery", () => {
  it("rebounds a title-only custom-prefix redirect after a parse failure", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-duplicate-parse-"));
    const store = createMockStore();
    const liveTask = task({ error: "parse error" });
    await mkdir(join(tasksDir, liveTask.id), { recursive: true });
    await writeFile(join(tasksDir, liveTask.id, "PROMPT.md"), "# Incomplete plan\n", "utf-8");
    store.getTasksDir = vi.fn(() => tasksDir);
    store.getTask.mockResolvedValue(liveTask);
    const executor = new TaskExecutor(store, "/tmp/test");

    try {
      await (executor as any).handleGraphFailure(liveTask, {
        disposition: "failed",
        outcome: "failure",
        reason: "parse-error",
        visitedNodeIds: ["parse"],
        context: { "node:parse:value": "parse-error" },
      });

      expect(store.moveTask).toHaveBeenCalledWith(liveTask.id, "todo", { preserveWorktree: true });
      expect(store.updateTask).toHaveBeenCalledWith(liveTask.id, {
        status: "needs-replan",
        error: null,
      }, undefined);
      expect(store.logEntry).toHaveBeenCalledWith(
        liveTask.id,
        "Parse node failed on duplicate redirect — rebounded to todo for re-specification",
        expect.stringContaining("task title"),
        undefined,
      );
      expect(store.updateTask).not.toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "failed" }),
        undefined,
      );
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});
