import { describe, expect, it, vi } from "vitest";
import { createAiUndoTask, buildAiUndoTaskDescription, REVERT_OF_METADATA_KEY } from "../execution/task-revert.js";
import type { CreateAiUndoTaskDeps } from "../execution/task-revert.js";
import type { Task, TaskCreateInput } from "@fusion/core";

function makeSourceTask(overrides: Partial<Task> = {}): CreateAiUndoTaskDeps["sourceTask"] {
  return {
    id: "FN-901",
    title: "Add feature a",
    description: "Add feature a to the widget renderer.",
    prompt: undefined,
    mergeDetails: { commitSha: "abc123", landedFiles: ["foo.ts", "bar.ts"] },
    priority: "normal",
    ...overrides,
  } as CreateAiUndoTaskDeps["sourceTask"];
}

function makeExistingTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-950",
    lineageId: "FN-950",
    description: "existing undo task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

describe("buildAiUndoTaskDescription (FN-7524)", () => {
  it("references the source id, its mission, landed files, the diff pointer, preserve-unrelated instruction, and the revert() commit convention", () => {
    const description = buildAiUndoTaskDescription({
      task: {
        id: "FN-901",
        title: "Add feature a",
        description: "Add feature a to the widget renderer.",
        prompt: undefined,
        mergeDetails: { commitSha: "abc", landedFiles: ["foo.ts", "bar.ts"] },
      },
    });

    expect(description).toContain("FN-901");
    expect(description).toContain("Add feature a to the widget renderer.");
    expect(description).toContain("foo.ts");
    expect(description).toContain("bar.ts");
    expect(description).toContain("/api/tasks/FN-901/diff");
    expect(description).toMatch(/preserv/i);
    expect(description).toContain("revert(FN-901):");
    expect(description).toContain("Fusion-Task-Id: FN-901");
  });

  it("prefers task.prompt over task.description for the mission text when present", () => {
    const description = buildAiUndoTaskDescription({
      task: {
        id: "FN-902",
        title: "t",
        description: "short description",
        prompt: "## Full generated mission\nDetailed spec content.",
        mergeDetails: undefined,
      },
    });
    expect(description).toContain("Detailed spec content.");
    expect(description).not.toContain("short description");
  });

  it("handles a task with no recorded landed files", () => {
    const description = buildAiUndoTaskDescription({
      task: { id: "FN-903", title: "t", description: "d", prompt: undefined, mergeDetails: undefined },
    });
    expect(description).toMatch(/no landed-files list recorded/i);
  });
});

describe("createAiUndoTask (FN-7524)", () => {
  it("creates a dependency-free board task with the revertOf marker and returns { mode: 'ai', createdTaskId }", async () => {
    const createTask = vi.fn(async (input: TaskCreateInput) => makeExistingTask({
      id: "FN-960",
      description: input.description,
      dependencies: input.dependencies ?? [],
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: input.source?.sourceMetadata,
    }));
    const findOpenRevertTaskForSource = vi.fn(async () => null);

    const result = await createAiUndoTask({
      createTask,
      findOpenRevertTaskForSource,
      sourceTask: makeSourceTask(),
    });

    expect(result).toEqual({ mode: "ai", createdTaskId: "FN-960" });
    expect(createTask).toHaveBeenCalledTimes(1);
    const input = createTask.mock.calls[0][0] as TaskCreateInput;
    expect(input.dependencies).toEqual([]);
    expect(input.source?.sourceMetadata?.[REVERT_OF_METADATA_KEY]).toBe("FN-901");
    expect(input.description).toContain("FN-901");
  });

  it("does not create a duplicate when an open AI-undo task already exists for the source (idempotency)", async () => {
    const createTask = vi.fn();
    const existing = makeExistingTask({ id: "FN-955", column: "triage" });
    const findOpenRevertTaskForSource = vi.fn(async () => existing);

    const result = await createAiUndoTask({
      createTask,
      findOpenRevertTaskForSource,
      sourceTask: makeSourceTask(),
    });

    expect(result).toEqual({ mode: "ai", createdTaskId: "FN-955", alreadyOpen: true });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("forwards a non-blank workflowId into the createTask input (FN-7556)", async () => {
    const createTask = vi.fn(async (input: TaskCreateInput) => makeExistingTask({
      id: "FN-961",
      description: input.description,
      dependencies: input.dependencies ?? [],
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: input.source?.sourceMetadata,
    }));
    const findOpenRevertTaskForSource = vi.fn(async () => null);

    const result = await createAiUndoTask({
      createTask,
      findOpenRevertTaskForSource,
      sourceTask: makeSourceTask(),
      workflowId: "builtin:review-heavy",
    });

    expect(result).toEqual({ mode: "ai", createdTaskId: "FN-961" });
    const input = createTask.mock.calls[0][0] as TaskCreateInput;
    expect(input.workflowId).toBe("builtin:review-heavy");
  });

  it("omits the workflowId key entirely when no/blank workflowId is supplied (inherit project default, FN-7556)", async () => {
    const createTask = vi.fn(async (input: TaskCreateInput) => makeExistingTask({
      id: "FN-962",
      description: input.description,
      dependencies: input.dependencies ?? [],
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: input.source?.sourceMetadata,
    }));
    const findOpenRevertTaskForSource = vi.fn(async () => null);

    await createAiUndoTask({
      createTask,
      findOpenRevertTaskForSource,
      sourceTask: makeSourceTask(),
    });
    const noWorkflowIdInput = createTask.mock.calls[0][0] as TaskCreateInput;
    expect("workflowId" in noWorkflowIdInput).toBe(false);

    createTask.mockClear();
    await createAiUndoTask({
      createTask,
      findOpenRevertTaskForSource,
      sourceTask: makeSourceTask(),
      workflowId: "   ",
    });
    const blankWorkflowIdInput = createTask.mock.calls[0][0] as TaskCreateInput;
    expect("workflowId" in blankWorkflowIdInput).toBe(false);
  });

  it("never creates a task on the idempotent alreadyOpen path regardless of workflowId (FN-7556)", async () => {
    const createTask = vi.fn();
    const existing = makeExistingTask({ id: "FN-963", column: "triage" });
    const findOpenRevertTaskForSource = vi.fn(async () => existing);

    const result = await createAiUndoTask({
      createTask,
      findOpenRevertTaskForSource,
      sourceTask: makeSourceTask(),
      workflowId: "builtin:review-heavy",
    });

    expect(result).toEqual({ mode: "ai", createdTaskId: "FN-963", alreadyOpen: true });
    expect(createTask).not.toHaveBeenCalled();
  });
});
