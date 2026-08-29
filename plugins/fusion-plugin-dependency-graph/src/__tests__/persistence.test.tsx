import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";
import { loadPositions, savePositions } from "../utils/graphPositionStorage";

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task }: { task: Task }) => <div>{task.id}</div>,
}));

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function createTask(id: string, column: Task["column"] = "todo"): Task {
  return { id, description: id, column, dependencies: [], steps: [], currentStep: 0, log: [] } as Task;
}

describe("dependency graph position persistence", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: createStorage(), configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("saves/restores project-scoped position shape", () => {
    savePositions({ A: { x: 10, y: 20 }, B: { x: 30, y: 40 } }, new Set(["A", "B"]), "p1");

    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toBe(
      JSON.stringify({ A: { x: 10, y: 20 }, B: { x: 30, y: 40 } }),
    );
    expect(loadPositions("p1")).toEqual({ A: { x: 10, y: 20 }, B: { x: 30, y: 40 } });
  });

  it("keeps positions isolated across projects", () => {
    savePositions({ A: { x: 1, y: 2 } }, new Set(["A"]), "p1");
    savePositions({ A: { x: 99, y: 88 } }, new Set(["A"]), "p2");

    expect(loadPositions("p1")).toEqual({ A: { x: 1, y: 2 } });
    expect(loadPositions("p2")).toEqual({ A: { x: 99, y: 88 } });
  });

  it("falls back to auto-layout with corrupt storage and does not crash", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", "{broken");

    render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);
    expect(screen.getByTestId("graph-task-node-A")).toBeTruthy();
  });

  it("drag persistence only writes localStorage and performs no network writes", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);
    const node = screen.getByTestId("graph-task-node-A");
    fireEvent.click(node);
    fireEvent.pointerDown(node, { pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(node, { pointerId: 1, isPrimary: true, clientX: 30, clientY: 40 });
    fireEvent.pointerUp(node, { pointerId: 1, isPrimary: true, clientX: 30, clientY: 40 });

    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toContain('"A"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clearing localStorage causes fresh auto-layout on remount", () => {
    const { unmount } = render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);
    const node = screen.getByTestId("graph-task-node-A");
    fireEvent.click(node);
    fireEvent.pointerDown(node, { pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(node, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 50 });
    fireEvent.pointerUp(node, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 50 });

    window.localStorage.removeItem("kb:p1:fusion-plugin-dependency-graph:positions");
    unmount();

    render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);
    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toBeNull();
    expect(screen.getByTestId("graph-task-node-A")).toBeTruthy();
  });
});
