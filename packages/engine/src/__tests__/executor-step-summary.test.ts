import { describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { createTaskUpdateTool as createExecutorTaskUpdateTool } from "../executor/create-task-update-tool.js";
import { createTaskUpdateTool as createAgentTaskUpdateTool, taskUpdateParams } from "../agent-tools.js";
import { buildExecutionPrompt } from "../executor/execution-prompt.js";

function taskFixture(status: "pending" | "in-progress" | "done" = "in-progress"): Task {
  return {
    id: "FN-208",
    title: "History",
    description: "",
    priority: "normal",
    column: "in-progress",
    currentStep: 1,
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status },
    ],
    dependencies: [],
    log: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  } as Task;
}

function fakeStore() {
  const updateStep = vi.fn(async (_id: string, _step: number, status: "pending" | "in-progress" | "done" | "skipped") => taskFixture(status === "skipped" ? "done" : status));
  const store = {
    updateStep,
    getTask: vi.fn(async () => taskFixture()),
    updateTask: vi.fn(async () => taskFixture()),
    updateTaskCustomFields: vi.fn(async () => ({ ok: true })),
  } as unknown as TaskStore;
  return { store, updateStep };
}

function executorTool(store: TaskStore) {
  return createExecutorTaskUpdateTool(
    { store, resolveTaskCustomFieldDefs: async () => undefined, loopRecoveryState: new Map() },
    "FN-208",
    new Map(),
    { current: null },
  );
}

describe("executor step summaries", () => {
  it("publishes the summary parameter in both task update schemas", () => {
    const executorSchema = executorTool(fakeStore().store).parameters as { properties?: Record<string, unknown> };
    const agentSchema = taskUpdateParams as unknown as { properties?: Record<string, unknown> };
    expect(executorSchema.properties?.summary).toBeDefined();
    expect(agentSchema.properties?.summary).toBeDefined();
  });

  it("forwards a done summary through the executor tool", async () => {
    const { store, updateStep } = fakeStore();
    await executorTool(store).execute("call", { step: 1, status: "done", summary: "Delivered the History tab and ran its tests." });
    expect(updateStep).toHaveBeenCalledWith("FN-208", 1, "done", { summary: "Delivered the History tab and ran its tests." });
  });

  it("keeps summary omission non-fatal and returns a reminder", async () => {
    const { store, updateStep } = fakeStore();
    const result = await executorTool(store).execute("call", { step: 1, status: "done" });
    expect(updateStep).toHaveBeenCalledWith("FN-208", 1, "done");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("No step summary recorded");
    expect(result.isError).not.toBe(true);
  });

  it("forwards summaries on non-done transitions without enforcing them", async () => {
    const { store, updateStep } = fakeStore();
    await executorTool(store).execute("call", { step: 1, status: "in-progress", summary: "Starting work" });
    expect(updateStep).toHaveBeenCalledWith("FN-208", 1, "in-progress", { summary: "Starting work" });
  });

  it("forwards summaries through the agent-tools copy", async () => {
    const { store, updateStep } = fakeStore();
    await createAgentTaskUpdateTool(store, "FN-208").execute("call", {
      step: 1,
      status: "done",
      summary: "Delivered history reporting.",
    });
    expect(updateStep).toHaveBeenCalledWith("FN-208", 1, "done", { summary: "Delivered history reporting." });
  });

  it("instructs implementation sessions to summarize done steps", () => {
    const task = { ...taskFixture("pending"), prompt: "# Task\n\n## Steps\n\n### Step 0: Preflight" } as TaskDetail;
    expect(buildExecutionPrompt(task)).toContain("When marking a step done, include the `summary` argument");
  });
});
