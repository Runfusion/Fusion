import { describe, expect, it } from "vitest";
import { render, renderHook } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { filterGraphTasks } from "../filters";
import { useGraphData } from "../useGraphData";
import { DependencyGraph } from "../DependencyGraph";

function createTask(id: string, column: Task["column"], dependencies: string[] = [], status?: Task["status"]): Task {
  return {
    id,
    description: id,
    column,
    status,
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
  } as Task;
}

describe("dependency graph filtering", () => {
  it("includes triage/todo/in-progress/in-review and excludes done/archived by column", () => {
    const tasks = [
      createTask("T", "triage", [], "done"),
      createTask("TD", "todo", [], "done"),
      createTask("P", "in-progress", [], "done"),
      createTask("R", "in-review", [], "done"),
      createTask("D", "done", [], "in-progress"),
      createTask("A", "archived", [], "in-progress"),
    ];

    expect(filterGraphTasks(tasks).map((task) => task.id)).toEqual(["T", "TD", "P", "R"]);
  });

  it("keeps standalone tasks without dependencies as nodes", () => {
    const tasks = [createTask("A", "todo")];
    const { result } = renderHook(() => useGraphData(tasks));

    expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A"]);
    expect(result.current.edges).toEqual([]);
  });

  it("keeps only edges to included dependency tasks for mixed-status dependencies", () => {
    const filteredTasks = filterGraphTasks([
      createTask("A", "in-progress", ["B", "DONE", "ARCH"]),
      createTask("B", "todo"),
      createTask("DONE", "done"),
      createTask("ARCH", "archived"),
    ]);

    const { result } = renderHook(() => useGraphData(filteredTasks));
    expect(result.current.edges).toEqual([{ source: "A", target: "B" }]);
  });

  it("renders empty state when all tasks are done/archived", () => {
    const { container } = render(
      <DependencyGraph tasks={[createTask("D", "done"), createTask("A", "archived")]} onOpenTaskDetail={() => {}} />,
    );

    expect(container.textContent).toContain("No active tasks");
  });
});
