import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";

const fitToGraph = vi.fn();

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail }: { task: Task; onOpenDetail: (task: Task) => void }) => (
    <button data-testid={`task-${task.id}`} onClick={() => onOpenDetail(task)}>{task.id}</button>
  ),
}));

vi.mock("../useGraphInteraction", () => ({
  useGraphInteraction: () => ({
    transform: "translate(0px, 0px) scale(1)",
    zoom: 1,
    transitioning: false,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetView: vi.fn(),
    fitToGraph,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onWheelZoom: vi.fn(),
    handleKeyDown: vi.fn(),
    setGraphBounds: vi.fn(),
  }),
}));

vi.mock("../layout", () => ({
  computeAutoLayout: ({ nodes }: { nodes: Array<{ task: { id: string } }> }) => {
    const map = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      if (node.task.id === "A") map.set("A", { x: 0, y: 0 });
      if (node.task.id === "B") map.set("B", { x: 200, y: 0 });
    }
    return map;
  },
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

describe("DependencyGraph persistence", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: createStorage(), configurable: true });
    fitToGraph.mockReset();
  });

  it("persists dragged node position across remount", () => {
    const { unmount } = render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);

    const node = screen.getByTestId("graph-task-node-A");
    fireEvent.click(node);
    fireEvent.pointerDown(node, { pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(node, { pointerId: 1, isPrimary: true, clientX: 30, clientY: 40 });
    fireEvent.pointerUp(node, { pointerId: 1, isPrimary: true, clientX: 30, clientY: 40 });

    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toContain('"A":{"x":20,"y":30}');

    unmount();
    render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);

    expect(screen.getByTestId("graph-task-node-A").getAttribute("style")).toContain("left: 0px");
    expect(screen.getByTestId("graph-task-node-A").getAttribute("style")).toContain("top: 0px");
  });

  it("merges saved positions with auto-layout for new tasks", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", JSON.stringify({ A: { x: 25, y: 35 } }));

    render(<DependencyGraph tasks={[createTask("A"), createTask("B")]} projectId="p1" />);

    expect(screen.getByTestId("graph-task-node-A").getAttribute("style")).toContain("left: 0px");
    expect(screen.getByTestId("graph-task-node-B").getAttribute("style")).toContain("left: 175px");
  });

  it("fit to graph clears saved positions and reapplies auto-layout", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", JSON.stringify({ A: { x: 25, y: 35 } }));

    render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Fit to graph" }));

    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toBeNull();
    expect(screen.getByTestId("graph-task-node-A").getAttribute("style")).toContain("left: 0px");
  });

  it("switching projects loads project-scoped positions", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", JSON.stringify({ A: { x: 11, y: 22 } }));
    window.localStorage.setItem("kb:p2:fusion-plugin-dependency-graph:positions", JSON.stringify({ A: { x: 33, y: 44 } }));

    const { rerender } = render(<DependencyGraph tasks={[createTask("A")]} projectId="p1" />);
    expect(screen.getByTestId("graph-task-node-A").getAttribute("style")).toContain("left: 0px");

    rerender(<DependencyGraph tasks={[createTask("A")]} projectId="p2" />);
    expect(screen.getByTestId("graph-task-node-A").getAttribute("style")).toContain("left: 0px");
  });
});
