import { describe, expect, it, vi } from "vitest";
import { MAX_TASK_LIST_TEXT_CHARS, type TaskStore } from "@fusion/core";
import { createPlanningBoardTools, resolveTaskListFormatter } from "../planning-board-tools.js";

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


describe("fn_task_list resilience (FN-6573)", () => {
  it("returns bounded text when formatter exports are unavailable", () => {
    const boardLines = [
      `FN-1 (todo): Dashboard duplicate check ${"x".repeat(6_000)}`,
      `FN-2 (triage): Dashboard duplicate check ${"x".repeat(6_000)}`,
    ];

    /*
    FNXC:TaskListOutput 2026-06-17-07:38:
    FN-6573 drives the dashboard formatter resolver seam because the tool closure imports the live @fusion/core namespace at module load. The seam reproduces stale dist namespaces where formatTaskListText, or both task-list helpers, are absent and must still produce one bounded text block.
    */
    for (const coreNamespace of [
      { formatTaskListText: undefined, clampTaskListText: () => "unused" },
      { formatTaskListText: undefined, clampTaskListText: undefined },
    ]) {
      const formatter = resolveTaskListFormatter(coreNamespace);
      const text = formatter(boardLines, { clamp: coreNamespace.clampTaskListText }).trimEnd();
      expect(text).toBeTruthy();
      expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
    }
  });
});


describe("createPlanningBoardTools", () => {
  it("fn_task_list does not throw TypeError on happy path and excludes done tasks", async () => {
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
    await expect(taskList!.execute("c1", {})).resolves.not.toThrow();
    const result = await taskList!.execute("c1", {});
    expect(result.content[0]?.text).toBe("FN-1 (todo): Task one [deps: FN-0]");

    const emptyStore = createStoreMock({ listTasks: vi.fn(async () => []) as TaskStore["listTasks"] });
    const emptyResult = await createPlanningBoardTools(emptyStore)
      .find((tool) => tool.name === "fn_task_list")!
      .execute("c2", {});
    expect(emptyResult.content[0]?.text).toBe("No active tasks.");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-06:25 (batch-core):
  THE DUPLICATE CHECK MUST NOT LIST FINISHED WORK AS ACTIVE.

  `fn_task_list` exists so the planner can check for duplicates against work still in flight. Keyed on
  `column !== "done"`, a renamed board listed every FINISHED task as active — the planner was told to
  avoid duplicating work that was already complete, which is the opposite of the tool's purpose.

  It degrades quietly, which is why it needs a test rather than a bug report: the list is merely wrong,
  not empty, so nothing looks broken. The case above pins the default board; this one pins a board
  whose complete lane is `shipped` and which declares no `done` at all.
  */
  it("excludes a task finished in a RENAMED complete lane", async () => {
    const renamedIr = {
      version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
      columns: [
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };
    const selection = { workflowId: "wf-renamed", stepIds: [] };
    const store = {
      listTasks: vi.fn(async () => [
        { id: "FN-1", column: "building", title: "Live", description: "Live description", dependencies: [] },
        { id: "FN-2", column: "shipped", title: "Finished", description: "Finished description", dependencies: [] },
      ]),
      getTask: vi.fn(async () => { throw new Error("not found"); }),
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ id: "wf-renamed", ir: renamedIr }),
    } as unknown as TaskStore;

    const result = await createPlanningBoardTools(store)
      .find((tool) => tool.name === "fn_task_list")!
      .execute("c1", {});

    /*
    Asserting the exact line rather than just "does not contain FN-2": a filter that dropped
    everything would also satisfy the negative on its own.
    */
    expect(result.content[0]?.text).toBe("FN-1 (building): Live");
  });

  it("fn_task_show returns full details and not-found fallback", async () => {
    const store = createStoreMock({
      getTask: vi.fn(async (id: string) => ({
        id,
        column: "in-progress",
        description: "Detailed task",
        dependencies: ["FN-5", "FN-6"],
        prompt: "# Prompt body",
      })) as TaskStore["getTask"],
    });

    const taskGet = createPlanningBoardTools(store).find((tool) => tool.name === "fn_task_show");
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
      .find((tool) => tool.name === "fn_task_show")!
      .execute("c4", { id: "FN-404" });
    expect(missingResult.content[0]?.text).toBe("Task FN-404 not found.");
  });
});
