import { describe, expect, it } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { aiMergeTask } from "../merger.js";

const sentinel = new Error("sentinel-getSettings");

function createTask(status: Task["status"]): Task {
  return {
    id: "FN-5438",
    title: "Manual merge queued bypass",
    description: "",
    column: "in-review",
    status,
    paused: false,
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dependencies: [],
  } as unknown as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: async () => task,
    getSettings: async () => {
      throw sentinel;
    },
  } as unknown as TaskStore;
}

describe("aiMergeTask manual queued bypass", () => {
  it("blocks queued status for auto merge", async () => {
    const store = createStore(createTask("queued"));
    await expect(aiMergeTask(store, process.cwd(), "FN-5438")).rejects.toThrow(
      "Cannot merge FN-5438: task is marked 'queued'",
    );
  });

  it("bypasses queued status for manual merge", async () => {
    const store = createStore(createTask("queued"));
    await expect(aiMergeTask(store, process.cwd(), "FN-5438", { manual: true })).rejects.toBe(sentinel);
  });
});
