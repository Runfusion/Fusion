import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { useGraphData } from "../useGraphData";

function createTask(id: string, column: Task["column"] = "todo", dependencies: string[] = []): Task {
  return {
    id,
    description: id,
    column,
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
  } as Task;
}

describe("useGraphData", () => {
  it("returns empty graph for empty tasks", () => {
    const { result } = renderHook(() => useGraphData([]));
    expect(result.current).toEqual({ nodes: [], edges: [] });
  });

  it("creates node for single task with no deps", () => {
    const { result } = renderHook(() => useGraphData([createTask("A")]));
    expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A"]);
    expect(result.current.edges).toEqual([]);
  });

  describe("orphan dependencies to excluded tasks", () => {
    it("drops dependency edge to done task while keeping dependent node", () => {
      const filteredTasks = [createTask("A", "in-progress", ["DONE-1"])];
      const { result } = renderHook(() => useGraphData(filteredTasks));

      expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A"]);
      expect(result.current.edges).toEqual([]);
    });

    it("drops dependency edge to archived task while keeping dependent node", () => {
      const filteredTasks = [createTask("A", "triage", ["ARCH-1"])];
      const { result } = renderHook(() => useGraphData(filteredTasks));

      expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A"]);
      expect(result.current.edges).toEqual([]);
    });

    it("keeps only included dependency edges when mixed dependencies are present", () => {
      const filteredTasks = [createTask("A", "in-progress", ["B", "DONE-1", "ARCH-1"]), createTask("B", "todo")];
      const { result } = renderHook(() => useGraphData(filteredTasks));

      expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A", "B"]);
      expect(result.current.edges).toEqual([{ source: "A", target: "B" }]);
    });

    it("shows zero edges when all dependencies are excluded", () => {
      const filteredTasks = [createTask("A", "in-progress", ["DONE-1", "ARCH-1"])];
      const { result } = renderHook(() => useGraphData(filteredTasks));

      expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A"]);
      expect(result.current.edges).toEqual([]);
    });
  });

  describe("in-review dependency edges", () => {
    it("renders edges between in-review tasks", () => {
      const tasks = [createTask("A", "in-review", ["B"]), createTask("B", "in-review")];
      const { result } = renderHook(() => useGraphData(tasks));

      expect(result.current.edges).toEqual([{ source: "A", target: "B" }]);
    });

    it("renders edge from in-review task to in-progress task", () => {
      const tasks = [createTask("A", "in-review", ["B"]), createTask("B", "in-progress")];
      const { result } = renderHook(() => useGraphData(tasks));

      expect(result.current.edges).toEqual([{ source: "A", target: "B" }]);
    });

    it("renders edge from in-progress task to in-review task", () => {
      const tasks = [createTask("A", "in-progress", ["B"]), createTask("B", "in-review")];
      const { result } = renderHook(() => useGraphData(tasks));

      expect(result.current.edges).toEqual([{ source: "A", target: "B" }]);
    });
  });
});
