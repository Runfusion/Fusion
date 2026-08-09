import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { Scheduler } from "../scheduler.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";

/*
FNXC:DuplicateIntake 2026-08-09-01:54:
FN-8840 requires scheduler admission to reject a durable exact title redirect before it tries to
read PROMPT.md. This production-boundary test makes getTasksDir throw, so it fails if a refactor
moves title evaluation below filesystem capability or accidentally permits a dispatchable redirect.
*/
describe("scheduler explicit duplicate redirect admission", () => {
  it("rejects a title-only custom-prefix redirect without prompt filesystem access", async () => {
    const getTasksDir = vi.fn(() => {
      throw new Error("PROMPT.md must not be read for a title redirect");
    });
    const scheduler = new Scheduler({
      getRootDir: () => "/tmp/test",
      getTasksDir,
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TaskStore);

    await expect((scheduler as any).validateTaskFilesystem({
      id: "KB-124",
      title: "DUPLICATE: KB-123",
    })).resolves.toEqual({
      valid: false,
      reason: "task title is a duplicate redirect marker (DUPLICATE: KB-123), not an executable plan",
    });
    expect(getTasksDir).not.toHaveBeenCalled();
  });

  it("does not suppress ordinary title prose", async () => {
    const scheduler = new Scheduler({
      getRootDir: () => "/tmp/test",
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TaskStore);

    await expect((scheduler as any).validateTaskFilesystem({
      id: "KB-124",
      title: "Discuss DUPLICATE: KB-123 before implementation",
    })).resolves.toEqual({ valid: true });
  });

  /*
  FNXC:DuplicateIntake 2026-08-09-02:13:
  FN-8840's scheduler guarantee is observable only through schedule(): an exact title redirect
  must not cross the hold-to-WIP boundary even when its PROMPT.md is a complete executable plan.
  The control uses the same store and spec with ordinary title prose, preventing a vacuous refusal.
  */
  it("does not dispatch an exact title redirect through the scheduler admission path", async () => {
    const workflowId = "custom:duplicate-title-admission";
    const task = {
      id: "KB-124",
      title: "DUPLICATE: KB-123",
      description: "A complete plan is already present.",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "passed" as const,
        source: "node" as const,
        phase: "pre-merge" as const,
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Task;
    const ir = {
      version: "v2",
      id: workflowId,
      nodes: [],
      edges: [],
      columns: [
        { id: "todo", label: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "in-review", label: "Review", traits: [{ trait: "humanReview" }, { trait: "mergeBlocker" }] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const tasksDir = mkdtempSync(join(tmpdir(), "fusion-scheduler-duplicate-title-"));
    const moveTask = vi.fn(async (_id: string, column: Task["column"]) => Object.assign(task, { column }));
    const store = {
      listTasks: vi.fn(async () => [task]),
      getSettings: vi.fn(async () => ({ maxConcurrent: 1, maxWorktrees: 1 } as Settings)),
      updateSettings: vi.fn(async () => undefined),
      getTask: vi.fn(async () => task),
      getTasksDir: vi.fn(() => tasksDir),
      getRootDir: vi.fn(() => "/tmp/project"),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId, stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId, stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir })),
      moveTask,
      moveTaskIf: vi.fn(async (_id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>) => {
        if (!(await predicate(task))) return { task, moved: false };
        return { task: await moveTask(task.id, column), moved: true };
      }),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
      logEntry: vi.fn(async () => undefined),
      parseFileScopeFromPrompt: vi.fn(async () => []),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      recordRunAuditEvent: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TaskStore;
    seedPlannedSpec(store as unknown as { getTasksDir(): string }, task.id, { title: task.title, description: task.description });
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("todo");

    task.title = "Discuss duplicate KB-123 before implementation";
    await scheduler.schedule();

    expect(moveTask).toHaveBeenCalledWith(task.id, "in-progress");
    expect(task.column).toBe("in-progress");
  });
});
