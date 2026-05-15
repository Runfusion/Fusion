import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createPlanningBoardTools } from "../planning-board-tools.js";

function createStoreMock(overrides?: {
  listTasks?: TaskStore["listTasks"];
  getTask?: TaskStore["getTask"];
}): TaskStore {
  return {
    listTasks: overrides?.listTasks ?? vi.fn(async () => []),
    getTask: overrides?.getTask ?? vi.fn(async () => {
      throw new Error("not found");
    }),
  } as unknown as TaskStore;
}

describe("createPlanningBoardTools", () => {
  it("fn_task_list excludes done tasks, includes deps, and handles empty list", async () => {
    const store = createStoreMock({
      listTasks: vi.fn(async () => [
        {
          id: "FN-1",
          column: "todo",
          title: "Task one",
          description: "Task one description",
          dependencies: ["FN-0"],
        },
        {
          id: "FN-2",
          column: "done",
          title: "Done",
          description: "Done description",
          dependencies: [],
        },
      ]) as TaskStore["listTasks"],
    });

    const taskList = createPlanningBoardTools(store).find((tool) => tool.name === "fn_task_list");
    expect(taskList).toBeDefined();
    const result = await taskList!.execute("c1", {});
    expect(result.content[0]?.text).toBe("FN-1 (todo): Task one [deps: FN-0]");

    const emptyStore = createStoreMock({ listTasks: vi.fn(async () => []) as TaskStore["listTasks"] });
    const emptyResult = await createPlanningBoardTools(emptyStore)
      .find((tool) => tool.name === "fn_task_list")!
      .execute("c2", {});
    expect(emptyResult.content[0]?.text).toBe("No active tasks.");
  });

  it("fn_task_get returns full details and not-found fallback", async () => {
    const store = createStoreMock({
      getTask: vi.fn(async (id: string) => ({
        id,
        column: "in-progress",
        description: "Detailed task",
        dependencies: ["FN-5", "FN-6"],
        prompt: "# Prompt body",
      })) as TaskStore["getTask"],
    });

    const taskGet = createPlanningBoardTools(store).find((tool) => tool.name === "fn_task_get");
    expect(taskGet).toBeDefined();
    const result = await taskGet!.execute("c3", { id: "FN-10" });
    expect(result.content[0]?.text).toContain("ID: FN-10");
    expect(result.content[0]?.text).toContain("Column: in-progress");
    expect(result.content[0]?.text).toContain("Description: Detailed task");
    expect(result.content[0]?.text).toContain("Dependencies: FN-5, FN-6");
    expect(result.content[0]?.text).toContain("PROMPT.md:");
    expect(result.content[0]?.text).toContain("# Prompt body");

    const notFoundStore = createStoreMock();
    const missingResult = await createPlanningBoardTools(notFoundStore)
      .find((tool) => tool.name === "fn_task_get")!
      .execute("c4", { id: "FN-404" });
    expect(missingResult.content[0]?.text).toBe("Task FN-404 not found.");
  });
});
