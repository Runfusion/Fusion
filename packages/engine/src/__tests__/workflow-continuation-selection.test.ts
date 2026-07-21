import { describe, expect, it } from "vitest";
import type { Task, WorkflowWorkItem } from "@fusion/core";
import { selectActionablePlanningContinuations } from "../runtimes/in-process-runtime.js";

function workItem(id: string, waitReason: WorkflowWorkItem["waitReason"]): WorkflowWorkItem {
  return { id, waitReason } as WorkflowWorkItem;
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, paused: false, userPaused: false, ...patch } as Task;
}

describe("selectActionablePlanningContinuations", () => {
  it("retains only planning items whose tasks are present and unpaused", () => {
    const selected = selectActionablePlanningContinuations([
      { item: workItem("eligible", "planning"), task: task("T-1") },
      { item: workItem("capacity", "capacity"), task: task("T-2") },
      { item: workItem("missing", "planning"), task: undefined },
      { item: workItem("null-task", "planning"), task: null },
      { item: workItem("no-wait-reason", null), task: task("T-5") },
      { item: workItem("paused", "planning"), task: task("T-3", { paused: true }) },
      { item: workItem("user-paused", "planning"), task: task("T-4", { userPaused: true }) },
    ]);

    expect(selected.map(({ item, task: selectedTask }) => [item.id, selectedTask.id])).toEqual([
      ["eligible", "T-1"],
    ]);
  });
});
