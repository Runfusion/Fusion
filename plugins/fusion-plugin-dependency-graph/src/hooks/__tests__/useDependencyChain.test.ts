import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { useDependencyChain } from "../useDependencyChain";

function createTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    description: id,
    column: "todo",
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

describe("useDependencyChain", () => {
  it("returns empty set for unknown task in empty list", () => {
    const { result } = renderHook(() => useDependencyChain([]));
    expect(result.current.getChain("A").size).toBe(0);
  });

  it("returns single task when no dependencies", () => {
    const { result } = renderHook(() => useDependencyChain([createTask("A")]));
    expect(result.current.getChain("A")).toEqual(new Set(["A"]));
  });

  it("returns full linear chain", () => {
    const tasks = [createTask("A"), createTask("B", ["A"]), createTask("C", ["B"]), createTask("D")];
    const { result } = renderHook(() => useDependencyChain(tasks));
    expect(result.current.getChain("C")).toEqual(new Set(["A", "B", "C"]));
  });

  it("returns full diamond chain", () => {
    const tasks = [createTask("A"), createTask("B", ["A"]), createTask("C", ["A"]), createTask("D", ["B", "C"]), createTask("E")];
    const { result } = renderHook(() => useDependencyChain(tasks));
    expect(result.current.getChain("D")).toEqual(new Set(["A", "B", "C", "D"]));
  });

  it("does not include disconnected tasks", () => {
    const { result } = renderHook(() => useDependencyChain([createTask("A"), createTask("B")]));
    expect(result.current.getChain("A")).toEqual(new Set(["A"]));
  });

  it("handles circular dependencies safely", () => {
    const tasks = [createTask("A", ["B"]), createTask("B", ["A"]), createTask("C")];
    const { result } = renderHook(() => useDependencyChain(tasks));
    expect(result.current.getChain("A")).toEqual(new Set(["A", "B"]));
  });
});
